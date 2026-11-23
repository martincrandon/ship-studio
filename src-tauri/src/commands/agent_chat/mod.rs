mod attachments;
pub mod commands;
mod identity;
mod persistence;
mod protocol;
mod provider;
mod runtime;
mod service;
mod types;

pub use persistence::StoredProject;

pub use commands::{
    agent_chat_create, agent_chat_delete_project_draft, agent_chat_discard, agent_chat_interrupt,
    agent_chat_list, agent_chat_list_drafts, agent_chat_list_unlinked_projects,
    agent_chat_mark_read, agent_chat_models, agent_chat_project_mode, agent_chat_promote_draft,
    agent_chat_recheck_attachments, agent_chat_relink_checkout, agent_chat_relink_project,
    agent_chat_rename, agent_chat_reopen, agent_chat_respond, agent_chat_resume_check,
    agent_chat_save_draft, agent_chat_save_project_draft, agent_chat_save_settings,
    agent_chat_send, agent_chat_settle, agent_chat_stage_attachment, agent_chat_storage_status,
};
pub use service::{
    mark_worktree_removed, shutdown_all_on_exit, shutdown_project, stop_before_worktree_removal,
    AgentChatService,
};
