use super::protocol::{
    image_input_support, normalize_history_item, normalize_models, rpc_notification,
};
use super::runtime::{request, spawn_process, RuntimeControl};
use super::service::AgentChatService;
use crate::errors::CommandError;
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

const RPC_METHOD_TIMEOUT_ERROR: &str = "Codex app-server is no longer available";
const HISTORY_PAGE_SIZE: u64 = 100;
const MAX_HISTORY_REQUESTS: usize = 256;
const HISTORY_RECONCILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub(super) struct ProviderThreadHistory {
    pub(super) status: String,
    pub(super) items: Vec<super::types::ChatItem>,
    pub(super) approval_policy: Option<Value>,
    pub(super) sandbox_policy: Option<Value>,
}

pub(super) async fn start_thread_runtime(
    service: &AgentChatService,
    thread_id: &str,
    project_path: &Path,
    checkout_path: &Path,
    provider_thread_id: Option<&str>,
) -> Result<(RuntimeControl, Option<String>), CommandError> {
    let runtime = initialize_runtime(service, thread_id, project_path, checkout_path).await?;

    let result = async {
        if let Some(provider_thread_id) = provider_thread_id {
            request(
                service,
                thread_id,
                &runtime,
                "thread/resume",
                json!({
                    "threadId": provider_thread_id,
                    "cwd": checkout_path.to_string_lossy()
                }),
            )
            .await
            .map_err(protocol_error)
            .and_then(|result| {
                validate_provider_thread_id(&result, provider_thread_id)?;
                Ok(result)
            })
            .map(|result| {
                persist_effective_settings(service, thread_id, &result);
                result
            })?;
            Ok(None)
        } else {
            let result = request(
                service,
                thread_id,
                &runtime,
                "thread/start",
                json!({
                    "cwd": checkout_path.to_string_lossy()
                }),
            )
            .await
            .map_err(protocol_error)?;
            let provider_id = result
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    CommandError::expected("Codex did not return a thread identifier")
                })?;
            persist_effective_settings(service, thread_id, &result);
            Ok(Some(provider_id))
        }
    }
    .await;

    match result {
        Ok(provider_id) => Ok((runtime, provider_id)),
        Err(error) => {
            service.remove_runtime(thread_id);
            runtime
                .stop("Could not initialize the Codex chat process".into())
                .await;
            Err(error)
        }
    }
}

fn validate_provider_thread_id(result: &Value, expected: &str) -> Result<(), CommandError> {
    if result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        == Some(expected)
    {
        Ok(())
    } else {
        Err(CommandError::expected(
            "Codex returned a different conversation than the saved thread",
        ))
    }
}

fn provider_thread_needs_loading(status: &str) -> bool {
    status == "notLoaded"
}

fn persist_effective_settings(service: &AgentChatService, thread_id: &str, result: &Value) {
    let approval_policy = result.get("approvalPolicy").cloned();
    let sandbox_policy = result.get("sandbox").cloned();
    if approval_policy.is_some() || sandbox_policy.is_some() {
        service.update_thread(thread_id, true, |thread| {
            if approval_policy.is_some() {
                thread.approval_policy = approval_policy;
            }
            if sandbox_policy.is_some() {
                thread.sandbox_policy = sandbox_policy;
            }
        });
    }
}

async fn initialize_runtime(
    service: &AgentChatService,
    thread_id: &str,
    project_path: &Path,
    checkout_path: &Path,
) -> Result<RuntimeControl, CommandError> {
    let preview_url = crate::agent_bridge::agent_bridge_url_for_project(
        service.app_handle(),
        &checkout_path.to_string_lossy(),
    )
    .await
    .map_err(|_| CommandError::expected("The Ship Studio preview connection is unavailable"))?;
    let runtime = spawn_process(
        service.clone(),
        thread_id.to_string(),
        project_path,
        checkout_path,
        &preview_url,
    )
    .await?;
    service.insert_runtime(thread_id, runtime.clone());

    let result = async {
        request(
            service,
            thread_id,
            &runtime,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "ship-studio",
                    "title": "Ship Studio",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
        )
        .await
        .map_err(protocol_error)?;
        runtime
            .outbound
            .send(rpc_notification("initialized", json!({})))
            .await
            .map_err(|_| CommandError::expected(RPC_METHOD_TIMEOUT_ERROR))?;
        Ok::<(), CommandError>(())
    }
    .await;

    match result {
        Ok(()) => Ok(runtime),
        Err(error) => {
            service.remove_runtime(thread_id);
            runtime
                .stop("Could not initialize the Codex chat process".into())
                .await;
            Err(error)
        }
    }
}

pub(super) async fn discover_models(
    service: &AgentChatService,
    project_path: &Path,
) -> Result<Vec<super::types::ChatModel>, CommandError> {
    let probe_id = Uuid::new_v4().to_string();
    let runtime = initialize_runtime(service, &probe_id, project_path, project_path).await?;
    let models = request(
        service,
        &probe_id,
        &runtime,
        "model/list",
        json!({ "includeHidden": false, "limit": 100 }),
    )
    .await
    .map(|value| normalize_models(&value))
    .map_err(protocol_error);
    service.remove_runtime(&probe_id);
    runtime.stop("Codex model discovery completed".into()).await;
    models
}

pub(super) async fn validate_image_attachments(
    service: &AgentChatService,
    project_path: &Path,
    model_id: Option<&str>,
    attachments: &[super::types::ChatAttachment],
) -> Result<(), CommandError> {
    if !attachments
        .iter()
        .any(|attachment| attachment.kind == "image")
    {
        return Ok(());
    }

    let Ok(models) = discover_models(service, project_path).await else {
        // A failed capability lookup is unknown, not evidence that the model
        // rejects images. Let the actual send report any provider rejection.
        return Ok(());
    };
    let selected_model = model_id
        .and_then(|id| models.iter().find(|model| model.id == id))
        .or_else(|| {
            model_id
                .is_none()
                .then(|| models.iter().find(|model| model.is_default))
                .flatten()
        });
    if selected_model.is_some_and(|model| image_input_support(model) == Some(false)) {
        return Err(CommandError::Validation {
            field: "attachments".into(),
            reason: "The selected Codex model does not support image input. Choose a model that advertises image input, or remove the image attachment.".into(),
        });
    }
    Ok(())
}

pub(super) async fn read_thread_history(
    service: &AgentChatService,
    project_path: &Path,
    checkout_path: &Path,
    provider_thread_id: &str,
) -> Result<ProviderThreadHistory, CommandError> {
    let probe_id = format!("resume-check:{}", Uuid::new_v4());
    let runtime = initialize_runtime(service, &probe_id, project_path, checkout_path).await?;
    let response = read_history_on_runtime(
        service,
        &probe_id,
        &runtime,
        checkout_path,
        provider_thread_id,
    )
    .await;
    service.remove_runtime(&probe_id);
    runtime
        .stop("Codex conversation status check completed".into())
        .await;
    response
}

pub(super) async fn capture_send_baseline(
    service: &AgentChatService,
    thread_id: &str,
    runtime: &RuntimeControl,
    checkout_path: &Path,
    provider_thread_id: &str,
) -> Result<ProviderThreadHistory, CommandError> {
    read_history_on_runtime(
        service,
        thread_id,
        runtime,
        checkout_path,
        provider_thread_id,
    )
    .await
}

async fn read_history_on_runtime(
    service: &AgentChatService,
    runtime_id: &str,
    runtime: &RuntimeControl,
    checkout_path: &Path,
    provider_thread_id: &str,
) -> Result<ProviderThreadHistory, CommandError> {
    let (mut status, mut approval_policy, mut sandbox_policy) =
        read_provider_status(service, runtime_id, runtime, provider_thread_id).await?;
    if provider_thread_needs_loading(&status) {
        // thread/read is deliberately non-resuming. Load only the exact saved
        // provider ID, then read it again to get live status evidence.
        let resumed = request(
            service,
            runtime_id,
            runtime,
            "thread/resume",
            json!({
                "threadId": provider_thread_id,
                "cwd": checkout_path.to_string_lossy(),
                "excludeTurns": true
            }),
        )
        .await
        .map_err(protocol_error)?;
        validate_provider_thread_id(&resumed, provider_thread_id)?;
        persist_effective_settings(service, runtime_id, &resumed);
        approval_policy = resumed.get("approvalPolicy").cloned().or(approval_policy);
        sandbox_policy = resumed.get("sandbox").cloned().or(sandbox_policy);
        (status, _, _) =
            read_provider_status(service, runtime_id, runtime, provider_thread_id).await?;
    }
    let items = tokio::time::timeout(
        HISTORY_RECONCILE_TIMEOUT,
        read_provider_history(service, runtime_id, runtime, provider_thread_id),
    )
    .await
    .map_err(|_| {
        CommandError::expected(
            "Codex history reconciliation took too long. The follow-up was not sent.",
        )
    })??;
    Ok(ProviderThreadHistory {
        status,
        items,
        approval_policy,
        sandbox_policy,
    })
}

async fn read_provider_status(
    service: &AgentChatService,
    runtime_id: &str,
    runtime: &RuntimeControl,
    provider_thread_id: &str,
) -> Result<(String, Option<Value>, Option<Value>), CommandError> {
    let response = request(
        service,
        runtime_id,
        runtime,
        "thread/read",
        json!({ "threadId": provider_thread_id, "includeTurns": false }),
    )
    .await
    .map_err(protocol_error)?;
    let thread = response
        .get("thread")
        .ok_or_else(|| CommandError::expected("Codex did not return the saved conversation"))?;
    validate_provider_thread_id(&response, provider_thread_id)?;
    let status = thread
        .get("status")
        .and_then(|status| status.get("type").or(Some(status)))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "notLoaded" | "idle" | "active" | "systemError"))
        .unwrap_or("unknown")
        .to_string();
    Ok((status, None, None))
}

async fn read_provider_history(
    service: &AgentChatService,
    probe_id: &str,
    runtime: &RuntimeControl,
    provider_thread_id: &str,
) -> Result<Vec<super::types::ChatItem>, CommandError> {
    let mut turns = Vec::new();
    let mut turn_cursor = None;
    let mut seen_turn_cursors = std::collections::HashSet::new();
    let mut page_requests = 0;
    loop {
        if page_requests == MAX_HISTORY_REQUESTS {
            return Err(history_too_large());
        }
        page_requests += 1;
        let mut params = json!({
            "threadId": provider_thread_id,
            "limit": HISTORY_PAGE_SIZE,
            "sortDirection": "asc",
            "itemsView": "notLoaded"
        });
        if let Some(cursor) = turn_cursor.take() {
            params["cursor"] = cursor;
        }
        let page = request(service, probe_id, runtime, "thread/turns/list", params)
            .await
            .map_err(protocol_error)?;
        let data = page.get("data").and_then(Value::as_array).ok_or_else(|| {
            CommandError::expected("Codex returned an invalid conversation history page")
        })?;
        for turn in data {
            let turn_id = turn
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    CommandError::expected("Codex returned a history turn without an ID")
                })?;
            turns.push(turn_id.to_string());
        }
        let next = page
            .get("nextCursor")
            .filter(|cursor| !cursor.is_null())
            .cloned();
        let Some(next) = next else { break };
        if !seen_turn_cursors.insert(next.to_string()) {
            return Err(CommandError::expected(
                "Codex repeated a conversation history cursor",
            ));
        }
        turn_cursor = Some(next);
    }

    let mut items = Vec::new();
    for turn_id in turns {
        let mut item_cursor = None;
        let mut seen_item_cursors = std::collections::HashSet::new();
        loop {
            if page_requests == MAX_HISTORY_REQUESTS {
                return Err(history_too_large());
            }
            page_requests += 1;
            let mut params = json!({
                "threadId": provider_thread_id,
                "turnId": turn_id,
                "limit": HISTORY_PAGE_SIZE,
                "sortDirection": "asc"
            });
            if let Some(cursor) = item_cursor.take() {
                params["cursor"] = cursor;
            }
            let page = request(service, probe_id, runtime, "thread/items/list", params)
                .await
                .map_err(protocol_error)?;
            let data = page.get("data").and_then(Value::as_array).ok_or_else(|| {
                CommandError::expected("Codex returned an invalid conversation item page")
            })?;
            for entry in data {
                let item_turn_id = entry
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or(&turn_id);
                if let Some(item) = entry
                    .get("item")
                    .and_then(|item| normalize_history_item(item, item_turn_id))
                {
                    items.push(item);
                }
            }
            let next = page
                .get("nextCursor")
                .filter(|cursor| !cursor.is_null())
                .cloned();
            let Some(next) = next else { break };
            if !seen_item_cursors.insert(next.to_string()) {
                return Err(CommandError::expected(
                    "Codex repeated a conversation item cursor",
                ));
            }
            item_cursor = Some(next);
        }
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::{provider_thread_needs_loading, validate_provider_thread_id};
    use serde_json::json;

    #[test]
    fn only_not_loaded_saved_threads_are_resumed_for_history() {
        assert!(provider_thread_needs_loading("notLoaded"));
        assert!(!provider_thread_needs_loading("idle"));
        assert!(!provider_thread_needs_loading("active"));
        assert!(!provider_thread_needs_loading("systemError"));
        assert!(!provider_thread_needs_loading("unknown"));
    }

    #[test]
    fn history_resume_accepts_only_the_original_provider_thread_id() {
        assert!(validate_provider_thread_id(
            &json!({ "thread": { "id": "saved-provider-thread" } }),
            "saved-provider-thread"
        )
        .is_ok());
        assert!(validate_provider_thread_id(
            &json!({ "thread": { "id": "replacement-provider-thread" } }),
            "saved-provider-thread"
        )
        .is_err());
    }
}

fn history_too_large() -> CommandError {
    CommandError::expected(
        "The Codex conversation is too large to reconcile safely. The follow-up was not sent.",
    )
}

pub(super) async fn resume_thread_runtime(
    service: &AgentChatService,
    thread_id: &str,
    project_path: &Path,
    checkout_path: &Path,
    provider_thread_id: &str,
) -> Result<RuntimeControl, CommandError> {
    if let Some(runtime) = service.runtime(thread_id) {
        return Ok(runtime);
    }
    let (runtime, _) = start_thread_runtime(
        service,
        thread_id,
        project_path,
        checkout_path,
        Some(provider_thread_id),
    )
    .await?;
    Ok(runtime)
}

fn protocol_error(error: String) -> CommandError {
    if error.starts_with("Codex returned a protocol error") {
        CommandError::expected(error)
    } else {
        CommandError::expected("Codex app-server did not complete the request")
    }
}
