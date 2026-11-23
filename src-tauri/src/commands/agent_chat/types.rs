use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime_type: String,
    pub size: u64,
    pub kind: String,
    #[serde(default = "attachment_available_by_default")]
    pub available: bool,
}

fn attachment_available_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub status: Option<String>,
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub id: String,
    pub method: String,
    pub kind: String,
    pub title: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub checkout_path: String,
    /// App-owned marker read from this checkout's Git administrative directory.
    /// It is persisted in SQLite but intentionally omitted from the IPC payload.
    #[serde(skip)]
    pub checkout_identity: String,
    pub checkout_status: String,
    pub provider_id: String,
    pub provider_thread_id: Option<String>,
    pub resume_status: String,
    pub provider_status: String,
    pub title: String,
    pub title_source: String,
    pub status: String,
    pub turn_id: Option<String>,
    /// Effective values returned by app-server at thread start/resume. They are
    /// intentionally optional because older or unavailable providers may omit them.
    #[serde(default)]
    pub approval_policy: Option<Value>,
    #[serde(default)]
    pub sandbox_policy: Option<Value>,
    /// Durable per-send records. Added with serde defaults so v7 thread JSON
    /// remains readable without rewriting its history.
    #[serde(default)]
    pub turns: Vec<ChatTurnRecord>,
    pub items: Vec<ChatItem>,
    pub requests: Vec<ChatRequest>,
    pub draft: ChatDraft,
    pub settings: ChatSettings,
    pub disposition: String,
    pub activity_cursor: u64,
    pub settled_cursor: Option<u64>,
    pub read_cursor: u64,
    pub unread: bool,
    pub latest_activity_at: Option<i64>,
    pub error: Option<String>,
    pub revision: u64,
}

pub(super) fn mark_unfinished_turns_interrupted(thread: &mut ChatThread, finished_at: i64) -> bool {
    let mut changed = false;
    for turn in &mut thread.turns {
        if matches!(turn.outcome.as_str(), "claimed" | "sending" | "running") {
            turn.outcome = "interrupted".into();
            turn.finished_at = Some(finished_at);
            changed = true;
        }
    }
    changed
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnRecord {
    /// Ship Studio's send-attempt ID; stable before Codex returns a turn ID.
    pub id: String,
    pub provider_turn_id: Option<String>,
    pub user_item_id: String,
    pub outcome: String,
    pub settings: ChatSettings,
    pub approval_policy: Option<Value>,
    pub sandbox_policy: Option<Value>,
    pub baseline_known: bool,
    pub baseline_last_item_id: Option<String>,
    pub reconciliation: Option<ChatSendReconciliation>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendReconciliation {
    pub attempt_id: String,
    /// confirmedPresent, confirmedAbsent, or ambiguous.
    pub outcome: String,
    /// A user item may be present while Codex's history still cannot prove
    /// that every staged image/file input was accepted.
    pub attachment_acceptance: String,
    pub provider_turn_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDraft {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub auto_accept_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatDraft {
    pub draft_id: String,
    pub project_id: String,
    pub checkout_path: String,
    /// Backend-only marker for the exact Git worktree that owns this draft.
    #[serde(skip)]
    pub checkout_identity: String,
    pub checkout_status: String,
    pub draft: ChatDraft,
    pub settings: ChatSettings,
    pub saved_at: i64,
    pub state: String,
    pub promoted_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatDraftPage {
    pub drafts: Vec<SavedChatDraft>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModel {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub input_modalities: Option<Vec<String>>,
}

pub(crate) const MAX_ITEM_TEXT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_RPC_PARAMS_BYTES: usize = 64 * 1024;
pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const TRANSCRIPT_TRUNCATION_SUFFIX: &str = "\n… output truncated …";

pub(crate) fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    if limit <= TRANSCRIPT_TRUNCATION_SUFFIX.len() {
        let mut suffix = String::new();
        for character in TRANSCRIPT_TRUNCATION_SUFFIX.chars() {
            if suffix.len() + character.len_utf8() > limit {
                break;
            }
            suffix.push(character);
        }
        return suffix;
    }
    let mut end = limit - TRANSCRIPT_TRUNCATION_SUFFIX.len();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut truncated = value[..end].to_string();
    truncated.push_str(TRANSCRIPT_TRUNCATION_SUFFIX);
    truncated
}

pub(crate) fn trim_transcript(thread: &mut ChatThread) {
    for item in &mut thread.items {
        item.text = truncate_utf8(&item.text, MAX_ITEM_TEXT_BYTES);
    }
}
