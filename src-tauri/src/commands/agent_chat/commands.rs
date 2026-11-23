use super::attachments;
use super::attachments::AttachmentOwnerScope;
use super::identity::folder_instance_identity;
use super::protocol::{
    attachment_user_item, build_turn_input, rpc_result, validate_request_response,
};
use super::provider;
use super::runtime::request;
use super::service::{AgentChatService, AgentChatStorageStatus};
use super::types::{
    mark_unfinished_turns_interrupted, ChatAttachment, ChatDraft, ChatItem, ChatModel,
    ChatSettings, ChatThread, SavedChatDraft, SavedChatDraftPage, MAX_ATTACHMENT_BYTES,
    MAX_ITEM_TEXT_BYTES,
};
use super::StoredProject;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::validate_project_path;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tracing::instrument;
use uuid::Uuid;

const MAX_ATTACHMENTS_PER_MESSAGE: usize = 16;
const MAX_DRAFT_PAGE_SIZE: u32 = 50;
const MAX_DRAFT_PAGE_OFFSET: u32 = 100_000;
const CHECKOUT_IDENTITY_MARKER: &str = "shipstudio-agent-chat-checkout-id";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatProjectMode {
    pub is_git_repository: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatProjectSnapshot {
    pub project_id: String,
    pub threads: Vec<ChatThread>,
}

#[tauri::command]
#[instrument(name = "agent_chat_list", skip(service, project_path))]
pub async fn agent_chat_list(
    service: State<'_, AgentChatService>,
    project_path: String,
) -> Result<AgentChatProjectSnapshot, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let available_checkouts = list_checkouts(&project, &project_id).await?;
    service.refresh_checkout_statuses(&project_id, &available_checkouts)?;
    Ok(AgentChatProjectSnapshot {
        project_id: project_id.clone(),
        threads: service.list_threads(&project_id)?,
    })
}

#[tauri::command]
#[instrument(name = "agent_chat_project_mode", skip(service, project_path))]
pub async fn agent_chat_project_mode(
    service: State<'_, AgentChatService>,
    project_path: String,
) -> Result<AgentChatProjectMode, CommandError> {
    let project = validate_project(&project_path)?;
    project_identity(&service, &project).await?;
    Ok(AgentChatProjectMode {
        is_git_repository: git_common_dir(&project).await?.is_some(),
    })
}

#[tauri::command]
#[instrument(
    name = "agent_chat_list_drafts",
    skip(service, project_path, checkout_path)
)]
pub async fn agent_chat_list_drafts(
    service: State<'_, AgentChatService>,
    project_path: String,
    expected_project_id: String,
    checkout_path: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<SavedChatDraftPage, CommandError> {
    let limit = limit.unwrap_or(MAX_DRAFT_PAGE_SIZE);
    let offset = offset.unwrap_or(0);
    if limit == 0 || limit > MAX_DRAFT_PAGE_SIZE {
        return Err(CommandError::Validation {
            field: "limit".into(),
            reason: format!("Draft pages must contain between 1 and {MAX_DRAFT_PAGE_SIZE} records"),
        });
    }
    if offset > MAX_DRAFT_PAGE_OFFSET {
        return Err(CommandError::Validation {
            field: "offset".into(),
            reason: "The draft page offset is out of range".into(),
        });
    }
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    require_expected_project_identity(&expected_project_id, &project_id)?;
    let checkout = validate_checkout(&project, &checkout_path, &project_id).await?;
    let identity = checkout_identity(&checkout, Some(&project_id)).await?;
    service.list_saved_drafts(&project_id, &identity, limit, offset)
}

#[tauri::command]
#[instrument(
    name = "agent_chat_save_project_draft",
    skip(service, app, project_path, checkout_path, draft, settings)
)]
pub async fn agent_chat_save_project_draft(
    service: State<'_, AgentChatService>,
    app: AppHandle,
    project_path: String,
    expected_project_id: String,
    checkout_path: String,
    draft_id: String,
    draft: ChatDraft,
    settings: ChatSettings,
) -> Result<SavedChatDraft, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    require_expected_project_identity(&expected_project_id, &project_id)?;
    let checkout = validate_checkout(&project, &checkout_path, &project_id).await?;
    let identity = checkout_identity(&checkout, Some(&project_id)).await?;
    validate_draft_id(&draft_id)?;

    let lock = service.draft_promotion_lock(&draft_id)?;
    let _guard = lock.lock().await;
    let path = checkout.to_string_lossy().into_owned();
    if let Some(existing) = service.get_saved_draft(&project_id, &draft_id)? {
        validate_saved_draft_identity(&existing, &path, &identity)?;
        match existing.state.as_str() {
            "promoted" => {
                let thread_id = existing.promoted_thread_id.as_deref().ok_or_else(|| {
                    CommandError::expected("This promoted draft has no bound chat thread")
                })?;
                let thread = thread_for_project(&service, &project_id, thread_id)?;
                if thread.checkout_identity != identity {
                    return Err(CommandError::Validation {
                        field: "checkoutPath".into(),
                        reason: "This draft belongs to a different Git checkout".into(),
                    });
                }
                validate_project_draft(
                    &app,
                    &project_id,
                    AttachmentOwnerScope::Thread {
                        thread_id: &thread.id,
                        source_draft_id: Some(&draft_id),
                    },
                    &draft,
                    &settings,
                )?;
                let updated = service.update_thread(&thread.id, true, |thread| {
                    thread.draft = draft.clone();
                    thread.settings = settings.clone();
                });
                let thread = updated_thread(
                    &service,
                    &thread.id,
                    updated,
                    "The promoted chat draft could not be saved",
                )?;
                Ok(SavedChatDraft {
                    draft_id,
                    project_id,
                    checkout_path: path,
                    checkout_identity: identity,
                    checkout_status: "available".into(),
                    draft: thread.draft,
                    settings: thread.settings,
                    saved_at: chrono::Utc::now().timestamp_millis(),
                    state: "promoted".into(),
                    promoted_thread_id: Some(thread.id),
                })
            }
            "draft" => {
                validate_project_draft(
                    &app,
                    &project_id,
                    AttachmentOwnerScope::SavedDraft(&draft_id),
                    &draft,
                    &settings,
                )?;
                service.save_project_draft(&SavedChatDraft {
                    draft_id,
                    project_id,
                    checkout_path: path,
                    checkout_identity: identity,
                    checkout_status: "available".into(),
                    draft,
                    settings,
                    saved_at: 0,
                    state: "draft".into(),
                    promoted_thread_id: None,
                })
            }
            _ => Err(CommandError::expected("This saved draft was discarded")),
        }
    } else {
        validate_project_draft(
            &app,
            &project_id,
            AttachmentOwnerScope::SavedDraft(&draft_id),
            &draft,
            &settings,
        )?;
        service.save_project_draft(&SavedChatDraft {
            draft_id,
            project_id,
            checkout_path: path,
            checkout_identity: identity,
            checkout_status: "available".into(),
            draft,
            settings,
            saved_at: 0,
            state: "draft".into(),
            promoted_thread_id: None,
        })
    }
}

#[tauri::command]
#[instrument(name = "agent_chat_delete_project_draft", skip(service, project_path))]
pub async fn agent_chat_delete_project_draft(
    service: State<'_, AgentChatService>,
    project_path: String,
    expected_project_id: String,
    draft_id: String,
) -> Result<(), CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    require_expected_project_identity(&expected_project_id, &project_id)?;
    validate_draft_id(&draft_id)?;
    let lock = service.draft_promotion_lock(&draft_id)?;
    let _guard = lock.lock().await;
    service.delete_project_draft(&project_id, &draft_id)
}

#[tauri::command]
#[instrument(
    name = "agent_chat_promote_draft",
    skip(service, project_path, checkout_path),
    fields(provider = %provider_id)
)]
pub async fn agent_chat_promote_draft(
    service: State<'_, AgentChatService>,
    project_path: String,
    expected_project_id: String,
    checkout_path: String,
    draft_id: String,
    provider_id: String,
) -> Result<ChatThread, CommandError> {
    if provider_id != "codex" {
        return Err(CommandError::Validation {
            field: "providerId".into(),
            reason: "Only the Codex provider is available in this chat version".into(),
        });
    }
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    require_expected_project_identity(&expected_project_id, &project_id)?;
    let checkout = validate_checkout(&project, &checkout_path, &project_id).await?;
    let identity = checkout_identity(&checkout, Some(&project_id)).await?;
    validate_draft_id(&draft_id)?;

    let lock = service.draft_promotion_lock(&draft_id)?;
    let _guard = lock.lock().await;
    let saved = service
        .get_saved_draft(&project_id, &draft_id)?
        .ok_or_else(|| CommandError::expected("Save this draft before sending"))?;
    validate_saved_draft_identity(&saved, &checkout.to_string_lossy(), &identity)?;
    if saved.state == "promoted" {
        let thread_id = saved.promoted_thread_id.ok_or_else(|| {
            CommandError::expected("This promoted draft has no bound chat thread")
        })?;
        return thread_for_project(&service, &project_id, &thread_id);
    }
    if saved.state != "draft" {
        return Err(CommandError::expected("This saved draft was discarded"));
    }

    let thread_id = Uuid::new_v4().to_string();
    let thread = ChatThread {
        id: thread_id.clone(),
        project_id,
        project_path: project.to_string_lossy().into_owned(),
        checkout_path: checkout.to_string_lossy().into_owned(),
        checkout_identity: identity,
        checkout_status: "available".into(),
        provider_id,
        provider_thread_id: None,
        resume_status: "unknown".into(),
        provider_status: "unknown".into(),
        title: "New chat".into(),
        title_source: "draft".into(),
        status: "starting".into(),
        turn_id: None,
        approval_policy: None,
        sandbox_policy: None,
        turns: Vec::new(),
        items: Vec::new(),
        requests: Vec::new(),
        draft: saved.draft,
        settings: saved.settings,
        disposition: "active".into(),
        activity_cursor: 0,
        settled_cursor: None,
        read_cursor: 0,
        unread: false,
        latest_activity_at: Some(chrono::Utc::now().timestamp_millis()),
        error: None,
        revision: 0,
    };
    let (thread, created) = service.promote_project_draft(thread, &draft_id)?;
    if !created {
        return Ok(thread);
    }

    match provider::start_thread_runtime(&service, &thread.id, &project, &checkout, None).await {
        Ok((_runtime, Some(provider_thread_id))) => {
            service.update_thread(&thread.id, true, |thread| {
                thread.provider_thread_id = Some(provider_thread_id);
                thread.status = "idle".into();
                thread.resume_status = "available".into();
                thread.provider_status = "idle".into();
                thread.error = None;
            });
        }
        Ok((_runtime, None)) => mark_thread_error(
            &service,
            &thread.id,
            "Codex did not create a new conversation".into(),
        ),
        Err(error) => mark_thread_error(&service, &thread.id, error.to_string()),
    }
    service.ensure_storage()?;
    service
        .thread(&thread.id)
        .ok_or_else(|| CommandError::expected("The promoted chat thread is unavailable"))
}

#[tauri::command]
#[instrument(name = "agent_chat_create", skip(service, project_path, checkout_path), fields(provider = %provider_id))]
pub async fn agent_chat_create(
    service: State<'_, AgentChatService>,
    project_path: String,
    expected_project_id: String,
    checkout_path: String,
    provider_id: String,
) -> Result<ChatThread, CommandError> {
    if provider_id != "codex" {
        return Err(CommandError::Validation {
            field: "providerId".into(),
            reason: "Only the Codex provider is available in this chat version".into(),
        });
    }
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    require_expected_project_identity(&expected_project_id, &project_id)?;
    let checkout = validate_checkout(&project, &checkout_path, &project_id).await?;
    let checkout_identity = checkout_identity(&checkout, Some(&project_id)).await?;
    let id = Uuid::new_v4().to_string();
    let thread = ChatThread {
        id: id.clone(),
        project_id,
        project_path: project.to_string_lossy().into_owned(),
        checkout_path: checkout.to_string_lossy().into_owned(),
        checkout_identity,
        checkout_status: "available".into(),
        provider_id,
        provider_thread_id: None,
        resume_status: "unknown".into(),
        provider_status: "unknown".into(),
        title: "New chat".into(),
        title_source: "draft".into(),
        status: "starting".into(),
        turn_id: None,
        approval_policy: None,
        sandbox_policy: None,
        turns: Vec::new(),
        items: Vec::new(),
        requests: Vec::new(),
        draft: ChatDraft::default(),
        settings: ChatSettings::default(),
        disposition: "active".into(),
        activity_cursor: 0,
        settled_cursor: None,
        read_cursor: 0,
        unread: false,
        latest_activity_at: Some(chrono::Utc::now().timestamp_millis()),
        error: None,
        revision: 0,
    };
    service.insert_thread(thread)?;

    match provider::start_thread_runtime(&service, &id, &project, &checkout, None).await {
        Ok((_runtime, Some(provider_thread_id))) => {
            service.update_thread(&id, true, |thread| {
                thread.provider_thread_id = Some(provider_thread_id);
                thread.status = "idle".into();
                thread.resume_status = "available".into();
                thread.provider_status = "idle".into();
                thread.error = None;
            });
        }
        Ok((_runtime, None)) => mark_thread_error(
            &service,
            &id,
            "Codex did not create a new conversation".into(),
        ),
        Err(error) => mark_thread_error(&service, &id, error.to_string()),
    }
    service.ensure_storage()?;
    service
        .thread(&id)
        .ok_or_else(|| CommandError::expected("The chat thread could not be created"))
}

#[tauri::command]
#[instrument(name = "agent_chat_models", skip(service, project_path))]
pub async fn agent_chat_models(
    service: State<'_, AgentChatService>,
    project_path: String,
) -> Result<Vec<ChatModel>, CommandError> {
    let project = validate_project(&project_path)?;
    provider::discover_models(&service, &project).await
}

#[tauri::command]
#[instrument(name = "agent_chat_send", skip(service, app, project_path, text, attachments, model, effort, send_attempt_id), fields(auto_accept = auto_accept_mode))]
pub async fn agent_chat_send(
    service: State<'_, AgentChatService>,
    app: AppHandle,
    project_path: String,
    expected_project_id: String,
    thread_id: String,
    text: String,
    attachments: Vec<ChatAttachment>,
    model: Option<String>,
    effort: Option<String>,
    auto_accept_mode: bool,
    send_attempt_id: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    require_expected_project_identity(&expected_project_id, &project_id)?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    if text.trim().is_empty() && attachments.is_empty() {
        return Err(CommandError::Validation {
            field: "text".into(),
            reason: "Enter a message or attach a file".into(),
        });
    }
    if text.len() > MAX_ITEM_TEXT_BYTES {
        return Err(CommandError::Validation {
            field: "text".into(),
            reason: "Messages must be no longer than 64 KB".into(),
        });
    }
    if send_attempt_id.trim().is_empty() || send_attempt_id.len() > 128 {
        return Err(CommandError::Validation {
            field: "sendAttemptId".into(),
            reason: "The send attempt identifier is invalid".into(),
        });
    }
    if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(CommandError::Validation {
            field: "attachments".into(),
            reason: format!(
                "A message can include up to {MAX_ATTACHMENTS_PER_MESSAGE} attachments"
            ),
        });
    }
    if attachments.iter().fold(0u64, |total, attachment| {
        total.saturating_add(attachment.size)
    }) > MAX_ATTACHMENT_BYTES * 4
    {
        return Err(CommandError::Validation {
            field: "attachments".into(),
            reason: "Attachments in one message must total no more than 100 MB".into(),
        });
    }
    attachments::validate_staged(
        &app,
        &project_id,
        AttachmentOwnerScope::Thread {
            thread_id: &thread_id,
            source_draft_id: None,
        },
        &attachments,
    )?;
    provider::validate_image_attachments(&service, &project, model.as_deref(), &attachments)
        .await?;
    let provider_thread_id = thread.provider_thread_id.as_deref().ok_or_else(|| {
        CommandError::expected(
            "This chat could not start with Codex. Create a new chat to continue.",
        )
    })?;
    if !matches!(thread.status.as_str(), "idle" | "interrupted" | "error") {
        return Err(CommandError::expected(
            "This chat already has an active turn",
        ));
    }
    if matches!(
        thread.provider_status.as_str(),
        "active" | "systemError" | "notLoaded"
    ) {
        return Err(CommandError::expected(
            "Codex has not confirmed that this saved conversation is idle. Check its history before sending another message.",
        ));
    }

    let checkout = match validate_thread_checkout(&service, &project, &thread).await {
        Ok(checkout) => checkout,
        Err(_) => {
            service.update_thread(&thread_id, true, |thread| {
                mark_unfinished_turns_interrupted(thread, chrono::Utc::now().timestamp_millis());
                thread.status = "interrupted".into();
                thread.checkout_status = "missing".into();
                thread.turn_id = None;
                thread.error = Some(
                    "This checkout is no longer available as a Git worktree. Create a chat in an available checkout to continue.".into(),
                );
            });
            service.ensure_storage()?;
            return Err(CommandError::expected(
                "This checkout is no longer available as a Git worktree. The chat kept its original checkout path.",
            ));
        }
    };
    if thread.resume_status != "available" || thread.provider_status == "unknown" {
        let checked_history =
            provider::read_thread_history(&service, &project, &checkout, provider_thread_id).await;
        match checked_history {
            Ok(history) => {
                let provider_status = history.status;
                let reconciliation =
                    service.reconcile_send_attempt(&thread_id, &history.items, &provider_status);
                if reconciliation.as_ref().is_some_and(|result| {
                    matches!(
                        result.outcome.as_str(),
                        "confirmedPresent" | "confirmedAbsent"
                    )
                }) {
                    service.clear_uncertain_turn(&thread_id);
                }
                service.update_thread(&thread_id, true, |thread| {
                    if history.approval_policy.is_some() {
                        thread.approval_policy = history.approval_policy.clone();
                    }
                    if history.sandbox_policy.is_some() {
                        thread.sandbox_policy = history.sandbox_policy.clone();
                    }
                });
                if service
                    .reconcile_provider_history(&thread_id, history.items, reconciliation.as_ref())
                    .is_none()
                {
                    service.ensure_storage()?;
                    return Err(CommandError::expected(
                        "Codex history could not be reconciled with the saved chat",
                    ));
                }
                service.ensure_storage()?;
                service.update_thread(&thread_id, true, |thread| {
                    thread.resume_status = if matches!(
                        provider_status.as_str(),
                        "idle" | "active" | "systemError"
                    ) {
                        "available".into()
                    } else {
                        "unavailable".into()
                    };
                    thread.provider_status = provider_status.clone();
                    if provider_status == "active" {
                        mark_unfinished_turns_interrupted(
                            thread,
                            chrono::Utc::now().timestamp_millis(),
                        );
                        thread.status = "interrupted".into();
                        thread.turn_id = None;
                        thread.error = Some(
                            "Codex still reports an active saved turn. Check again after that turn finishes.".into(),
                        );
                    } else if provider_status == "systemError" {
                        thread.error = Some(
                            "Codex reports a system error for this saved conversation. Local history remains available.".into(),
                        );
                    } else if !matches!(provider_status.as_str(), "idle" | "active") {
                        thread.error = Some(
                            "Codex did not confirm a loaded, idle conversation. Local history remains available.".into(),
                        );
                    } else {
                        thread.error = None;
                    }
                });
                if provider_status == "active" {
                    service.ensure_storage()?;
                    return Err(CommandError::expected(
                        "Codex still reports an active saved turn. The prompt was not sent; check again after that turn finishes.",
                    ));
                }
                if provider_status != "idle" {
                    service.ensure_storage()?;
                    return Err(CommandError::expected(
                        "Codex did not confirm an idle saved conversation. The prompt was not sent; local history remains available.",
                    ));
                }
            }
            Err(error) => {
                let detail = super::types::truncate_utf8(&error.to_string(), 240);
                service.update_thread(&thread_id, true, |thread| {
                    thread.resume_status = "unavailable".into();
                    thread.provider_status = "unknown".into();
                    thread.error = Some(format!("Codex could not confirm this saved conversation. The prompt was not sent: {detail}"));
                });
                service.ensure_storage()?;
                return Err(CommandError::expected(
                    "Codex could not confirm this saved conversation. The prompt was not sent.",
                ));
            }
        }
        service.ensure_storage()?;
    }

    let runtime = provider::resume_thread_runtime(
        &service,
        &thread_id,
        &project,
        &checkout,
        provider_thread_id,
    )
    .await?;
    let baseline = provider::capture_send_baseline(
        &service,
        &thread_id,
        &runtime,
        &checkout,
        provider_thread_id,
    )
    .await?;
    if baseline.status != "idle" {
        service.update_thread(&thread_id, true, |thread| {
            thread.provider_status = baseline.status.clone();
            thread.resume_status = if matches!(
                baseline.status.as_str(),
                "idle" | "active" | "systemError"
            ) {
                "available".into()
            } else {
                "unavailable".into()
            };
            thread.error = Some(if baseline.status == "active" {
                "Codex still reports an active saved turn. The prompt was not sent; check again after that turn finishes.".into()
            } else {
                "Codex did not confirm an idle saved conversation. The prompt was not sent.".into()
            });
        });
        service.ensure_storage()?;
        return Err(CommandError::expected(
            "Codex did not confirm an idle saved conversation. The prompt was not sent.",
        ));
    }
    let baseline_reconciliation =
        service.reconcile_send_attempt(&thread_id, &baseline.items, &baseline.status);
    if baseline_reconciliation.as_ref().is_some_and(|result| {
        matches!(
            result.outcome.as_str(),
            "confirmedPresent" | "confirmedAbsent"
        )
    }) {
        service.clear_uncertain_turn(&thread_id);
    }
    if service
        .reconcile_provider_history(
            &thread_id,
            baseline.items.clone(),
            baseline_reconciliation.as_ref(),
        )
        .is_none()
    {
        service.ensure_storage()?;
        return Err(CommandError::expected(
            "Codex history could not be reconciled with the saved chat",
        ));
    }
    service.update_thread(&thread_id, true, |thread| {
        if baseline.approval_policy.is_some() {
            thread.approval_policy = baseline.approval_policy.clone();
        }
        if baseline.sandbox_policy.is_some() {
            thread.sandbox_policy = baseline.sandbox_policy.clone();
        }
        thread.provider_status = "idle".into();
        thread.resume_status = "available".into();
        if thread.status == "interrupted" || thread.status == "error" {
            thread.status = "idle".into();
            thread.error = None;
        }
    });

    service.ensure_send_attempt_is_safe(&thread_id, &text, &attachments)?;

    let user_item = attachment_user_item(
        Uuid::new_v4().to_string(),
        text.clone(),
        attachments.clone(),
    );
    let settings = ChatSettings {
        model_id: model.clone(),
        reasoning_effort: effort.clone(),
        auto_accept_mode,
    };
    let baseline_last_item_id = baseline.items.last().map(|item| item.id.clone());
    if service
        .claim_turn(
            &thread_id,
            send_attempt_id.clone(),
            user_item,
            settings,
            baseline_last_item_id,
        )
        .is_none()
    {
        service.ensure_storage()?;
        return Err(CommandError::expected(
            "This chat already has an active turn",
        ));
    }
    service.update_turn_attempt(&thread_id, &send_attempt_id, |turn| {
        turn.outcome = "sending".into();
    });

    let mut params = json!({
        "threadId": provider_thread_id,
        "cwd": checkout.to_string_lossy(),
        "clientUserMessageId": send_attempt_id.clone(),
        "input": build_turn_input(&text, &attachments)
    });
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = effort.filter(|effort| !effort.trim().is_empty()) {
        params["effort"] = Value::String(effort);
    }

    let turn_start = request(&service, &thread_id, &runtime, "turn/start", params).await;
    match turn_start {
        Ok(result) => {
            let provider_turn_id = result
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            service.update_turn_attempt(&thread_id, &send_attempt_id, |turn| {
                if matches!(turn.outcome.as_str(), "claimed" | "sending") {
                    turn.provider_turn_id = provider_turn_id.clone();
                    turn.outcome = "running".into();
                }
            });
            service.update_thread(&thread_id, true, |thread| {
                if thread.status == "starting" {
                    thread.status = "running".into();
                    thread.turn_id = provider_turn_id;
                    thread.provider_status = "active".into();
                    thread.error = None;
                }
            });
            service.ensure_storage()?;
            service
                .thread(&thread_id)
                .ok_or_else(|| CommandError::expected("The chat thread is unavailable"))
        }
        Err(error) => {
            let known_rejection = error.starts_with("Codex returned a protocol error");
            let observed = if known_rejection {
                false
            } else {
                !service.mark_uncertain_turn(&thread_id)
            };
            if observed {
                return service
                    .thread(&thread_id)
                    .ok_or_else(|| CommandError::expected("The chat thread is unavailable"));
            }
            let message = if known_rejection {
                error
            } else {
                "Codex did not acknowledge whether this turn started. It will not be retried automatically; interrupt this chat or start a new one.".to_string()
            };
            let finished_at = chrono::Utc::now().timestamp_millis();
            service.update_turn_attempt(&thread_id, &send_attempt_id, |turn| {
                if known_rejection {
                    turn.outcome = "failed".into();
                    turn.finished_at = Some(finished_at);
                } else if !observed {
                    turn.outcome = "uncertain".into();
                }
            });
            if !observed {
                service.update_thread(&thread_id, true, |thread| {
                    thread.status = if known_rejection {
                        "error".into()
                    } else {
                        "interrupted".into()
                    };
                    thread.turn_id = None;
                    thread.resume_status = if known_rejection {
                        "available".into()
                    } else {
                        "unknown".into()
                    };
                    thread.provider_status = if known_rejection {
                        "idle".into()
                    } else {
                        "unknown".into()
                    };
                    thread.error = Some(message.clone());
                });
            }
            append_error(&service, &thread_id, message.clone());
            service.ensure_storage()?;
            Err(CommandError::expected(message))
        }
    }
}

#[tauri::command]
#[instrument(name = "agent_chat_interrupt", skip(service, project_path))]
pub async fn agent_chat_interrupt(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    if service.is_uncertain_turn(&thread_id) {
        if let Some(runtime) = service.remove_runtime(&thread_id) {
            runtime
                .stop("Codex was stopped because the turn start was uncertain".into())
                .await;
        }
        service.clear_uncertain_turn(&thread_id);
        service.clear_pending_requests(&thread_id);
        let updated = service.update_thread(&thread_id, true, |thread| {
                mark_unfinished_turns_interrupted(thread, chrono::Utc::now().timestamp_millis());
                thread.status = "interrupted".into();
                thread.turn_id = None;
                thread.requests.clear();
                let message = "Codex did not acknowledge whether the turn started. Its process was stopped and the turn was not retried; review the conversation before sending another message.".to_string();
                thread.error = Some(message.clone());
                thread.items.push(ChatItem {
                    id: format!("uncertain-interrupt:{}", Uuid::new_v4()),
                    turn_id: None,
                    kind: "activity".into(),
                    text: message,
                    status: Some("interrupted".into()),
                    attachments: Vec::new(),
                });
            });
        return updated_thread(
            &service,
            &thread_id,
            updated,
            "The chat thread is unavailable",
        );
    }
    if !matches!(thread.status.as_str(), "running" | "waiting" | "starting") {
        return Ok(thread);
    }
    let provider_thread_id = thread
        .provider_thread_id
        .as_deref()
        .ok_or_else(|| CommandError::expected("Codex has not started this conversation yet"))?;
    let turn_id = thread.turn_id.as_deref().ok_or_else(|| {
        CommandError::expected(
            "Codex has not identified the active turn yet; wait briefly and try again",
        )
    })?;
    let runtime = service
        .runtime(&thread_id)
        .ok_or_else(|| CommandError::expected("The Codex process is no longer available"))?;
    let result = request(
        &service,
        &thread_id,
        &runtime,
        "turn/interrupt",
        json!({ "threadId": provider_thread_id, "turnId": turn_id }),
    )
    .await;
    if let Err(error) = result {
        append_error_preserving_status(
            &service,
            &thread_id,
            "Codex could not confirm the interrupt request. The chat remains available to inspect."
                .into(),
        );
        service.ensure_storage()?;
        return Err(CommandError::expected(
            if error.starts_with("Codex returned a protocol error") {
                "Codex rejected the interrupt request"
            } else {
                "Codex did not confirm the interrupt request"
            },
        ));
    }
    service.ensure_storage()?;
    service
        .thread(&thread_id)
        .ok_or_else(|| CommandError::expected("The chat thread is unavailable"))
}

#[tauri::command]
#[instrument(name = "agent_chat_respond", skip(service, project_path, response))]
pub async fn agent_chat_respond(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
    request_id: String,
    response: Value,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    if !thread
        .requests
        .iter()
        .any(|request| request.id == request_id)
    {
        return Err(CommandError::expected(
            "This Codex request is no longer waiting for a response",
        ));
    }
    if serde_json::to_vec(&response).map_or(true, |data| data.len() > 64 * 1024) {
        return Err(CommandError::Validation {
            field: "response".into(),
            reason: "The response is too large".into(),
        });
    }
    let pending = service
        .pending_request(&thread_id, &request_id)
        .ok_or_else(|| {
            CommandError::expected("This Codex request is no longer waiting for a response")
        })?;
    validate_request_response(&pending, &response)?;
    let runtime = service
        .runtime(&thread_id)
        .ok_or_else(|| CommandError::expected("The Codex process is no longer available"))?;
    let pending = service
        .take_pending_request(&thread_id, &request_id, &runtime.generation)
        .ok_or_else(|| CommandError::expected("This Codex request has already been answered"))?;
    if runtime
        .outbound
        .send(rpc_result(pending.rpc_id, response))
        .await
        .is_err()
    {
        service.update_thread(&thread_id, true, |thread| {
            thread.requests.retain(|request| request.id != request_id);
            mark_unfinished_turns_interrupted(thread, chrono::Utc::now().timestamp_millis());
            thread.status = "interrupted".into();
            thread.turn_id = None;
            thread.provider_status = "unknown".into();
            let message = "Codex could not receive the response. This request was invalidated; check the conversation before continuing.";
            thread.error = Some(message.into());
            thread.items.push(ChatItem {
                id: format!("request-delivery-error:{}", Uuid::new_v4()),
                turn_id: None,
                kind: "error".into(),
                text: message.into(),
                status: Some("failed".into()),
                attachments: Vec::new(),
            });
        });
        service.ensure_storage()?;
        return Err(CommandError::expected(
            "Codex could not receive the response; check the conversation before continuing",
        ));
    }
    service.update_thread(&thread_id, true, |thread| {
        thread.requests.retain(|request| request.id != request_id);
        if thread.status == "waiting" && thread.requests.is_empty() {
            thread.status = "running".into();
        }
    });
    service.ensure_storage()?;
    service
        .thread(&thread_id)
        .ok_or_else(|| CommandError::expected("The chat thread is unavailable"))
}

#[tauri::command]
#[instrument(
    name = "agent_chat_save_draft",
    skip(service, app, project_path, draft)
)]
pub async fn agent_chat_save_draft(
    service: State<'_, AgentChatService>,
    app: AppHandle,
    project_path: String,
    thread_id: String,
    draft: ChatDraft,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    if draft.text.len() > MAX_ITEM_TEXT_BYTES {
        return Err(CommandError::Validation {
            field: "draft.text".into(),
            reason: "Drafts must be no longer than 64 KB".into(),
        });
    }
    if draft.attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(CommandError::Validation {
            field: "draft.attachments".into(),
            reason: format!("A draft can include up to {MAX_ATTACHMENTS_PER_MESSAGE} attachments"),
        });
    }
    if draft.attachments.iter().fold(0u64, |total, attachment| {
        total.saturating_add(attachment.size)
    }) > MAX_ATTACHMENT_BYTES * 4
    {
        return Err(CommandError::Validation {
            field: "draft.attachments".into(),
            reason: "Draft attachments must total no more than 100 MB".into(),
        });
    }
    attachments::validate_staged(
        &app,
        &project_id,
        AttachmentOwnerScope::Thread {
            thread_id: &thread_id,
            source_draft_id: None,
        },
        &draft.attachments,
    )?;
    let updated = service.update_thread(&thread.id, true, |thread| thread.draft = draft);
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat draft could not be saved",
    )
}

#[tauri::command]
#[instrument(
    name = "agent_chat_save_settings",
    skip(service, project_path, settings)
)]
pub async fn agent_chat_save_settings(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
    settings: ChatSettings,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    validate_settings(&settings)?;
    let updated = service.update_thread(&thread.id, true, |thread| thread.settings = settings);
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat settings could not be saved",
    )
}

#[tauri::command]
#[instrument(name = "agent_chat_rename", skip(service, project_path, title))]
pub async fn agent_chat_rename(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
    title: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() || title.chars().any(char::is_control) || title.chars().count() > 120 {
        return Err(CommandError::Validation {
            field: "title".into(),
            reason: "Enter a title of 1 to 120 characters without control characters".into(),
        });
    }
    let updated = service.update_thread(&thread.id, true, |thread| {
        thread.title = title;
        thread.title_source = "manual".into();
    });
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat title could not be saved",
    )
}

#[tauri::command]
#[instrument(name = "agent_chat_mark_read", skip(service, project_path))]
pub async fn agent_chat_mark_read(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    let updated = service.update_thread(&thread.id, true, |thread| {
        thread.read_cursor = thread.activity_cursor;
        thread.unread = false;
    });
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat read cursor could not be saved",
    )
}

#[tauri::command]
#[instrument(name = "agent_chat_settle", skip(service, project_path))]
pub async fn agent_chat_settle(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    if matches!(thread.status.as_str(), "starting" | "running" | "waiting") {
        return Err(CommandError::expected(
            "A chat cannot be settled while Codex is working or waiting for a response",
        ));
    }
    if thread.provider_status == "active" {
        return Err(CommandError::expected(
            "A chat cannot be settled while Codex reports an active turn",
        ));
    }
    let updated = service.update_thread(&thread.id, true, |thread| {
        thread.disposition = "settled".into();
        thread.settled_cursor = Some(thread.activity_cursor);
    });
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat disposition could not be saved",
    )
}

#[tauri::command]
#[instrument(name = "agent_chat_reopen", skip(service, project_path))]
pub async fn agent_chat_reopen(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    let updated = service.update_thread(&thread.id, true, |thread| {
        thread.disposition = "active".into();
        thread.settled_cursor = None;
        thread.read_cursor = thread.activity_cursor;
        thread.unread = false;
    });
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat could not be reopened",
    )
}

#[tauri::command]
#[instrument(name = "agent_chat_resume_check", skip(service, project_path))]
pub async fn agent_chat_resume_check(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    let Some(provider_thread_id) = thread.provider_thread_id.clone() else {
        service.update_thread(&thread_id, true, |thread| {
            thread.resume_status = "unavailable".into();
            thread.provider_status = "unknown".into();
            thread.error = Some("This saved chat has no provider conversation ID. Its local display history is still available.".into());
        });
        service.ensure_storage()?;
        return service
            .thread(&thread_id)
            .ok_or_else(|| CommandError::expected("The chat thread is unavailable"));
    };
    let checkout = match validate_thread_checkout(&service, &project, &thread).await {
        Ok(checkout) => checkout,
        Err(_) => {
            service.update_thread(&thread_id, true, |thread| {
                thread.checkout_status = "missing".into();
                thread.resume_status = "unavailable".into();
                thread.provider_status = "unknown".into();
                thread.error = Some("The original checkout is unavailable. Relink this chat to an existing worktree before continuing.".into());
            });
            service.ensure_storage()?;
            return service
                .thread(&thread_id)
                .ok_or_else(|| CommandError::expected("The chat thread is unavailable"));
        }
    };
    match provider::read_thread_history(&service, &project, &checkout, &provider_thread_id).await {
        Ok(history) => {
            let provider_status = history.status;
            let reconciliation =
                service.reconcile_send_attempt(&thread_id, &history.items, &provider_status);
            if reconciliation.as_ref().is_some_and(|result| {
                matches!(
                    result.outcome.as_str(),
                    "confirmedPresent" | "confirmedAbsent"
                )
            }) {
                service.clear_uncertain_turn(&thread_id);
            }
            service.update_thread(&thread_id, true, |thread| {
                if history.approval_policy.is_some() {
                    thread.approval_policy = history.approval_policy.clone();
                }
                if history.sandbox_policy.is_some() {
                    thread.sandbox_policy = history.sandbox_policy.clone();
                }
            });
            if service
                .reconcile_provider_history(&thread_id, history.items, reconciliation.as_ref())
                .is_none()
            {
                service.ensure_storage()?;
                return Err(CommandError::expected(
                    "Codex history could not be reconciled with the saved chat",
                ));
            }
            service.update_thread(&thread_id, true, |thread| {
                thread.checkout_status = "available".into();
                thread.resume_status = if matches!(
                    provider_status.as_str(),
                    "idle" | "active" | "systemError"
                ) {
                    "available".into()
                } else {
                    "unavailable".into()
                };
                thread.provider_status = provider_status.clone();
                if provider_status == "active" {
                    mark_unfinished_turns_interrupted(
                        thread,
                        chrono::Utc::now().timestamp_millis(),
                    );
                    thread.status = "interrupted".into();
                    thread.turn_id = None;
                    thread.error = Some(
                        "Codex still reports an active saved turn. Check again after that turn finishes.".into(),
                    );
                } else if provider_status == "systemError" {
                    thread.error = Some(
                        "Codex reports a system error for this saved conversation. Local history remains available.".into(),
                    );
                } else if provider_status != "idle" {
                    thread.error = Some(
                        "Codex did not confirm a loaded, idle conversation. Local history remains available.".into(),
                    );
                } else {
                    thread.error = None;
                }
            });
        }
        Err(error) => {
            let detail = super::types::truncate_utf8(&error.to_string(), 240);
            service.update_thread(&thread_id, true, |thread| {
                thread.checkout_status = "available".into();
                thread.resume_status = "unavailable".into();
                thread.provider_status = "unknown".into();
                thread.error = Some(format!("Saved local history is available, but Codex could not confirm this provider conversation: {detail}"));
            });
        }
    }
    service.ensure_storage()?;
    service
        .thread(&thread_id)
        .ok_or_else(|| CommandError::expected("The chat thread is unavailable"))
}

#[tauri::command]
#[instrument(
    name = "agent_chat_relink_checkout",
    skip(service, project_path, checkout_path)
)]
pub async fn agent_chat_relink_checkout(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
    checkout_path: String,
) -> Result<ChatThread, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let thread = thread_for_project(&service, &project_id, &thread_id)?;
    if matches!(thread.status.as_str(), "starting" | "running" | "waiting")
        || thread.provider_status == "active"
    {
        return Err(CommandError::expected(
            "A checkout cannot be relinked while Codex is working or reports an active turn",
        ));
    }
    let checkout = validate_checkout(&project, &checkout_path, &project_id).await?;
    let checkout_identity = checkout_identity(&checkout, Some(&project_id)).await?;
    if let Some(runtime) = service.remove_runtime(&thread_id) {
        runtime.stop("The chat checkout was relinked".into()).await;
    }
    let updated = service.update_thread(&thread.id, true, |thread| {
        thread.checkout_path = checkout.to_string_lossy().into_owned();
        thread.checkout_identity = checkout_identity;
        thread.checkout_status = "available".into();
        thread.resume_status = "unknown".into();
        thread.provider_status = "unknown".into();
        thread.error = None;
    });
    updated_thread(
        &service,
        &thread_id,
        updated,
        "The chat checkout could not be relinked",
    )
}

#[tauri::command]
#[instrument(name = "agent_chat_storage_status", skip(service))]
pub fn agent_chat_storage_status(
    service: State<'_, AgentChatService>,
) -> Result<AgentChatStorageStatus, CommandError> {
    Ok(service.storage_status())
}

#[tauri::command]
#[instrument(name = "agent_chat_list_unlinked_projects", skip(service))]
pub fn agent_chat_list_unlinked_projects(
    service: State<'_, AgentChatService>,
) -> Result<Vec<StoredProject>, CommandError> {
    service.list_unlinked_projects()
}

#[tauri::command]
#[instrument(name = "agent_chat_relink_project", skip(service, project_path))]
pub async fn agent_chat_relink_project(
    service: State<'_, AgentChatService>,
    project_id: String,
    project_path: String,
) -> Result<(), CommandError> {
    Uuid::parse_str(&project_id).map_err(|_| CommandError::Validation {
        field: "projectId".into(),
        reason: "The stored project identity is invalid".into(),
    })?;
    let project = validate_project(&project_path)?;
    match git_common_dir(&project).await? {
        Some(common_dir) => {
            let identity_key = common_dir.to_string_lossy().into_owned();
            service.relink_project(&project_id, &identity_key, &project, None)
        }
        None => {
            let identity_key = plain_identity_key(&project)?;
            let folder_instance_id = folder_instance_identity(&project)?.ok_or_else(|| {
                CommandError::expected(
                    "Ship Studio could not verify this folder's stable identity. Make the folder writable for its Agent Chat identity marker, then retry the relink.",
                )
            })?;
            service.relink_project(
                &project_id,
                &identity_key,
                &project,
                Some(&folder_instance_id),
            )
        }
    }
}

#[tauri::command]
#[instrument(name = "agent_chat_discard", skip(service, project_path))]
pub async fn agent_chat_discard(
    service: State<'_, AgentChatService>,
    project_path: String,
    thread_id: String,
    confirmed: bool,
) -> Result<(), CommandError> {
    if !confirmed {
        return Err(CommandError::Validation {
            field: "confirmed".into(),
            reason: "Confirm before discarding this local chat history".into(),
        });
    }
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    let _thread = thread_for_project(&service, &project_id, &thread_id)?;
    if matches!(_thread.status.as_str(), "running" | "waiting" | "starting") {
        let updated = service.update_thread(&thread_id, true, |thread| {
            mark_unfinished_turns_interrupted(thread, chrono::Utc::now().timestamp_millis());
            thread.status = "interrupted".into();
            thread.turn_id = None;
            thread.requests.clear();
            thread.provider_status = "unknown".into();
            thread.resume_status = "unknown".into();
            thread.error =
                Some("This chat was stopped before its local history was discarded.".into());
        });
        if updated.is_none() {
            service.ensure_storage()?;
            return Err(CommandError::expected(
                "The active chat could not be stopped safely for discard",
            ));
        }
        service.ensure_storage()?;
    }
    if let Some(runtime) = service.remove_runtime(&thread_id) {
        runtime.stop("This chat was discarded".into()).await;
    }
    service
        .remove_thread(&thread_id)?
        .ok_or_else(|| CommandError::expected("The chat could not be discarded"))?;
    Ok(())
}

#[tauri::command]
#[instrument(
    name = "agent_chat_stage_attachment",
    skip(service, app, project_path, path)
)]
pub async fn agent_chat_stage_attachment(
    service: State<'_, AgentChatService>,
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<ChatAttachment, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    service.stage_attachment(&app, &path, &project_id)
}

#[tauri::command]
#[instrument(
    name = "agent_chat_recheck_attachments",
    skip(service, project_path, attachments)
)]
pub async fn agent_chat_recheck_attachments(
    service: State<'_, AgentChatService>,
    project_path: String,
    attachments: Vec<ChatAttachment>,
) -> Result<Vec<ChatAttachment>, CommandError> {
    let project = validate_project(&project_path)?;
    let project_id = project_identity(&service, &project).await?;
    if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(CommandError::Validation {
            field: "attachments".into(),
            reason: format!(
                "A message can include up to {MAX_ATTACHMENTS_PER_MESSAGE} attachments"
            ),
        });
    }
    if attachments.iter().fold(0u64, |total, attachment| {
        total.saturating_add(attachment.size)
    }) > MAX_ATTACHMENT_BYTES * 4
    {
        return Err(CommandError::Validation {
            field: "attachments".into(),
            reason: "Attachments in one message must total no more than 100 MB".into(),
        });
    }
    service.recheck_attachments(&project_id, &attachments)
}

fn validate_project(project_path: &str) -> Result<PathBuf, CommandError> {
    let project = validate_project_path(project_path)?;
    if !project.is_dir() {
        return Err(CommandError::Validation {
            field: "projectPath".into(),
            reason: "The project directory is not available".into(),
        });
    }
    Ok(project)
}

fn require_expected_project_identity(
    expected_project_id: &str,
    actual_project_id: &str,
) -> Result<(), CommandError> {
    if expected_project_id == actual_project_id {
        Ok(())
    } else {
        Err(CommandError::expected(
            "This project changed while Agent Chat was open. Reload the project before continuing.",
        ))
    }
}

async fn project_identity(
    service: &AgentChatService,
    project: &Path,
) -> Result<String, CommandError> {
    match git_common_dir(project).await? {
        Some(common_dir) => {
            let main_checkout = git_main_checkout(project).await?;
            let project_id =
                service.ensure_project_identity(&common_dir, project, main_checkout.as_deref())?;
            if let Some((pending_identity, pending_path)) =
                service.pending_checkout_binding(&project_id)?
            {
                let pending_path = PathBuf::from(pending_path);
                if let Some(main_checkout) = main_checkout
                    .as_ref()
                    .filter(|path| path.as_path() == pending_path.as_path())
                {
                    let git_dir = checkout_git_dir(main_checkout).await?;
                    let actual =
                        checkout_marker_identity_with_default(&git_dir, Some(&pending_identity))?;
                    if actual != pending_identity {
                        tracing::warn!(
                            project_id = %project_id,
                            "The main checkout already has a different Agent Chat marker; saved chats remain bound to their prior checkout"
                        );
                    }
                    service.clear_pending_checkout_binding(
                        &project_id,
                        &pending_identity,
                        &pending_path.to_string_lossy(),
                    )?;
                }
            }
            Ok(project_id)
        }
        None => service.ensure_plain_project_identity(project),
    }
}

async fn git_common_dir(project: &Path) -> Result<Option<PathBuf>, CommandError> {
    let mut git = crate::utils::git_command_in(project)?;
    git.args(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let output = run_with_timeout(
        tokio::process::Command::from(git),
        "git rev-parse --git-common-dir",
        8,
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.to_lowercase().contains("not a git repository") && !has_git_metadata(project)? {
            return Ok(None);
        }
        return Err(CommandError::expected(format!(
            "Git could not identify the selected project repository: {}",
            if stderr.is_empty() {
                "Git returned an error".to_string()
            } else {
                truncate_error(&stderr, 240)
            }
        )));
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(CommandError::expected(
            "Git did not provide a stable repository identity",
        ));
    }
    Ok(Some(dunce::canonicalize(&path).map_err(|error| {
        crate::utils::classify_fs_error("access the project's Git identity", &path, &error)
    })?))
}

async fn git_main_checkout(project: &Path) -> Result<Option<PathBuf>, CommandError> {
    let mut git = crate::utils::git_command_in(project)?;
    git.args(["worktree", "list", "--porcelain"]);
    let output =
        run_with_timeout(tokio::process::Command::from(git), "git worktree list", 8).await?;
    if !output.status.success() {
        return Err(CommandError::expected(
            "Git could not identify the repository's main checkout",
        ));
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let Some(main_path) = output
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    match dunce::canonicalize(&main_path) {
        Ok(main_path) if main_path.is_dir() => Ok(Some(main_path)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(crate::utils::classify_fs_error(
            "access the repository's main checkout",
            &main_path,
            &error,
        )),
    }
}

fn has_git_metadata(project: &Path) -> Result<bool, CommandError> {
    for ancestor in project.ancestors() {
        let metadata = ancestor.join(".git");
        match fs::symlink_metadata(&metadata) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(crate::utils::classify_fs_error(
                    "inspect project Git metadata",
                    &metadata,
                    &error,
                ));
            }
        }
    }
    Ok(false)
}

fn plain_identity_key(project: &Path) -> Result<String, CommandError> {
    let path = dunce::canonicalize(project).map_err(|error| {
        crate::utils::classify_fs_error("access the project folder identity", project, &error)
    })?;
    Ok(format!("plain:{}", path.to_string_lossy()))
}

fn truncate_error(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn validate_settings(settings: &ChatSettings) -> Result<(), CommandError> {
    if settings
        .model_id
        .as_deref()
        .is_some_and(|value| value.len() > 256 || value.chars().any(char::is_control))
    {
        return Err(CommandError::Validation {
            field: "settings.modelId".into(),
            reason: "The model identifier is invalid".into(),
        });
    }
    if settings
        .reasoning_effort
        .as_deref()
        .is_some_and(|value| value.len() > 64 || value.chars().any(char::is_control))
    {
        return Err(CommandError::Validation {
            field: "settings.reasoningEffort".into(),
            reason: "The reasoning effort is invalid".into(),
        });
    }
    Ok(())
}

fn validate_project_draft(
    app: &AppHandle,
    project_id: &str,
    owner_scope: AttachmentOwnerScope<'_>,
    draft: &ChatDraft,
    settings: &ChatSettings,
) -> Result<(), CommandError> {
    if draft.text.len() > MAX_ITEM_TEXT_BYTES {
        return Err(CommandError::Validation {
            field: "draft.text".into(),
            reason: "Drafts must be no longer than 64 KB".into(),
        });
    }
    if draft.attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(CommandError::Validation {
            field: "draft.attachments".into(),
            reason: format!("A draft can include up to {MAX_ATTACHMENTS_PER_MESSAGE} attachments"),
        });
    }
    if draft.attachments.iter().fold(0u64, |total, attachment| {
        total.saturating_add(attachment.size)
    }) > MAX_ATTACHMENT_BYTES * 4
    {
        return Err(CommandError::Validation {
            field: "draft.attachments".into(),
            reason: "Draft attachments must total no more than 100 MB".into(),
        });
    }
    validate_settings(settings)?;
    attachments::validate_staged(app, project_id, owner_scope, &draft.attachments)
}

fn validate_draft_id(draft_id: &str) -> Result<(), CommandError> {
    let parsed = Uuid::parse_str(draft_id).map_err(|_| CommandError::Validation {
        field: "draftId".into(),
        reason: "The draft identifier is invalid".into(),
    })?;
    if parsed.to_string() != draft_id {
        return Err(CommandError::Validation {
            field: "draftId".into(),
            reason: "The draft identifier is invalid".into(),
        });
    }
    Ok(())
}

fn validate_saved_draft_identity(
    draft: &SavedChatDraft,
    checkout_path: &str,
    checkout_identity: &str,
) -> Result<(), CommandError> {
    if draft.checkout_path != checkout_path || draft.checkout_identity != checkout_identity {
        return Err(CommandError::Validation {
            field: "checkoutPath".into(),
            reason: "This draft belongs to a different Git checkout".into(),
        });
    }
    Ok(())
}

fn updated_thread(
    service: &AgentChatService,
    thread_id: &str,
    updated: Option<ChatThread>,
    fallback: &str,
) -> Result<ChatThread, CommandError> {
    if let Some(updated) = updated {
        return Ok(updated);
    }
    service.ensure_storage()?;
    service
        .thread(thread_id)
        .ok_or_else(|| CommandError::expected(fallback))
}

async fn validate_checkout(
    project: &Path,
    checkout_path: &str,
    project_id: &str,
) -> Result<PathBuf, CommandError> {
    let checkout = validate_project_path(checkout_path)?;
    if !checkout.is_dir() {
        return Err(CommandError::Validation {
            field: "checkoutPath".into(),
            reason: "The selected checkout directory is not available".into(),
        });
    }
    let expected = dunce::canonicalize(&checkout)
        .map_err(|_| CommandError::expected("The selected checkout is unavailable"))?;
    match git_common_dir(project).await? {
        Some(_) => {
            if !list_checkouts(project, project_id)
                .await?
                .contains_key(&expected)
            {
                return Err(CommandError::Validation {
                    field: "checkoutPath".into(),
                    reason: "Choose an existing Git worktree belonging to this project".into(),
                });
            }
        }
        None => {
            let project_root = dunce::canonicalize(project).map_err(|error| {
                crate::utils::classify_fs_error("access the project folder", project, &error)
            })?;
            if expected != project_root {
                return Err(CommandError::Validation {
                    field: "checkoutPath".into(),
                    reason: "Chats in a plain folder run in that project folder".into(),
                });
            }
        }
    }
    Ok(expected)
}

async fn validate_thread_checkout(
    service: &AgentChatService,
    project: &Path,
    thread: &ChatThread,
) -> Result<PathBuf, CommandError> {
    if thread.checkout_status == "missing" {
        return Err(CommandError::expected(
            "This chat's original checkout is unavailable. Explicitly relink it to an existing worktree before continuing.",
        ));
    }
    if thread.checkout_identity.is_empty() {
        mark_checkout_missing(service, &thread.id)?;
        return Err(CommandError::expected(
            "This saved chat predates checkout identity tracking. Explicitly relink it to an existing worktree before continuing.",
        ));
    }
    let checkout = match validate_checkout(project, &thread.checkout_path, &thread.project_id).await
    {
        Ok(checkout) => checkout,
        Err(_) => {
            mark_checkout_missing(service, &thread.id)?;
            return Err(CommandError::expected(
                "This checkout is no longer available as a Git worktree. Explicitly relink the chat before continuing.",
            ));
        }
    };
    let actual_identity = checkout_identity(&checkout, Some(&thread.project_id)).await?;
    if thread.checkout_identity != actual_identity {
        mark_checkout_missing(service, &thread.id)?;
        return Err(CommandError::expected(
            "A different checkout now occupies this path. Explicitly relink the chat before continuing.",
        ));
    }
    let updated = service.update_thread(&thread.id, true, |thread| {
        thread.checkout_identity = actual_identity;
        thread.checkout_status = "available".into();
    });
    if updated.is_none() {
        service.ensure_storage()?;
        return Err(CommandError::expected(
            "The saved checkout identity could not be validated",
        ));
    }
    service.ensure_storage()?;
    Ok(checkout)
}

fn mark_checkout_missing(service: &AgentChatService, thread_id: &str) -> Result<(), CommandError> {
    service.update_thread(thread_id, true, |thread| {
        thread.checkout_status = "missing".into();
        thread.resume_status = "unavailable".into();
        thread.error = Some(
            "The original checkout is unavailable. Explicitly relink this chat to an existing worktree before continuing.".into(),
        );
    });
    service.ensure_storage()
}

async fn list_checkouts(
    project: &Path,
    project_id: &str,
) -> Result<std::collections::HashMap<PathBuf, String>, CommandError> {
    if git_common_dir(project).await?.is_none() {
        let root = dunce::canonicalize(project).map_err(|error| {
            crate::utils::classify_fs_error("access the project folder", project, &error)
        })?;
        return Ok([(root, project_id.to_string())].into_iter().collect());
    }
    let mut git = crate::utils::git_command_in(project)?;
    git.args(["worktree", "list", "--porcelain"]);
    let output =
        run_with_timeout(tokio::process::Command::from(git), "git worktree list", 8).await?;
    if !output.status.success() {
        return Err(CommandError::expected(
            "The project is not an available Git repository",
        ));
    }
    let paths = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter_map(|path| dunce::canonicalize(path).ok())
        .filter(|path| path.is_dir())
        .collect::<std::collections::HashSet<_>>();
    let mut checkouts = std::collections::HashMap::with_capacity(paths.len());
    for path in paths {
        let identity = checkout_identity(&path, None).await?;
        checkouts.insert(path, identity);
    }
    Ok(checkouts)
}

async fn checkout_identity(
    checkout: &Path,
    plain_identity: Option<&str>,
) -> Result<String, CommandError> {
    if git_common_dir(checkout).await?.is_none() {
        return plain_identity.map(str::to_string).ok_or_else(|| {
            CommandError::expected("The plain project checkout identity is unavailable")
        });
    }
    let git_dir = checkout_git_dir(checkout).await?;
    checkout_marker_identity(&git_dir)
}

async fn checkout_git_dir(checkout: &Path) -> Result<PathBuf, CommandError> {
    let mut git = crate::utils::git_command_in(checkout)?;
    git.args(["rev-parse", "--path-format=absolute", "--git-dir"]);
    let output = run_with_timeout(
        tokio::process::Command::from(git),
        "git rev-parse --git-dir",
        8,
    )
    .await?;
    if !output.status.success() {
        return Err(CommandError::expected(
            "Git could not identify the selected checkout",
        ));
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let git_dir = PathBuf::from(value);
    let git_dir = dunce::canonicalize(&git_dir).map_err(|error| {
        crate::utils::classify_fs_error("access the checkout's Git metadata", &git_dir, &error)
    })?;
    Ok(git_dir)
}

fn checkout_marker_identity(git_dir: &Path) -> Result<String, CommandError> {
    checkout_marker_identity_with_default(git_dir, None)
}

pub(super) fn checkout_marker_identity_with_default(
    git_dir: &Path,
    preferred_identity: Option<&str>,
) -> Result<String, CommandError> {
    let marker = git_dir.join(CHECKOUT_IDENTITY_MARKER);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.file_type().is_file() => {
            return read_checkout_marker(&marker);
        }
        Ok(_) => {
            return Err(CommandError::expected(
                "The checkout's Agent Chat identity marker is not a regular file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(crate::utils::classify_fs_error(
                "inspect checkout identity",
                &marker,
                &error,
            ));
        }
    }

    let identity = if let Some(preferred_identity) = preferred_identity {
        let parsed = Uuid::parse_str(preferred_identity).map_err(|_| {
            CommandError::expected("The saved Agent Chat checkout identity is invalid")
        })?;
        if parsed.to_string() != preferred_identity {
            return Err(CommandError::expected(
                "The saved Agent Chat checkout identity is invalid",
            ));
        }
        preferred_identity.to_string()
    } else {
        Uuid::new_v4().to_string()
    };
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return read_checkout_marker(&marker);
        }
        Err(error) => {
            return Err(crate::utils::classify_fs_error(
                "save checkout identity",
                &marker,
                &error,
            ));
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                let _ = fs::remove_file(&marker);
                crate::utils::classify_fs_error("secure checkout identity", &marker, &error)
            })?;
    }
    if let Err(error) = writeln!(file, "{identity}").and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&marker);
        return Err(crate::utils::classify_fs_error(
            "save checkout identity",
            &marker,
            &error,
        ));
    }
    Ok(identity)
}

fn read_checkout_marker(marker: &Path) -> Result<String, CommandError> {
    let identity = fs::read_to_string(marker).map_err(|error| {
        crate::utils::classify_fs_error("read checkout identity", marker, &error)
    })?;
    let identity = identity.trim();
    let parsed = Uuid::parse_str(identity).map_err(|_| {
        CommandError::expected("The checkout's Agent Chat identity marker is invalid")
    })?;
    let canonical = parsed.to_string();
    if canonical != identity {
        return Err(CommandError::expected(
            "The checkout's Agent Chat identity marker is invalid",
        ));
    }
    Ok(canonical)
}

fn thread_for_project(
    service: &AgentChatService,
    project_id: &str,
    thread_id: &str,
) -> Result<ChatThread, CommandError> {
    let thread = service
        .thread(thread_id)
        .ok_or_else(|| CommandError::expected("The chat thread is unavailable"))?;
    if thread.project_id != project_id {
        return Err(CommandError::Validation {
            field: "threadId".into(),
            reason: "This chat does not belong to the selected project".into(),
        });
    }
    Ok(thread)
}

fn mark_thread_error(service: &AgentChatService, thread_id: &str, error: String) {
    let visible = super::types::truncate_utf8(&error, 512);
    service.update_thread(thread_id, true, |thread| {
        thread.status = "error".into();
        thread.turn_id = None;
        thread.requests.clear();
        thread.error = Some(visible.clone());
        thread.items.push(ChatItem {
            id: format!("startup-error:{}", Uuid::new_v4()),
            turn_id: None,
            kind: "error".into(),
            text: visible,
            status: Some("failed".into()),
            attachments: Vec::new(),
        });
    });
}

fn append_error(service: &AgentChatService, thread_id: &str, message: String) {
    let visible = super::types::truncate_utf8(&message, 512);
    service.update_thread(thread_id, true, |thread| {
        thread.items.push(ChatItem {
            id: format!("chat-error:{}", Uuid::new_v4()),
            turn_id: thread.turn_id.clone(),
            kind: "error".into(),
            text: visible.clone(),
            status: Some("failed".into()),
            attachments: Vec::new(),
        });
        if matches!(thread.status.as_str(), "starting" | "running") {
            thread.status = "error".into();
        }
        thread.error = Some(visible);
    });
}

fn append_error_preserving_status(service: &AgentChatService, thread_id: &str, message: String) {
    let visible = super::types::truncate_utf8(&message, 512);
    service.update_thread(thread_id, true, |thread| {
        thread.items.push(ChatItem {
            id: format!("chat-error:{}", Uuid::new_v4()),
            turn_id: thread.turn_id.clone(),
            kind: "error".into(),
            text: visible.clone(),
            status: Some("failed".into()),
            attachments: Vec::new(),
        });
        thread.error = Some(visible);
    });
}

#[cfg(test)]
mod tests {
    use super::checkout_marker_identity;
    use std::fs;

    #[test]
    fn checkout_marker_changes_when_a_git_worktree_admin_directory_is_recreated() {
        let root = tempfile::tempdir().expect("temporary git metadata directory");
        let admin = root.path().join(".git/worktrees/feature");
        fs::create_dir_all(&admin).expect("create worktree admin directory");

        let original = checkout_marker_identity(&admin).expect("create first checkout marker");
        assert_eq!(
            checkout_marker_identity(&admin).expect("read stable checkout marker"),
            original
        );

        fs::remove_dir_all(&admin).expect("simulate worktree removal");
        fs::create_dir_all(&admin).expect("reuse the same worktree admin path");
        let replacement =
            checkout_marker_identity(&admin).expect("create replacement checkout marker");
        assert_ne!(replacement, original);
    }
}
