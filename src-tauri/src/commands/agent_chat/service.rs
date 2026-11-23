use super::persistence::{ChatStore, StoredProject};
use super::protocol::{
    classify_request, display_request_id, normalize_item, protocol_request_id_key, rpc_error,
    rpc_result, visible_request_params,
};
use super::runtime::RuntimeControl;
use super::types::{
    mark_unfinished_turns_interrupted, trim_transcript, ChatAttachment, ChatDraft, ChatItem,
    ChatRequest, ChatSendReconciliation, ChatSettings, ChatThread, ChatTurnRecord, SavedChatDraft,
    SavedChatDraftPage,
};
use crate::errors::CommandError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

const EVENT_NAME: &str = "agent-chat://thread";
const DELTA_EVENT_INTERVAL: Duration = Duration::from_millis(50);
const MAX_SERVER_REQUEST_IDS_PER_RUNTIME: usize = 4096;

#[derive(Clone)]
pub struct AgentChatService {
    inner: Arc<ServiceInner>,
}

struct ServiceInner {
    app: AppHandle,
    store: Option<ChatStore>,
    initial_storage_error: Option<String>,
    storage_fault: Mutex<Option<String>>,
    state: Mutex<ChatState>,
    emission: Mutex<HashMap<String, EmissionState>>,
    draft_promotion_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

#[derive(Default)]
struct ChatState {
    threads: HashMap<String, ChatThread>,
    order: Vec<String>,
    runtimes: HashMap<String, RuntimeControl>,
    pending_rpcs: HashMap<(String, String, String), oneshot::Sender<Result<Value, String>>>,
    pending_requests: HashMap<(String, String), PendingServerRequest>,
    request_correlations: HashMap<ServerRequestCorrelationKey, String>,
    seen_server_request_ids: HashSet<ServerRequestCorrelationKey>,
    unknown_notification_generations: HashSet<(String, String)>,
    uncertain_turns: HashMap<String, bool>,
}

pub(super) struct PendingServerRequest {
    pub(super) rpc_id: Value,
    pub(super) request: ChatRequest,
    runtime_generation: String,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ServerRequestCorrelationKey {
    thread_id: String,
    runtime_generation: String,
    provider_thread_id: String,
    request_id: String,
}

impl ServerRequestCorrelationKey {
    fn new(
        thread_id: &str,
        runtime_generation: &str,
        provider_thread_id: &str,
        request_id: &Value,
    ) -> Option<Self> {
        Some(Self {
            thread_id: thread_id.to_string(),
            runtime_generation: runtime_generation.to_string(),
            provider_thread_id: provider_thread_id.to_string(),
            request_id: protocol_request_id_key(request_id)?,
        })
    }
}

#[derive(Default)]
struct EmissionState {
    last_emit: Option<Instant>,
    scheduled: bool,
}

static GLOBAL_SERVICE: OnceLock<AgentChatService> = OnceLock::new();

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatStorageStatus {
    pub available: bool,
    pub schema_version: u32,
    pub error: Option<String>,
}

impl AgentChatService {
    pub fn new(app: AppHandle) -> Self {
        let mut state = ChatState::default();
        let (store, initial_storage_error) = match ChatStore::open(&app) {
            Ok(store) => {
                let loaded = store.load_threads().and_then(|mut threads| {
                    store.recover_threads(&mut threads)?;
                    Ok(threads)
                });
                match loaded {
                    Ok(threads) => {
                        for thread in threads {
                            state.order.push(thread.id.clone());
                            state.threads.insert(thread.id.clone(), thread);
                        }
                        if let Err(error) = store.cleanup_orphans() {
                            tracing::warn!(error = %error, "Agent Chat attachment cleanup will retry later");
                        }
                        (Some(store), None)
                    }
                    Err(error) => {
                        let visible =
                            super::persistence::recoverable_storage_error(&error, Some(&store));
                        tracing::error!(error = %visible, "Agent Chat history could not be loaded");
                        (Some(store), Some(visible))
                    }
                }
            }
            Err(error) => {
                let visible = super::persistence::recoverable_storage_error(&error, None);
                tracing::error!(error = %visible, "Agent Chat storage could not be opened");
                (None, Some(visible))
            }
        };
        Self {
            inner: Arc::new(ServiceInner {
                app,
                store,
                initial_storage_error,
                storage_fault: Mutex::new(None),
                state: Mutex::new(state),
                emission: Mutex::new(HashMap::new()),
                draft_promotion_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn install_global(&self) {
        let _ = GLOBAL_SERVICE.set(self.clone());
    }

    pub(super) fn app_handle(&self) -> AppHandle {
        self.inner.app.clone()
    }

    pub(super) fn insert_thread(&self, thread: ChatThread) -> Result<(), CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .persist_thread(&thread)
            .map_err(|error| self.remember_storage_fault(error))?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat service is unavailable"))?;
        state.order.insert(0, thread.id.clone());
        state.threads.insert(thread.id.clone(), thread.clone());
        drop(state);
        self.publish(thread, true);
        Ok(())
    }

    pub(super) fn list_threads(&self, project_id: &str) -> Result<Vec<ChatThread>, CommandError> {
        self.ensure_storage()?;
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat service is unavailable"))?;
        let mut threads = state
            .order
            .iter()
            .filter_map(|id| state.threads.get(id))
            .filter(|thread| thread.project_id == project_id)
            .cloned()
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| right.latest_activity_at.cmp(&left.latest_activity_at));
        for thread in &mut threads {
            trim_transcript(thread);
        }
        Ok(threads)
    }

    pub(super) fn refresh_checkout_statuses(
        &self,
        project_id: &str,
        available_checkouts: &HashMap<std::path::PathBuf, String>,
    ) -> Result<(), CommandError> {
        for thread in self.list_threads(project_id)? {
            let current_identity =
                available_checkouts.get(std::path::Path::new(&thread.checkout_path));
            let status = match current_identity {
                Some(identity)
                    if thread.checkout_status != "missing"
                        && !thread.checkout_identity.is_empty()
                        && thread.checkout_identity == *identity =>
                {
                    "available"
                }
                _ => "missing",
            };
            if thread.checkout_status != status {
                let updated = self.update_thread(&thread.id, true, |thread| {
                    thread.checkout_status = status.into();
                });
                if updated.is_none() {
                    self.ensure_storage()?;
                    return Err(CommandError::expected(
                        "The saved checkout availability could not be updated",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn ensure_project_identity(
        &self,
        git_common_dir: &std::path::Path,
        project_path: &std::path::Path,
        main_checkout_path: Option<&std::path::Path>,
    ) -> Result<String, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .ensure_project(git_common_dir, project_path, main_checkout_path)
    }

    pub(super) fn ensure_plain_project_identity(
        &self,
        project_path: &std::path::Path,
    ) -> Result<String, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .ensure_plain_project(project_path)
    }

    pub(super) fn pending_checkout_binding(
        &self,
        project_id: &str,
    ) -> Result<Option<(String, String)>, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .pending_checkout_binding(project_id)
    }

    pub(super) fn clear_pending_checkout_binding(
        &self,
        project_id: &str,
        identity: &str,
        checkout_path: &str,
    ) -> Result<(), CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .clear_pending_checkout_binding(project_id, identity, checkout_path)
    }

    pub(super) fn list_unlinked_projects(&self) -> Result<Vec<StoredProject>, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .list_unlinked_projects()
    }

    pub(super) fn relink_project(
        &self,
        project_id: &str,
        identity_key: &str,
        project_path: &std::path::Path,
        folder_instance_id: Option<&str>,
    ) -> Result<(), CommandError> {
        self.ensure_storage()?;
        let previous_path = self
            .inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .relink_project(project_id, identity_key, project_path, folder_instance_id)?;
        let plain_target = identity_key.starts_with("plain:");
        let new_path = project_path.to_string_lossy().into_owned();
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat service is unavailable"))?;
        let ids = state
            .threads
            .values()
            .filter(|thread| thread.project_id == project_id)
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let mut published = Vec::new();
        for id in ids {
            let previous = state.threads.get(&id).cloned();
            if let Some(mut thread) = previous {
                thread.project_path = new_path.clone();
                if plain_target
                    && thread.checkout_identity == project_id
                    && thread.checkout_path == previous_path
                {
                    thread.checkout_path = new_path.clone();
                    thread.checkout_status = "available".into();
                }
                thread.revision = thread.revision.saturating_add(1);
                state.threads.insert(id, thread.clone());
                published.push(thread);
            }
        }
        drop(state);
        for thread in published {
            self.publish(thread, true);
        }
        Ok(())
    }

    pub(super) fn draft_promotion_lock(
        &self,
        draft_id: &str,
    ) -> Result<Arc<AsyncMutex<()>>, CommandError> {
        let mut locks = self
            .inner
            .draft_promotion_locks
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat service is unavailable"))?;
        Ok(locks
            .entry(draft_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }

    pub(super) fn list_saved_drafts(
        &self,
        project_id: &str,
        checkout_identity: &str,
        limit: u32,
        offset: u32,
    ) -> Result<SavedChatDraftPage, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .list_saved_drafts(project_id, checkout_identity, limit, offset)
    }

    pub(super) fn stage_attachment(
        &self,
        app: &AppHandle,
        source_path: &str,
        project_id: &str,
    ) -> Result<ChatAttachment, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .stage_attachment(app, source_path, project_id)
    }

    pub(super) fn recheck_attachments(
        &self,
        project_id: &str,
        attachments: &[ChatAttachment],
    ) -> Result<Vec<ChatAttachment>, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .recheck_attachments(project_id, attachments)
    }

    pub(super) fn get_saved_draft(
        &self,
        project_id: &str,
        draft_id: &str,
    ) -> Result<Option<SavedChatDraft>, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .get_saved_draft(project_id, draft_id)
    }

    pub(super) fn save_project_draft(
        &self,
        draft: &SavedChatDraft,
    ) -> Result<SavedChatDraft, CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .save_project_draft(draft)
    }

    pub(super) fn delete_project_draft(
        &self,
        project_id: &str,
        draft_id: &str,
    ) -> Result<(), CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .delete_saved_draft(project_id, draft_id)
    }

    pub(super) fn promote_project_draft(
        &self,
        thread: ChatThread,
        draft_id: &str,
    ) -> Result<(ChatThread, bool), CommandError> {
        self.ensure_storage()?;
        let (thread_id, created) = self
            .inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .promote_saved_draft(&thread, draft_id)?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat service is unavailable"))?;
        if created {
            state.order.push(thread_id.clone());
            state.threads.insert(thread_id.clone(), thread.clone());
            drop(state);
            self.publish(thread.clone(), true);
            Ok((thread, true))
        } else {
            state
                .threads
                .get(&thread_id)
                .cloned()
                .map(|thread| (thread, false))
                .ok_or_else(|| {
                    CommandError::expected(
                        "The saved draft is already bound, but its chat thread is unavailable",
                    )
                })
        }
    }

    pub(super) fn storage_status(&self) -> AgentChatStorageStatus {
        let fault = self
            .inner
            .storage_fault
            .lock()
            .ok()
            .and_then(|fault| fault.clone());
        let error = self.inner.initial_storage_error.clone().or(fault);
        AgentChatStorageStatus {
            available: self.inner.store.is_some() && error.is_none(),
            schema_version: self
                .inner
                .store
                .as_ref()
                .map_or(0, ChatStore::schema_version),
            error,
        }
    }

    pub(super) fn ensure_storage(&self) -> Result<(), CommandError> {
        if let Some(error) = &self.inner.initial_storage_error {
            return Err(CommandError::Io {
                message: error.clone(),
            });
        }
        if let Some(error) = self
            .inner
            .storage_fault
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat storage is unavailable"))?
            .clone()
        {
            return Err(CommandError::Io { message: error });
        }
        if self.inner.store.is_none() {
            return Err(CommandError::expected("Agent Chat storage is unavailable"));
        }
        Ok(())
    }

    fn remember_storage_fault(&self, error: CommandError) -> CommandError {
        let visible = error.to_string();
        if let Ok(mut fault) = self.inner.storage_fault.lock() {
            *fault = Some(visible.clone());
        }
        error
    }

    pub(super) fn thread(&self, thread_id: &str) -> Option<ChatThread> {
        let mut thread = self
            .inner
            .state
            .lock()
            .ok()?
            .threads
            .get(thread_id)
            .cloned()?;
        trim_transcript(&mut thread);
        Some(thread)
    }

    pub(super) fn update_thread<F>(
        &self,
        thread_id: &str,
        urgent: bool,
        update: F,
    ) -> Option<ChatThread>
    where
        F: FnOnce(&mut ChatThread),
    {
        let snapshot = {
            let mut state = self.inner.state.lock().ok()?;
            let mut thread = state.threads.get(thread_id)?.clone();
            update(&mut thread);
            thread.unread = thread.activity_cursor > thread.read_cursor;
            thread.revision = thread.revision.saturating_add(1);
            if let Err(error) = self.persist_thread(&thread) {
                tracing::error!(thread_id, error = %error, "Agent Chat state could not be persisted");
                return None;
            }
            state.threads.insert(thread_id.to_string(), thread.clone());
            thread
        };
        self.publish(snapshot.clone(), urgent);
        let mut snapshot = snapshot;
        trim_transcript(&mut snapshot);
        Some(snapshot)
    }

    fn update_thread_activity<F>(
        &self,
        thread_id: &str,
        urgent: bool,
        event_key: &str,
        update: F,
    ) -> Option<ChatThread>
    where
        F: FnOnce(&mut ChatThread),
    {
        self.update_thread_activity_with_key(thread_id, urgent, Some(event_key), update)
    }

    fn update_thread_activity_unkeyed<F>(
        &self,
        thread_id: &str,
        urgent: bool,
        update: F,
    ) -> Option<ChatThread>
    where
        F: FnOnce(&mut ChatThread),
    {
        self.update_thread_activity_with_key(thread_id, urgent, None, update)
    }

    fn update_thread_activity_with_key<F>(
        &self,
        thread_id: &str,
        urgent: bool,
        event_key: Option<&str>,
        update: F,
    ) -> Option<ChatThread>
    where
        F: FnOnce(&mut ChatThread),
    {
        let snapshot = {
            let mut state = self.inner.state.lock().ok()?;
            let mut thread = state.threads.get(thread_id)?.clone();
            thread.activity_cursor = thread.activity_cursor.saturating_add(1);
            thread.latest_activity_at = Some(chrono::Utc::now().timestamp_millis());
            if thread.disposition == "settled"
                && thread
                    .settled_cursor
                    .is_some_and(|cursor| thread.activity_cursor > cursor)
            {
                thread.disposition = "active".into();
            }
            update(&mut thread);
            thread.unread = thread.activity_cursor > thread.read_cursor;
            thread.revision = thread.revision.saturating_add(1);
            let Some(store) = self.inner.store.as_ref() else {
                return None;
            };
            let persisted = match event_key {
                Some(event_key) => store.persist_thread_activity(&thread, event_key),
                None => store.persist_thread(&thread).map(|()| true),
            };
            match persisted {
                Ok(true) => {}
                Ok(false) => return None,
                Err(error) => {
                    let error = self.remember_storage_fault(error);
                    tracing::error!(thread_id, error = %error, "Agent Chat activity could not be persisted");
                    return None;
                }
            }
            state.threads.insert(thread_id.to_string(), thread.clone());
            thread
        };
        self.publish(snapshot.clone(), urgent);
        let mut snapshot = snapshot;
        trim_transcript(&mut snapshot);
        Some(snapshot)
    }

    pub(super) fn reconcile_provider_history(
        &self,
        thread_id: &str,
        provider_items: Vec<ChatItem>,
        reconciliation: Option<&ChatSendReconciliation>,
    ) -> Option<ChatThread> {
        let snapshot = {
            let mut state = self.inner.state.lock().ok()?;
            let mut thread = state.threads.get(thread_id)?.clone();
            let mut protected_user_item_id = None;
            if let Some(reconciliation) = reconciliation {
                if let Some(turn) = thread
                    .turns
                    .iter_mut()
                    .find(|turn| turn.id == reconciliation.attempt_id)
                {
                    if reconciliation.outcome == "confirmedPresent" {
                        if let Some(provider_turn_id) = reconciliation.provider_turn_id.as_ref() {
                            turn.provider_turn_id = Some(provider_turn_id.clone());
                            if let Some(user_item) = thread
                                .items
                                .iter_mut()
                                .find(|item| item.id == turn.user_item_id)
                            {
                                user_item.turn_id = Some(provider_turn_id.clone());
                            }
                        }
                    } else {
                        protected_user_item_id = Some(turn.user_item_id.clone());
                    }
                }
            }
            let changed_meaningful = merge_provider_history(
                &mut thread.items,
                provider_items,
                protected_user_item_id.as_deref(),
            );
            if changed_meaningful {
                thread.activity_cursor = thread.activity_cursor.saturating_add(1);
                thread.latest_activity_at = Some(chrono::Utc::now().timestamp_millis());
                if thread.disposition == "settled"
                    && thread
                        .settled_cursor
                        .is_some_and(|cursor| thread.activity_cursor > cursor)
                {
                    thread.disposition = "active".into();
                }
            }
            thread.unread = thread.activity_cursor > thread.read_cursor;
            thread.revision = thread.revision.saturating_add(1);
            if let Err(error) = self.persist_thread(&thread) {
                tracing::error!(thread_id, error = %error, "Reconciled Agent Chat history could not be persisted");
                return None;
            }
            state.threads.insert(thread_id.to_string(), thread.clone());
            thread
        };
        self.publish(snapshot.clone(), true);
        let mut snapshot = snapshot;
        trim_transcript(&mut snapshot);
        Some(snapshot)
    }

    fn persist_thread(&self, thread: &ChatThread) -> Result<(), CommandError> {
        self.ensure_storage()?;
        self.inner
            .store
            .as_ref()
            .ok_or_else(|| CommandError::expected("Agent Chat storage is unavailable"))?
            .persist_thread(thread)
            .map_err(|error| self.remember_storage_fault(error))
    }

    pub(super) fn is_uncertain_turn(&self, thread_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .ok()
            .and_then(|state| state.uncertain_turns.get(thread_id).copied())
            .unwrap_or(false)
    }

    pub(super) fn clear_uncertain_turn(&self, thread_id: &str) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.uncertain_turns.remove(thread_id);
        }
    }

    pub(super) fn clear_pending_requests(&self, thread_id: &str) {
        if let Ok(mut state) = self.inner.state.lock() {
            state
                .pending_requests
                .retain(|(pending_thread_id, _), _| pending_thread_id != thread_id);
            state
                .request_correlations
                .retain(|key, _| key.thread_id != thread_id);
            state
                .seen_server_request_ids
                .retain(|key| key.thread_id != thread_id);
        }
    }

    pub(super) fn mark_uncertain_turn(&self, thread_id: &str) -> bool {
        if let Ok(mut state) = self.inner.state.lock() {
            let Some(thread) = state.threads.get(thread_id) else {
                return false;
            };
            if matches!(thread.status.as_str(), "running" | "waiting" | "idle")
                || thread.turn_id.is_some()
            {
                return false;
            }
            state.uncertain_turns.insert(thread_id.to_string(), true);
            return true;
        }
        false
    }

    pub(super) fn claim_turn(
        &self,
        thread_id: &str,
        attempt_id: String,
        user_item: ChatItem,
        settings: ChatSettings,
        baseline_last_item_id: Option<String>,
    ) -> Option<ChatThread> {
        let snapshot = {
            let mut state = self.inner.state.lock().ok()?;
            if state.uncertain_turns.contains_key(thread_id) {
                return None;
            }
            let mut thread = state.threads.get(thread_id)?.clone();
            if !matches!(thread.status.as_str(), "idle" | "interrupted" | "error")
                || thread.provider_thread_id.is_none()
                || thread.provider_status == "active"
            {
                return None;
            }
            if thread.turns.last().is_some_and(|turn| {
                matches!(turn.outcome.as_str(), "claimed" | "sending")
                    || (matches!(turn.outcome.as_str(), "uncertain" | "interrupted")
                        && turn
                            .reconciliation
                            .as_ref()
                            .is_none_or(|result| result.outcome == "ambiguous"))
            }) {
                return None;
            }
            let now = chrono::Utc::now().timestamp_millis();
            thread.turns.push(ChatTurnRecord {
                id: attempt_id,
                provider_turn_id: None,
                user_item_id: user_item.id.clone(),
                outcome: "claimed".into(),
                settings: settings.clone(),
                approval_policy: thread.approval_policy.clone(),
                sandbox_policy: thread.sandbox_policy.clone(),
                baseline_known: true,
                baseline_last_item_id,
                reconciliation: None,
                started_at: now,
                finished_at: None,
            });
            thread.status = "starting".into();
            thread.turn_id = None;
            thread.error = None;
            thread.disposition = "active".into();
            thread.latest_activity_at = Some(chrono::Utc::now().timestamp_millis());
            thread.settings = settings;
            if thread.title_source == "draft" {
                thread.title =
                    deterministic_title(&user_item.text, !user_item.attachments.is_empty());
                thread.title_source = "prompt".into();
            }
            thread.draft = ChatDraft::default();
            thread.items.push(user_item);
            thread.revision = thread.revision.saturating_add(1);
            thread.unread = thread.activity_cursor > thread.read_cursor;
            if let Err(error) = self.persist_thread(&thread) {
                tracing::error!(thread_id, error = %error, "Accepted Agent Chat message could not be persisted");
                return None;
            }
            state.threads.insert(thread_id.to_string(), thread.clone());
            thread
        };
        self.publish(snapshot.clone(), true);
        Some(snapshot)
    }

    pub(super) fn update_turn_attempt<F>(
        &self,
        thread_id: &str,
        attempt_id: &str,
        update: F,
    ) -> Option<ChatThread>
    where
        F: FnOnce(&mut ChatTurnRecord),
    {
        self.update_thread(thread_id, true, |thread| {
            if let Some(turn) = thread.turns.iter_mut().find(|turn| turn.id == attempt_id) {
                update(turn);
            }
        })
    }

    pub(super) fn reconcile_send_attempt(
        &self,
        thread_id: &str,
        provider_items: &[ChatItem],
        provider_status: &str,
    ) -> Option<ChatSendReconciliation> {
        let thread = self.thread(thread_id)?;
        let turn = thread.turns.last()?;
        if let Some(reconciliation) = turn.reconciliation.clone() {
            if reconciliation.outcome != "ambiguous" {
                return Some(reconciliation);
            }
        }
        let user_item = thread
            .items
            .iter()
            .find(|item| item.id == turn.user_item_id)?;
        let reconciliation =
            reconcile_turn_attempt(turn, user_item, provider_items, provider_status);
        let outcome = reconciliation.outcome.as_str();

        let attempt_id = turn.id.clone();
        let reconciliation_for_record = reconciliation.clone();
        self.update_thread(thread_id, true, |thread| {
            if let Some(turn) = thread.turns.iter_mut().find(|turn| turn.id == attempt_id) {
                turn.reconciliation = Some(reconciliation_for_record);
                if outcome == "confirmedPresent" {
                    if let Some(provider_turn_id) = reconciliation.provider_turn_id.as_ref() {
                        turn.provider_turn_id = Some(provider_turn_id.clone());
                    }
                }
            }
            if outcome == "confirmedAbsent" {
                thread.status = "idle".into();
                thread.error = None;
            }
        })?;
        Some(reconciliation)
    }

    pub(super) fn ensure_send_attempt_is_safe(
        &self,
        thread_id: &str,
        text: &str,
        attachments: &[ChatAttachment],
    ) -> Result<(), CommandError> {
        let Some(thread) = self.thread(thread_id) else {
            return Err(CommandError::expected("The chat thread is unavailable"));
        };
        let Some(turn) = thread.turns.last() else {
            return Ok(());
        };
        if !matches!(
            turn.outcome.as_str(),
            "claimed" | "sending" | "uncertain" | "interrupted"
        ) {
            return Ok(());
        }
        match turn.reconciliation.as_ref().map(|result| result.outcome.as_str()) {
            Some("confirmedAbsent") => Ok(()),
            Some("confirmedPresent") => {
                let previous = thread.items.iter().find(|item| item.id == turn.user_item_id);
                let attachments_match = previous.is_some_and(|item| {
                    item.attachments.len() == attachments.len()
                        && item
                            .attachments
                            .iter()
                            .zip(attachments)
                            .all(|(old, new)| old.id == new.id)
                });
                if previous.is_some_and(|item| item.text == text) && attachments_match {
                    Err(CommandError::expected(
                        "Codex history confirms this prompt was accepted. Edit the prompt or attachment selection before sending another turn.",
                    ))
                } else {
                    Ok(())
                }
            }
            _ => Err(CommandError::expected(
                "Codex history could not confirm the previous send attempt. Check history before sending again.",
            )),
        }
    }

    pub(super) fn insert_runtime(&self, thread_id: &str, runtime: RuntimeControl) {
        if let Ok(mut state) = self.inner.state.lock() {
            let previous_generation = state
                .runtimes
                .get(thread_id)
                .map(|previous| previous.generation.clone());
            if let Some(previous_generation) = previous_generation {
                if previous_generation != runtime.generation {
                    clear_runtime_requests(&mut state, thread_id, &previous_generation);
                }
            }
            state.runtimes.insert(thread_id.to_string(), runtime);
        }
    }

    pub(super) fn runtime(&self, thread_id: &str) -> Option<RuntimeControl> {
        self.inner
            .state
            .lock()
            .ok()
            .and_then(|state| state.runtimes.get(thread_id).cloned())
    }

    pub(super) fn remove_runtime(&self, thread_id: &str) -> Option<RuntimeControl> {
        self.inner.state.lock().ok().and_then(|mut state| {
            let runtime = state.runtimes.remove(thread_id)?;
            clear_runtime_requests(&mut state, thread_id, &runtime.generation);
            Some(runtime)
        })
    }

    fn remove_runtime_if_generation(&self, thread_id: &str, runtime_generation: &str) -> bool {
        let Ok(mut state) = self.inner.state.lock() else {
            return false;
        };
        if state
            .runtimes
            .get(thread_id)
            .is_none_or(|runtime| runtime.generation != runtime_generation)
        {
            return false;
        }
        state.runtimes.remove(thread_id);
        clear_runtime_requests(&mut state, thread_id, runtime_generation);
        true
    }

    fn is_current_runtime(&self, thread_id: &str, runtime_generation: &str) -> bool {
        self.inner
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .runtimes
                    .get(thread_id)
                    .map(|runtime| runtime.generation == runtime_generation)
            })
            .unwrap_or(false)
    }

    pub(super) async fn register_pending_rpc(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        id: String,
        sender: oneshot::Sender<Result<Value, String>>,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Chat service is unavailable".to_string())?;
        let key = (thread_id.to_string(), runtime_generation.to_string(), id);
        if state.pending_rpcs.contains_key(&key) {
            return Err("A Codex request with this identifier is already pending".into());
        }
        state.pending_rpcs.insert(key, sender);
        Ok(())
    }

    pub(super) async fn remove_pending_rpc(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        id: &str,
    ) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.pending_rpcs.remove(&(
                thread_id.to_string(),
                runtime_generation.to_string(),
                id.to_string(),
            ));
        }
    }

    pub(super) async fn route_protocol_message(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        message: Value,
        outbound: mpsc::Sender<Value>,
    ) {
        if !self.is_current_runtime(thread_id, runtime_generation) {
            return;
        }
        let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() else {
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                self.route_notification(
                    thread_id,
                    runtime_generation,
                    method,
                    message.get("params").unwrap_or(&Value::Null),
                );
            }
            return;
        };

        if let Some(method) = message.get("method").and_then(Value::as_str) {
            self.route_server_request(
                thread_id,
                runtime_generation,
                &id,
                method,
                message.get("params").unwrap_or(&Value::Null),
                outbound,
            )
            .await;
            return;
        }

        let Some(request_id) = protocol_request_id_key(&id) else {
            return;
        };
        let key = (
            thread_id.to_string(),
            runtime_generation.to_string(),
            request_id,
        );
        let sender = self
            .inner
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_rpcs.remove(&key));
        if let Some(sender) = sender {
            let result = if let Some(error) = message.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(-1);
                let summary = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(safe_protocol_diagnostic)
                    .unwrap_or("The provider rejected the request");
                Err(format!(
                    "Codex returned a protocol error ({code}): {summary}"
                ))
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
        }
    }

    async fn route_server_request(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        rpc_id: &Value,
        method: &str,
        params: &Value,
        outbound: mpsc::Sender<Value>,
    ) {
        let Some(request_id_key) = protocol_request_id_key(rpc_id) else {
            self.reject_server_request(
                thread_id,
                runtime_generation,
                rpc_id,
                method,
                "Codex used an invalid request identifier",
                outbound,
            )
            .await;
            return;
        };
        let Some(provider_thread_id) = self
            .thread(thread_id)
            .and_then(|thread| thread.provider_thread_id)
        else {
            self.reject_server_request(
                thread_id,
                runtime_generation,
                rpc_id,
                method,
                "The originating Codex conversation is unavailable",
                outbound,
            )
            .await;
            return;
        };
        let correlation_key = ServerRequestCorrelationKey {
            thread_id: thread_id.to_string(),
            runtime_generation: runtime_generation.to_string(),
            provider_thread_id,
            request_id: request_id_key,
        };
        let request_id_claim = if let Ok(mut state) = self.inner.state.lock() {
            if state.seen_server_request_ids.contains(&correlation_key) {
                return;
            }
            let seen_for_runtime = state
                .seen_server_request_ids
                .iter()
                .filter(|key| {
                    key.thread_id == thread_id && key.runtime_generation == runtime_generation
                })
                .count();
            if seen_for_runtime >= MAX_SERVER_REQUEST_IDS_PER_RUNTIME {
                false
            } else {
                state
                    .seen_server_request_ids
                    .insert(correlation_key.clone());
                true
            }
        } else {
            false
        };
        if !request_id_claim {
            let _ = outbound
                .send(rpc_error(
                    rpc_id.clone(),
                    -32603,
                    "This Codex process has exceeded the supported number of interactive requests",
                ))
                .await;
            return;
        }

        let Some((kind, title)) = classify_request(method, params) else {
            self.reject_server_request(
                thread_id,
                runtime_generation,
                rpc_id,
                method,
                "This interactive request is not supported",
                outbound,
            )
            .await;
            return;
        };
        let params = match visible_request_params(params) {
            Ok(params) => params,
            Err(reason) => {
                self.reject_server_request(
                    thread_id,
                    runtime_generation,
                    rpc_id,
                    method,
                    &reason,
                    outbound,
                )
                .await;
                return;
            }
        };
        let auto_accept_enabled = self
            .thread(thread_id)
            .is_some_and(|thread| thread.settings.auto_accept_mode);
        if should_auto_accept_approval(auto_accept_enabled, method, &params) {
            if outbound
                .send(rpc_result(rpc_id.clone(), json!({ "decision": "accept" })))
                .await
                .is_ok()
            {
                let public_id = display_request_id(thread_id, runtime_generation, rpc_id);
                let event_key = activity_event_key(
                    thread_id,
                    "auto-approval-accepted",
                    &json!({ "runtimeGeneration": runtime_generation, "requestId": public_id }),
                );
                self.append_activity_item(
                    thread_id,
                    ChatItem {
                        id: format!("auto-approval:{public_id}"),
                        turn_id: self.thread(thread_id).and_then(|thread| thread.turn_id),
                        kind: "activity".into(),
                        text: "Approval accepted automatically for this conversation.".into(),
                        status: Some("completed".into()),
                        attachments: Vec::new(),
                    },
                    true,
                    &event_key,
                );
                return;
            }
        }
        let public_id = display_request_id(thread_id, runtime_generation, rpc_id);
        let request = ChatRequest {
            id: public_id.clone(),
            method: method.to_string(),
            kind: kind.to_string(),
            title,
            params,
        };
        let event_key = activity_event_key(
            thread_id,
            method,
            &json!({
                "runtimeGeneration": runtime_generation,
                "rpcId": rpc_id,
                "params": request.params.clone()
            }),
        );
        let persisted = self
            .update_thread_activity(thread_id, true, &event_key, |thread| {
                if !thread
                    .requests
                    .iter()
                    .any(|existing| existing.id == request.id)
                {
                    thread.requests.push(request.clone());
                }
                thread.status = "waiting".into();
                thread.error = None;
            })
            .is_some();
        let already_pending = self.pending_request(thread_id, &public_id).is_some();
        if persisted || already_pending {
            if let Ok(mut state) = self.inner.state.lock() {
                state
                    .pending_requests
                    .entry((thread_id.to_string(), public_id))
                    .or_insert(PendingServerRequest {
                        rpc_id: rpc_id.clone(),
                        request,
                        runtime_generation: runtime_generation.to_string(),
                    });
                state
                    .request_correlations
                    .entry(correlation_key)
                    .or_insert_with(|| display_request_id(thread_id, runtime_generation, rpc_id));
            }
        } else {
            let _ = outbound
                .send(rpc_error(
                    rpc_id.clone(),
                    -32603,
                    "Ship Studio could not save this request, so it was rejected",
                ))
                .await;
        }
    }

    async fn reject_server_request(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        rpc_id: &Value,
        method: &str,
        reason: &str,
        outbound: mpsc::Sender<Value>,
    ) {
        let _ = outbound
            .send(rpc_error(rpc_id.clone(), -32601, reason))
            .await;
        let safe_method = safe_protocol_method(method);
        let event_key = activity_event_key(
            thread_id,
            "unsupported-request",
            &json!({
                "runtimeGeneration": runtime_generation,
                "rpcId": rpc_id,
                "method": safe_method,
                "reason": reason
            }),
        );
        self.append_activity_item(
            thread_id,
            ChatItem {
                id: format!("unsupported-request:{}", &event_key[..16]),
                turn_id: self.thread(thread_id).and_then(|thread| thread.turn_id),
                kind: "error".into(),
                text: format!("Codex request `{safe_method}` was rejected: {reason}."),
                status: Some("failed".into()),
                attachments: Vec::new(),
            },
            true,
            &event_key,
        );
    }

    fn route_notification(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        method: &str,
        params: &Value,
    ) {
        match method {
            "serverRequest/resolved" => {
                self.handle_server_request_resolved(thread_id, runtime_generation, params);
            }
            "turn/started" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let event_key = activity_event_key(thread_id, method, params);
                if self
                    .update_thread_activity(thread_id, true, &event_key, |thread| {
                        thread.turn_id = turn_id.clone();
                        if let Some(user_item) = thread
                            .items
                            .iter_mut()
                            .rev()
                            .find(|item| item.kind == "user" && item.turn_id.is_none())
                        {
                            user_item.turn_id = turn_id.clone();
                        }
                        if let Some(turn) = thread
                            .turns
                            .iter_mut()
                            .rev()
                            .find(|turn| matches!(turn.outcome.as_str(), "claimed" | "sending"))
                        {
                            turn.provider_turn_id = turn_id.clone();
                            turn.outcome = "running".into();
                        }
                        thread.status = "running".into();
                        thread.provider_status = "active".into();
                        thread.error = None;
                    })
                    .is_some()
                {
                    if let Ok(mut state) = self.inner.state.lock() {
                        state.uncertain_turns.remove(thread_id);
                    }
                }
            }
            "turn/completed" => {
                self.handle_turn_completed(thread_id, runtime_generation, params);
            }
            "item/started" | "item/completed" => {
                let status = if method == "item/started" {
                    "running"
                } else {
                    "completed"
                };
                let turn_id = params.get("turnId").and_then(Value::as_str);
                if let Some(item) = params
                    .get("item")
                    .and_then(|item| normalize_item(item, turn_id, status))
                {
                    let event_key = activity_event_key(thread_id, method, params);
                    if is_meaningful_item(&item) {
                        self.upsert_activity_item(
                            thread_id,
                            item,
                            method == "item/completed",
                            &event_key,
                        );
                    } else {
                        self.upsert_item(thread_id, item, method == "item/completed");
                    }
                }
            }
            "item/agentMessage/delta" => {
                self.append_delta(thread_id, method, params, "assistant", "assistant");
            }
            "item/commandExecution/outputDelta" => {
                self.append_delta(thread_id, method, params, "tool", "tool")
            }
            "item/fileChange/outputDelta" => {
                self.append_delta(thread_id, method, params, "fileChange", "tool")
            }
            "item/reasoning/summaryTextDelta" => {
                self.append_delta(thread_id, method, params, "reasoning", "reasoning")
            }
            "item/fileChange/patchUpdated" => {
                let item_id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("file-change");
                let text = summarize_file_changes(params.get("changes"));
                let event_key = activity_event_key(thread_id, method, params);
                self.upsert_activity_item(
                    thread_id,
                    ChatItem {
                        id: item_id.to_string(),
                        turn_id: params
                            .get("turnId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        kind: "fileChange".into(),
                        text,
                        status: Some("running".into()),
                        attachments: Vec::new(),
                    },
                    false,
                    &event_key,
                );
            }
            "item/mcpToolCall/progress" => {
                let id = params
                    .get("itemId")
                    .or_else(|| params.get("callId"))
                    .and_then(Value::as_str)
                    .unwrap_or("mcp-tool");
                let label = params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("MCP tool is running");
                let event_key = activity_event_key(thread_id, method, params);
                self.upsert_activity_item(
                    thread_id,
                    ChatItem {
                        id: id.to_string(),
                        turn_id: params
                            .get("turnId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        kind: "tool".into(),
                        text: label.to_string(),
                        status: Some("running".into()),
                        attachments: Vec::new(),
                    },
                    false,
                    &event_key,
                );
            }
            "turn/plan/updated" => {
                let plan = summarize_plan(params);
                let turn_id = params.get("turnId").and_then(Value::as_str);
                let id = turn_id
                    .map(|id| format!("plan:{id}"))
                    .unwrap_or_else(|| "plan".into());
                let event_key = activity_event_key(thread_id, method, params);
                self.upsert_activity_item(
                    thread_id,
                    ChatItem {
                        id,
                        turn_id: turn_id.map(str::to_string),
                        kind: "plan".into(),
                        text: plan,
                        status: Some("running".into()),
                        attachments: Vec::new(),
                    },
                    false,
                    &event_key,
                );
            }
            "error" => {
                let event_key = activity_event_key(thread_id, method, params);
                self.append_activity_item(
                    thread_id,
                    ChatItem {
                        id: format!(
                            "provider-error:{}",
                            params
                                .get("turnId")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                        ),
                        turn_id: params
                            .get("turnId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        kind: "error".into(),
                        text: "Codex reported an error while processing this turn.".into(),
                        status: Some("failed".into()),
                        attachments: Vec::new(),
                    },
                    true,
                    &event_key,
                );
            }
            "thread/status/changed"
            | "thread/readState/changed"
            | "thread/tokenUsage/updated"
            | "thread/name/updated"
            | "thread/attachment/updated"
            | "thread/goal/updated"
            | "thread/goal/cleared"
            | "thread/queue/changed"
            | "thread/project/updated"
            | "thread/environment/connected"
            | "thread/environment/disconnected"
            | "thread/settings/updated"
            | "skills/changed"
            | "account/updated"
            | "account/rateLimits/updated"
            | "fs/changed"
            | "hook/started"
            | "hook/completed"
            | "rawResponseItem/completed"
            | "rawResponse/completed"
            | "item/reasoning/textDelta" => {}
            _ => self.record_unknown_notification(thread_id, runtime_generation, method),
        }
    }

    fn handle_server_request_resolved(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        params: &Value,
    ) {
        let Some(provider_thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let Some(request_id) = params.get("requestId") else {
            return;
        };
        let Some(key) = ServerRequestCorrelationKey::new(
            thread_id,
            runtime_generation,
            provider_thread_id,
            request_id,
        ) else {
            return;
        };
        let public_id = self
            .inner
            .state
            .lock()
            .ok()
            .and_then(|mut state| resolve_server_request(&mut state, &key));
        let Some(public_id) = public_id else {
            return;
        };
        let has_visible_request = self.thread(thread_id).is_some_and(|thread| {
            thread
                .requests
                .iter()
                .any(|request| request.id == public_id)
        });
        if !has_visible_request {
            return;
        }
        let event_key = activity_event_key(
            thread_id,
            "serverRequest/resolved",
            &json!({ "runtimeGeneration": runtime_generation, "requestId": key.request_id }),
        );
        self.update_thread_activity(thread_id, true, &event_key, |thread| {
            thread.requests.retain(|request| request.id != public_id);
            if thread.status == "waiting" && thread.requests.is_empty() {
                thread.status = "running".into();
            }
        });
    }

    fn record_unknown_notification(&self, thread_id: &str, runtime_generation: &str, method: &str) {
        let is_first = self.inner.state.lock().is_ok_and(|mut state| {
            claim_unknown_notification(&mut state, thread_id, runtime_generation)
        });
        if !is_first {
            return;
        }
        let method = safe_protocol_method(method);
        let event_key = activity_event_key(
            thread_id,
            "unhandled-notification",
            &json!({ "runtimeGeneration": runtime_generation }),
        );
        self.append_activity_item(
            thread_id,
            ChatItem {
                id: format!("protocol-notice:{runtime_generation}"),
                turn_id: self.thread(thread_id).and_then(|thread| thread.turn_id),
                kind: "activity".into(),
                text: format!(
                    "Codex sent an update ({method}) that this version of Ship Studio does not display."
                ),
                status: None,
                attachments: Vec::new(),
            },
            false,
            &event_key,
        );
    }

    fn handle_turn_completed(&self, thread_id: &str, runtime_generation: &str, params: &Value) {
        let turn = params.get("turn").unwrap_or(&Value::Null);
        let turn_id = turn.get("id").and_then(Value::as_str).map(str::to_string);
        let status = match turn.get("status").and_then(Value::as_str) {
            Some("completed") => "idle",
            Some("interrupted") => "interrupted",
            Some("failed") => "error",
            _ => "error",
        }
        .to_string();
        let error_text = if status == "error" {
            Some("Codex could not complete this turn.".to_string())
        } else {
            None
        };
        let mut final_items = Vec::new();
        if let Some(items) = turn.get("items").and_then(Value::as_array) {
            for item in items {
                if let Some(item) = normalize_item(item, turn_id.as_deref(), "completed") {
                    final_items.push(item);
                }
            }
        }
        let event_key = activity_event_key(thread_id, "turn/completed", params);
        self.update_thread_activity(thread_id, true, &event_key, |thread| {
            thread.turn_id = None;
            thread.status = status;
            thread.provider_status = if thread.status == "error" {
                "systemError".into()
            } else {
                "idle".into()
            };
            thread.resume_status = "available".into();
            thread.error = error_text.clone();
            if let Some(turn_record) = thread.turns.iter_mut().rev().find(|record| {
                turn_id
                    .as_ref()
                    .is_some_and(|id| record.provider_turn_id.as_ref() == Some(id))
                    || matches!(
                        record.outcome.as_str(),
                        "claimed" | "sending" | "running" | "uncertain"
                    )
            }) {
                if turn_record.provider_turn_id.is_none() {
                    turn_record.provider_turn_id = turn_id.clone();
                }
                turn_record.outcome = match turn.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("interrupted") => "interrupted",
                    _ => "failed",
                }
                .into();
                turn_record.finished_at = Some(chrono::Utc::now().timestamp_millis());
            }
            for item in final_items {
                upsert(&mut thread.items, item);
            }
            thread.requests.clear();
            if let Some(error) = error_text.clone() {
                thread.items.push(ChatItem {
                    id: format!("turn-error:{}", turn_id.as_deref().unwrap_or("unknown")),
                    turn_id: turn_id.clone(),
                    kind: "error".into(),
                    text: error,
                    status: Some("failed".into()),
                    attachments: Vec::new(),
                });
            }
        });
        if let Ok(mut state) = self.inner.state.lock() {
            state.uncertain_turns.remove(thread_id);
            clear_runtime_requests(&mut state, thread_id, runtime_generation);
        }
    }

    fn append_delta(
        &self,
        thread_id: &str,
        _method: &str,
        params: &Value,
        kind: &str,
        fallback: &str,
    ) {
        let Some(delta) = params.get("delta").and_then(Value::as_str) else {
            return;
        };
        if delta.is_empty() {
            return;
        }
        let id = params
            .get("itemId")
            .and_then(Value::as_str)
            .unwrap_or(fallback);
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_string);
        // The protocol provides no delta sequence number. Identical adjacent
        // chunks can be legitimate repeated text, so hash based replay
        // suppression would silently drop content. Final stable items from
        // item/completed and paged thread history replace this stream copy.
        self.update_thread_activity_unkeyed(thread_id, false, |thread| {
            append_item_delta(&mut thread.items, id, turn_id, kind, delta);
        });
    }

    fn upsert_item(&self, thread_id: &str, item: ChatItem, urgent: bool) {
        self.update_thread(thread_id, urgent, |thread| upsert(&mut thread.items, item));
    }

    fn append_activity_item(&self, thread_id: &str, item: ChatItem, urgent: bool, event_key: &str) {
        self.update_thread_activity(thread_id, urgent, event_key, |thread| {
            if !thread.items.iter().any(|existing| existing.id == item.id) {
                thread.items.push(item);
            }
        });
    }

    fn upsert_activity_item(&self, thread_id: &str, item: ChatItem, urgent: bool, event_key: &str) {
        self.update_thread_activity(thread_id, urgent, event_key, |thread| {
            upsert(&mut thread.items, item)
        });
    }

    pub(super) async fn process_exited(
        &self,
        thread_id: &str,
        runtime_generation: &str,
        planned: bool,
        message: &str,
    ) {
        let was_current = self.remove_runtime_if_generation(thread_id, runtime_generation);
        let failed_rpcs = if let Ok(mut state) = self.inner.state.lock() {
            let keys = state
                .pending_rpcs
                .keys()
                .filter_map(|(pending_thread_id, pending_generation, id)| {
                    (pending_thread_id == thread_id && pending_generation == runtime_generation)
                        .then_some((
                            pending_thread_id.clone(),
                            pending_generation.clone(),
                            id.clone(),
                        ))
                })
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| state.pending_rpcs.remove(&key))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for sender in failed_rpcs {
            let _ = sender.send(Err(
                "Codex app-server disconnected before acknowledging the request".into(),
            ));
        }
        if planned || !was_current {
            return;
        }
        let event_key =
            activity_event_key(thread_id, "runtime-exited", &json!({ "message": message }));
        if self.thread(thread_id).is_some_and(|thread| {
            matches!(thread.status.as_str(), "running" | "waiting" | "starting")
        }) {
            self.update_thread_activity(thread_id, true, &event_key, |thread| {
                if matches!(thread.status.as_str(), "running" | "waiting" | "starting") {
                    thread.status = "error".into();
                    thread.resume_status = "unknown".into();
                    thread.provider_status = "unknown".into();
                    thread.error = Some(if message.starts_with("Codex app-server returned") {
                        message.to_string()
                    } else {
                        "Codex app-server disconnected while this conversation was active.".into()
                    });
                    thread.requests.clear();
                    if let Some(turn) = thread.turns.iter_mut().rev().find(|turn| {
                        matches!(turn.outcome.as_str(), "claimed" | "sending" | "running")
                    }) {
                        turn.outcome = "uncertain".into();
                        turn.finished_at = Some(chrono::Utc::now().timestamp_millis());
                    }
                    thread.turn_id = None;
                    thread.items.push(ChatItem {
                        id: format!("runtime-error:{}", thread.id),
                        turn_id: None,
                        kind: "error".into(),
                        text: thread
                            .error
                            .clone()
                            .unwrap_or_else(|| "Codex disconnected".into()),
                        status: Some("failed".into()),
                        attachments: Vec::new(),
                    });
                }
            });
        }
    }

    fn publish(&self, snapshot: ChatThread, urgent: bool) {
        let mut snapshot = snapshot;
        trim_transcript(&mut snapshot);
        let mut emit_now = false;
        let mut schedule = false;
        if let Ok(mut states) = self.inner.emission.lock() {
            let state = states.entry(snapshot.id.clone()).or_default();
            if urgent
                || state
                    .last_emit
                    .is_none_or(|last| last.elapsed() >= DELTA_EVENT_INTERVAL)
            {
                state.last_emit = Some(Instant::now());
                state.scheduled = false;
                emit_now = true;
            } else if !state.scheduled {
                state.scheduled = true;
                schedule = true;
            }
        }
        if emit_now {
            self.emit(&snapshot);
        } else if schedule {
            let service = self.clone();
            let id = snapshot.id;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(DELTA_EVENT_INTERVAL).await;
                service.flush_event(&id);
            });
        }
    }

    fn flush_event(&self, thread_id: &str) {
        let snapshot = self.thread(thread_id);
        if let Ok(mut states) = self.inner.emission.lock() {
            if let Some(state) = states.get_mut(thread_id) {
                state.scheduled = false;
                state.last_emit = Some(Instant::now());
            }
        }
        if let Some(snapshot) = snapshot {
            self.emit(&snapshot);
        }
    }

    fn emit(&self, snapshot: &ChatThread) {
        if let Err(error) = self.inner.app.emit(EVENT_NAME, snapshot) {
            tracing::debug!(error = %error, "Could not emit an agent chat snapshot");
        }
    }

    pub(super) async fn stop_threads(&self, ids: Vec<String>, reason: &str, unavailable: bool) {
        for thread_id in ids {
            let uncertain = self.is_uncertain_turn(&thread_id);
            self.update_thread(&thread_id, true, |thread| {
                let interrupted_record = mark_unfinished_turns_interrupted(
                    thread,
                    chrono::Utc::now().timestamp_millis(),
                );
                if uncertain
                    || interrupted_record
                    || matches!(thread.status.as_str(), "running" | "waiting" | "starting")
                {
                    thread.status = "interrupted".into();
                    thread.resume_status = "unknown".into();
                    thread.provider_status = "unknown".into();
                    thread.turn_id = None;
                    thread.requests.clear();
                    thread.error = Some(reason.to_string());
                    thread.items.push(ChatItem {
                        id: format!("lifecycle:{}", uuid::Uuid::new_v4()),
                        turn_id: None,
                        kind: if unavailable {
                            "error".into()
                        } else {
                            "activity".into()
                        },
                        text: reason.to_string(),
                        status: Some("interrupted".into()),
                        attachments: Vec::new(),
                    });
                }
            });
            if let Ok(mut state) = self.inner.state.lock() {
                state
                    .pending_requests
                    .retain(|(pending_thread_id, _), _| pending_thread_id != &thread_id);
                state
                    .request_correlations
                    .retain(|key, _| key.thread_id != thread_id);
                state
                    .seen_server_request_ids
                    .retain(|key| key.thread_id != thread_id);
                state.uncertain_turns.remove(&thread_id);
            }
            if let Some(runtime) = self.remove_runtime(&thread_id) {
                runtime.stop(reason.to_string()).await;
            }
        }
    }

    pub(super) fn shutdown_all_sync(&self) {
        let ids = self
            .inner
            .state
            .lock()
            .map(|state| state.threads.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for thread_id in &ids {
            self.update_thread(thread_id, true, |thread| {
                let was_active =
                    matches!(thread.status.as_str(), "running" | "waiting" | "starting");
                let interrupted_record = mark_unfinished_turns_interrupted(
                    thread,
                    chrono::Utc::now().timestamp_millis(),
                );
                if was_active || interrupted_record {
                    thread.status = "interrupted".into();
                    thread.resume_status = "unknown".into();
                    thread.provider_status = "unknown".into();
                    thread.turn_id = None;
                    thread.requests.clear();
                    thread.error =
                        Some("Ship Studio closed and stopped this Codex process.".into());
                }
            });
        }
        if let Ok(mut state) = self.inner.state.lock() {
            let runtimes = std::mem::take(&mut state.runtimes);
            state.pending_rpcs.clear();
            state.pending_requests.clear();
            state.request_correlations.clear();
            state.seen_server_request_ids.clear();
            state.unknown_notification_generations.clear();
            for runtime in runtimes.into_values() {
                runtime.stop_now("Ship Studio closed".into());
            }
        }
    }

    pub(super) fn remove_thread(
        &self,
        thread_id: &str,
    ) -> Result<Option<ChatThread>, CommandError> {
        self.ensure_storage()?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| CommandError::expected("Agent Chat service is unavailable"))?;
        if !state.threads.contains_key(thread_id) {
            return Ok(None);
        }
        let Some(store) = self.inner.store.as_ref() else {
            return Err(CommandError::expected("Agent Chat storage is unavailable"));
        };
        store
            .delete_thread(thread_id)
            .map_err(|error| self.remember_storage_fault(error))?;
        state.order.retain(|id| id != thread_id);
        state.uncertain_turns.remove(thread_id);
        state
            .pending_requests
            .retain(|(pending_thread_id, _), _| pending_thread_id != thread_id);
        state
            .request_correlations
            .retain(|key, _| key.thread_id != thread_id);
        state
            .seen_server_request_ids
            .retain(|key| key.thread_id != thread_id);
        let pending_rpc_keys = state
            .pending_rpcs
            .keys()
            .filter_map(|(pending_thread_id, generation, id)| {
                (pending_thread_id == thread_id).then_some((
                    pending_thread_id.clone(),
                    generation.clone(),
                    id.clone(),
                ))
            })
            .collect::<Vec<_>>();
        for key in pending_rpc_keys {
            state.pending_rpcs.remove(&key);
        }
        Ok(state.threads.remove(thread_id))
    }

    pub(super) fn pending_request(&self, thread_id: &str, request_id: &str) -> Option<ChatRequest> {
        self.inner.state.lock().ok().and_then(|state| {
            state
                .pending_requests
                .get(&(thread_id.to_string(), request_id.to_string()))
                .map(|pending| pending.request.clone())
        })
    }

    pub(super) fn take_pending_request(
        &self,
        thread_id: &str,
        request_id: &str,
        runtime_generation: &str,
    ) -> Option<PendingServerRequest> {
        self.inner.state.lock().ok().and_then(|mut state| {
            let key = (thread_id.to_string(), request_id.to_string());
            if state
                .pending_requests
                .get(&key)
                .is_some_and(|pending| pending.runtime_generation == runtime_generation)
            {
                state.pending_requests.remove(&key)
            } else {
                None
            }
        })
    }
}

fn should_auto_accept_approval(auto_accept_enabled: bool, method: &str, params: &Value) -> bool {
    if !auto_accept_enabled
        || !matches!(
            method,
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
        )
    {
        return false;
    }
    params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .is_some_and(|decisions| {
            decisions
                .iter()
                .any(|decision| decision.as_str() == Some("accept"))
        })
}

impl Drop for ServiceInner {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            for runtime in state.runtimes.values() {
                runtime.stop_now("Chat service stopped".into());
            }
        }
    }
}

fn clear_runtime_requests(state: &mut ChatState, thread_id: &str, runtime_generation: &str) {
    state
        .pending_requests
        .retain(|(pending_thread_id, _), pending| {
            pending_thread_id != thread_id || pending.runtime_generation != runtime_generation
        });
    state.request_correlations.retain(|key, _| {
        key.thread_id != thread_id || key.runtime_generation != runtime_generation
    });
    state
        .seen_server_request_ids
        .retain(|key| key.thread_id != thread_id || key.runtime_generation != runtime_generation);
    state
        .unknown_notification_generations
        .remove(&(thread_id.to_string(), runtime_generation.to_string()));
}

fn resolve_server_request(
    state: &mut ChatState,
    key: &ServerRequestCorrelationKey,
) -> Option<String> {
    let public_id = state.request_correlations.remove(key)?;
    state
        .pending_requests
        .remove(&(key.thread_id.clone(), public_id.clone()));
    Some(public_id)
}

fn claim_unknown_notification(
    state: &mut ChatState,
    thread_id: &str,
    runtime_generation: &str,
) -> bool {
    state
        .unknown_notification_generations
        .insert((thread_id.to_string(), runtime_generation.to_string()))
}

fn safe_protocol_method(method: &str) -> String {
    let safe = method
        .chars()
        .take(96)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '/' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "unknown protocol event".into()
    } else {
        safe
    }
}

fn upsert(items: &mut Vec<ChatItem>, mut item: ChatItem) {
    if let Some(existing) = items.iter_mut().find(|existing| existing.id == item.id) {
        if existing.kind == "reasoning"
            && item.kind == "reasoning"
            && item.text.is_empty()
            && !existing.text.is_empty()
        {
            item.text = std::mem::take(&mut existing.text);
        }
        *existing = item;
    } else {
        items.push(item);
    }
}

fn merge_provider_history(
    items: &mut Vec<ChatItem>,
    provider_items: Vec<ChatItem>,
    protected_user_item_id: Option<&str>,
) -> bool {
    let mut matched_local_users = std::collections::HashSet::new();
    let mut changed_meaningful = false;

    for mut provider_item in provider_items {
        if provider_item.kind == "user" {
            let candidates = items
                .iter()
                .enumerate()
                .filter(|(index, local)| {
                    local.kind == "user"
                        && protected_user_item_id != Some(local.id.as_str())
                        && !matched_local_users.contains(index)
                        && (same_user_prompt(&local.text, &provider_item.text)
                            || (local.text.is_empty()
                                && !local.attachments.is_empty()
                                && provider_item.text.is_empty()))
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let matching_local_index = match provider_item.turn_id.as_deref() {
                Some(turn_id) => {
                    let matching_turns = candidates
                        .iter()
                        .copied()
                        .filter(|index| items[*index].turn_id.as_deref() == Some(turn_id))
                        .collect::<Vec<_>>();
                    if matching_turns.len() == 1 {
                        Some(matching_turns[0])
                    } else if matching_turns.is_empty()
                        && candidates.len() == 1
                        && items[candidates[0]].turn_id.is_none()
                    {
                        Some(candidates[0])
                    } else {
                        None
                    }
                }
                None => (candidates.len() == 1).then(|| candidates[0]),
            };
            if let Some(index) = matching_local_index {
                matched_local_users.insert(index);
                provider_item.id = items[index].id.clone();
                provider_item.attachments = items[index].attachments.clone();
                if let Some(local) = items.get_mut(index) {
                    local.turn_id = provider_item.turn_id;
                    if local.status.is_none() {
                        local.status = provider_item.status;
                    }
                }
                continue;
            }
        }

        if let Some(existing) = items.iter().find(|item| item.id == provider_item.id) {
            let changed = existing.kind != provider_item.kind
                || existing.text != provider_item.text
                || existing.status != provider_item.status
                || existing.turn_id != provider_item.turn_id;
            if changed && is_meaningful_item(&provider_item) {
                changed_meaningful = true;
            }
        } else if is_meaningful_item(&provider_item) {
            changed_meaningful = true;
        }
        upsert(items, provider_item);
    }

    changed_meaningful
}

fn same_user_prompt(local_text: &str, provider_text: &str) -> bool {
    local_text == provider_text
        || provider_text
            .strip_prefix(local_text)
            .is_some_and(|suffix| suffix.starts_with("\nAttached local file references:\n"))
}

fn reconcile_turn_attempt(
    turn: &ChatTurnRecord,
    user_item: &ChatItem,
    provider_items: &[ChatItem],
    provider_status: &str,
) -> ChatSendReconciliation {
    let turn_present = turn
        .provider_turn_id
        .as_ref()
        .is_some_and(|provider_turn_id| {
            provider_items
                .iter()
                .any(|item| item.turn_id.as_ref() == Some(provider_turn_id))
        });
    let baseline_start = if turn.baseline_known {
        match turn.baseline_last_item_id.as_deref() {
            Some(anchor) => provider_items
                .iter()
                .position(|item| item.id == anchor)
                .map(|index| index + 1),
            None => Some(0),
        }
    } else {
        None
    };
    let after_baseline =
        baseline_start.map(|start| provider_items.iter().skip(start).collect::<Vec<_>>());
    let matching_prompts = after_baseline.as_ref().map(|items| {
        items
            .iter()
            .copied()
            .filter(|item| item.kind == "user" && same_user_prompt(&user_item.text, &item.text))
            .collect::<Vec<_>>()
    });
    let exact_candidate = after_baseline
        .as_ref()
        .and_then(|items| items.iter().copied().find(|item| item.id == turn.id));
    let outcome = if turn_present || exact_candidate.is_some() {
        "confirmedPresent"
    } else if matching_prompts
        .as_ref()
        .is_some_and(|items| !items.is_empty())
    {
        // Text alone cannot identify this attempt. It may be a prompt from a
        // different Codex client or an echo whose client correlation was lost.
        "ambiguous"
    } else if matching_prompts.as_ref().is_some_and(Vec::is_empty) && provider_status == "idle" {
        "confirmedAbsent"
    } else {
        "ambiguous"
    };
    ChatSendReconciliation {
        attempt_id: turn.id.clone(),
        outcome: outcome.into(),
        attachment_acceptance: if user_item.attachments.is_empty() {
            if outcome == "confirmedPresent" {
                "notApplicable".into()
            } else {
                "unknown".into()
            }
        } else {
            "unknown".into()
        },
        provider_turn_id: turn
            .provider_turn_id
            .clone()
            .or_else(|| exact_candidate.and_then(|item| item.turn_id.clone())),
    }
}

fn append_item_delta(
    items: &mut Vec<ChatItem>,
    id: &str,
    turn_id: Option<String>,
    kind: &str,
    delta: &str,
) {
    if let Some(existing) = items.iter_mut().find(|item| item.id == id) {
        existing.text.push_str(delta);
        existing.status = Some("running".into());
    } else {
        items.push(ChatItem {
            id: id.to_string(),
            turn_id,
            kind: kind.to_string(),
            text: delta.to_string(),
            status: Some("running".into()),
            attachments: Vec::new(),
        });
    }
}

fn activity_event_key(thread_id: &str, method: &str, params: &Value) -> String {
    let encoded = serde_json::to_vec(params).unwrap_or_default();
    let mut digest = Sha256::new();
    digest.update(thread_id.as_bytes());
    digest.update([0]);
    digest.update(method.as_bytes());
    digest.update([0]);
    digest.update(encoded);
    hex::encode(digest.finalize())
}

fn is_meaningful_item(item: &ChatItem) -> bool {
    matches!(
        item.kind.as_str(),
        "assistant" | "tool" | "fileChange" | "reasoning" | "plan" | "error" | "activity"
    )
}

fn deterministic_title(prompt: &str, has_attachments: bool) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return if has_attachments {
            "Attached file".into()
        } else {
            "New chat".into()
        };
    }
    let mut chars = title.chars();
    let preview = chars.by_ref().take(80).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_item_delta, claim_unknown_notification, clear_runtime_requests,
        merge_provider_history, reconcile_turn_attempt, resolve_server_request,
        safe_protocol_method, should_auto_accept_approval, upsert, ChatState, PendingServerRequest,
        ServerRequestCorrelationKey,
    };
    use crate::commands::agent_chat::types::{
        ChatAttachment, ChatItem, ChatRequest, ChatSettings, ChatTurnRecord,
    };
    use serde_json::json;

    fn item(id: &str, kind: &str, text: &str, status: &str) -> ChatItem {
        ChatItem {
            id: id.into(),
            turn_id: Some("turn-1".into()),
            kind: kind.into(),
            text: text.into(),
            status: Some(status.into()),
            attachments: Vec::new(),
        }
    }

    fn send_attempt(baseline_last_item_id: &str) -> ChatTurnRecord {
        ChatTurnRecord {
            id: "attempt-current".into(),
            provider_turn_id: None,
            user_item_id: "local-user".into(),
            outcome: "uncertain".into(),
            settings: ChatSettings::default(),
            approval_policy: None,
            sandbox_policy: None,
            baseline_known: true,
            baseline_last_item_id: Some(baseline_last_item_id.into()),
            reconciliation: None,
            started_at: 1,
            finished_at: None,
        }
    }

    #[test]
    fn send_reconciliation_uses_exact_client_id_and_ignores_older_equal_prompt() {
        let turn = send_attempt("baseline");
        let local = item("local-user", "user", "same prompt", "sending");
        let provider_items = vec![
            item("older-client-id", "user", "same prompt", "completed"),
            item("baseline", "activity", "before current send", "completed"),
            item("attempt-current", "user", "same prompt", "completed"),
        ];

        let result = reconcile_turn_attempt(&turn, &local, &provider_items, "idle");

        assert_eq!(result.outcome, "confirmedPresent");
        assert_eq!(result.provider_turn_id, Some("turn-1".into()));
        assert_eq!(result.attachment_acceptance, "notApplicable");
    }

    #[test]
    fn send_reconciliation_marks_absent_only_with_idle_history_and_attachments_unknown() {
        let turn = send_attempt("baseline");
        let mut local = item("local-user", "user", "same prompt", "sending");
        local.attachments.push(ChatAttachment {
            id: "attachment-1".into(),
            name: "image.png".into(),
            path: "/agent-chat/attachments/image.png".into(),
            mime_type: "image/png".into(),
            size: 12,
            kind: "image".into(),
            available: true,
        });
        let provider_items = vec![
            item("older-client-id", "user", "same prompt", "completed"),
            item("baseline", "activity", "before current send", "completed"),
        ];

        let result = reconcile_turn_attempt(&turn, &local, &provider_items, "idle");

        assert_eq!(result.outcome, "confirmedAbsent");
        assert_eq!(result.attachment_acceptance, "unknown");
    }

    #[test]
    fn send_reconciliation_keeps_unbound_equal_prompt_and_active_history_ambiguous() {
        let turn = send_attempt("baseline");
        let local = item("local-user", "user", "same prompt", "sending");
        let provider_items = vec![
            item("baseline", "activity", "before current send", "completed"),
            item("another-client-id", "user", "same prompt", "completed"),
        ];

        let equal_prompt = reconcile_turn_attempt(&turn, &local, &provider_items, "idle");
        let active_without_prompt = reconcile_turn_attempt(
            &turn,
            &local,
            &[item(
                "baseline",
                "activity",
                "before current send",
                "completed",
            )],
            "active",
        );

        assert_eq!(equal_prompt.outcome, "ambiguous");
        assert_eq!(active_without_prompt.outcome, "ambiguous");
    }

    #[test]
    fn automatic_approval_requires_an_explicit_setting_and_offered_accept() {
        let request = json!({ "availableDecisions": ["accept", "decline"] });
        assert!(should_auto_accept_approval(
            true,
            "item/commandExecution/requestApproval",
            &request
        ));
        assert!(!should_auto_accept_approval(
            false,
            "item/commandExecution/requestApproval",
            &request
        ));
        assert!(!should_auto_accept_approval(
            true,
            "item/fileChange/requestApproval",
            &json!({ "availableDecisions": ["decline"] })
        ));
        assert!(!should_auto_accept_approval(
            true,
            "execCommandApproval",
            &request
        ));
    }

    #[test]
    fn empty_reasoning_completion_preserves_streamed_summary_for_same_item() {
        let mut items = vec![item(
            "reason-1",
            "reasoning",
            "Provider-exposed summary",
            "running",
        )];

        upsert(&mut items, item("reason-1", "reasoning", "", "completed"));

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Provider-exposed summary");
        assert_eq!(items[0].status.as_deref(), Some("completed"));
    }

    #[test]
    fn provider_history_reconciles_user_echoes_and_final_items_once() {
        let mut items = vec![
            item("local-user-id", "user", "same prompt", "completed"),
            item("assistant-1", "assistant", "partial", "running"),
        ];
        let provider_history = || {
            vec![
                item(
                    "provider-user-id",
                    "user",
                    "same prompt\nAttached local file references:\n\"/tmp/notes.txt\"",
                    "completed",
                ),
                item("assistant-1", "assistant", "final answer", "completed"),
            ]
        };

        assert!(merge_provider_history(&mut items, provider_history(), None));
        assert_eq!(
            items.len(),
            2,
            "the provider user echo must not duplicate the local send"
        );
        assert_eq!(items[0].id, "local-user-id");
        assert_eq!(items[1].text, "final answer");
        assert!(!merge_provider_history(
            &mut items,
            provider_history(),
            None
        ));
        assert_eq!(
            items.len(),
            2,
            "replayed provider history adds no duplicate items"
        );
    }

    #[test]
    fn repeated_text_delta_chunks_are_preserved() {
        let mut items = Vec::new();
        append_item_delta(
            &mut items,
            "assistant-1",
            Some("turn-1".into()),
            "assistant",
            "ha",
        );
        append_item_delta(
            &mut items,
            "assistant-1",
            Some("turn-1".into()),
            "assistant",
            "ha",
        );

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "haha");
    }

    #[test]
    fn resolved_server_requests_are_scoped_to_thread_runtime_and_typed_id() {
        let number =
            ServerRequestCorrelationKey::new("thread-a", "runtime-1", "provider-a", &json!(7))
                .unwrap();
        let string =
            ServerRequestCorrelationKey::new("thread-a", "runtime-1", "provider-a", &json!("7"))
                .unwrap();
        let other_thread =
            ServerRequestCorrelationKey::new("thread-b", "runtime-1", "provider-b", &json!(7))
                .unwrap();
        let next_runtime =
            ServerRequestCorrelationKey::new("thread-a", "runtime-2", "provider-a", &json!(7))
                .unwrap();
        let mut state = ChatState::default();
        for (key, public_id, rpc_id) in [
            (number.clone(), "number-request", json!(7)),
            (string.clone(), "string-request", json!("7")),
            (other_thread.clone(), "other-thread-request", json!(7)),
            (next_runtime.clone(), "next-runtime-request", json!(7)),
        ] {
            state
                .request_correlations
                .insert(key.clone(), public_id.into());
            state.pending_requests.insert(
                (key.thread_id.clone(), public_id.into()),
                PendingServerRequest {
                    rpc_id,
                    request: ChatRequest {
                        id: public_id.into(),
                        method: "item/tool/requestUserInput".into(),
                        kind: "question".into(),
                        title: "Question".into(),
                        params: json!({}),
                    },
                    runtime_generation: key.runtime_generation.clone(),
                },
            );
        }

        assert_eq!(
            resolve_server_request(&mut state, &number).as_deref(),
            Some("number-request")
        );
        assert!(!state
            .pending_requests
            .contains_key(&("thread-a".into(), "number-request".into())));
        assert!(resolve_server_request(&mut state, &number).is_none());
        assert_eq!(
            resolve_server_request(&mut state, &string).as_deref(),
            Some("string-request")
        );
        assert_eq!(
            resolve_server_request(&mut state, &other_thread).as_deref(),
            Some("other-thread-request")
        );
        assert_eq!(
            resolve_server_request(&mut state, &next_runtime).as_deref(),
            Some("next-runtime-request")
        );
    }

    #[test]
    fn clearing_one_runtime_keeps_newer_request_correlations() {
        let mut state = ChatState::default();
        let old =
            ServerRequestCorrelationKey::new("thread-a", "runtime-1", "provider-a", &json!(1))
                .unwrap();
        let current =
            ServerRequestCorrelationKey::new("thread-a", "runtime-2", "provider-a", &json!(1))
                .unwrap();
        state
            .request_correlations
            .insert(old.clone(), "old-request".into());
        state
            .request_correlations
            .insert(current.clone(), "current-request".into());
        state.seen_server_request_ids.insert(old.clone());
        state.seen_server_request_ids.insert(current.clone());

        clear_runtime_requests(&mut state, "thread-a", "runtime-1");

        assert!(!state.request_correlations.contains_key(&old));
        assert_eq!(
            state.request_correlations.get(&current).map(String::as_str),
            Some("current-request")
        );
        assert!(!state.seen_server_request_ids.contains(&old));
        assert!(state.seen_server_request_ids.contains(&current));
    }

    #[test]
    fn unknown_notification_diagnostic_is_once_per_runtime_and_method_is_bounded() {
        let mut state = ChatState::default();
        assert!(claim_unknown_notification(
            &mut state,
            "thread-a",
            "runtime-1"
        ));
        assert!(!claim_unknown_notification(
            &mut state,
            "thread-a",
            "runtime-1"
        ));
        assert!(claim_unknown_notification(
            &mut state,
            "thread-a",
            "runtime-2"
        ));

        let method = safe_protocol_method(&format!("future/{}\n", "x".repeat(128)));
        assert!(method.len() <= 96);
        assert!(method
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_/- .".contains(character)));
    }
}

fn summarize_plan(params: &Value) -> String {
    let mut lines = params
        .get("plan")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(40)
        .filter_map(|step| {
            let text = step.get("step").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                return None;
            }
            let state = match step.get("status").and_then(Value::as_str) {
                Some("completed") => "completed",
                Some("inProgress") => "in progress",
                _ => "pending",
            };
            Some(format!(
                "{state}: {}",
                super::types::truncate_utf8(text, 512)
            ))
        })
        .collect::<Vec<_>>();
    if let Some(explanation) = params
        .get("explanation")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|explanation| !explanation.is_empty())
    {
        lines.push(super::types::truncate_utf8(explanation, 1024));
    }
    if lines.is_empty() {
        "Plan updated".into()
    } else {
        lines.join("\n")
    }
}

fn summarize_file_changes(changes: Option<&Value>) -> String {
    let lines = changes
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(20)
        .filter_map(|change| {
            let path = change.get("path").and_then(Value::as_str)?.trim();
            if path.is_empty() {
                return None;
            }
            let kind = change
                .get("kind")
                .and_then(|kind| kind.get("type").or(Some(kind)))
                .and_then(Value::as_str)
                .map(|kind| match kind {
                    "add" => "Added",
                    "delete" => "Deleted",
                    "update" => "Updated",
                    _ => "Changed",
                })
                .unwrap_or("Changed");
            let diff = change
                .get("diff")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|diff| !diff.is_empty());
            Some(match diff {
                Some(diff) => format!(
                    "{kind}: {}\n{}",
                    super::types::truncate_utf8(path, 512),
                    super::types::truncate_utf8(diff, 768)
                ),
                None => format!("{kind}: {}", super::types::truncate_utf8(path, 512)),
            })
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        "File changes updated".into()
    } else {
        lines.join("\n")
    }
}

fn safe_protocol_diagnostic(message: &str) -> &'static str {
    let message = message.to_ascii_lowercase();
    if [
        "unauthorized",
        "not authenticated",
        "authentication",
        "login required",
    ]
    .iter()
    .any(|needle| message.contains(needle))
    {
        "Codex authentication is unavailable. Sign in to Codex CLI and try again."
    } else if message.contains("model") || message.contains("reasoning effort") {
        "Codex rejected the selected model or reasoning effort. Refresh the model list and try again."
    } else if message.contains("invalid params")
        || message.contains("invalid parameter")
        || message.contains("invalid request")
    {
        "Codex rejected the request parameters. Check the selected model and chat settings."
    } else {
        "The provider rejected the request"
    }
}

pub async fn shutdown_project(project_path: &str) {
    let Some(service) = GLOBAL_SERVICE.get() else {
        return;
    };
    let canonical = dunce::canonicalize(project_path).unwrap_or_else(|_| project_path.into());
    let ids = service
        .inner
        .state
        .lock()
        .map(|state| {
            state
                .threads
                .values()
                .filter(|thread| {
                    dunce::canonicalize(&thread.project_path)
                        .unwrap_or_else(|_| thread.project_path.clone().into())
                        == canonical
                })
                .map(|thread| thread.id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    service
        .stop_threads(
            ids,
            "This project's Codex chats were stopped when the project was suspended.",
            false,
        )
        .await;
}

pub async fn stop_before_worktree_removal(checkout_path: &str) {
    let Some(service) = GLOBAL_SERVICE.get() else {
        return;
    };
    let ids = matching_checkout_threads(service, checkout_path);
    service
        .stop_threads(
            ids,
            "This Codex chat was interrupted because its worktree is being removed.",
            false,
        )
        .await;
}

pub fn mark_worktree_removed(checkout_path: &str) {
    let Some(service) = GLOBAL_SERVICE.get() else {
        return;
    };
    let ids = matching_checkout_threads(service, checkout_path);
    for thread_id in ids {
        service.update_thread(&thread_id, true, |thread| {
            mark_unfinished_turns_interrupted(thread, chrono::Utc::now().timestamp_millis());
            thread.status = "interrupted".into();
            thread.checkout_status = "missing".into();
            thread.resume_status = "unavailable".into();
            thread.error = Some(
                "This checkout was removed. The conversation is unavailable until its checkout is explicitly restored.".into(),
            );
        });
    }
}

fn matching_checkout_threads(service: &AgentChatService, checkout_path: &str) -> Vec<String> {
    let candidate = dunce::canonicalize(checkout_path).unwrap_or_else(|_| checkout_path.into());
    service
        .inner
        .state
        .lock()
        .map(|state| {
            state
                .threads
                .values()
                .filter(|thread| {
                    dunce::canonicalize(&thread.checkout_path)
                        .unwrap_or_else(|_| thread.checkout_path.clone().into())
                        == candidate
                })
                .map(|thread| thread.id.clone())
                .collect()
        })
        .unwrap_or_default()
}

pub fn shutdown_all_on_exit() {
    if let Some(service) = GLOBAL_SERVICE.get() {
        service.shutdown_all_sync();
    }
}
