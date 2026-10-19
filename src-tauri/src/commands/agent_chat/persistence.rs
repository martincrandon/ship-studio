//! App-owned durable storage for Agent Chat.
//!
//! SQLite is kept outside worktrees. Thread metadata and ordered display items
//! are committed together; attachment bytes live beside the database and are
//! referenced only by committed draft/message ownership rows.

use super::types::{
    ChatAttachment, ChatDraft, ChatItem, ChatSettings, ChatThread, SavedChatDraft,
    SavedChatDraftPage, TRANSCRIPT_TRUNCATION_SUFFIX,
};
use crate::errors::CommandError;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 4;
const STAGED_ATTACHMENT_LEASE_MS: i64 = 24 * 60 * 60 * 1000;

pub(super) struct ChatStore {
    connection: Mutex<Connection>,
    attachments_dir: PathBuf,
    database_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProject {
    pub id: String,
    pub git_common_dir: String,
    pub last_path: String,
    pub thread_count: u64,
}

impl ChatStore {
    pub(super) fn open(app: &tauri::AppHandle) -> Result<Self, CommandError> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| storage_error(format!("Could not locate app data: {error}")))?
            .join("agent-chat");
        fs::create_dir_all(&root).map_err(|error| {
            crate::utils::classify_fs_error("create Agent Chat storage", &root, &error)
        })?;
        restrict_directory(&root)?;

        let attachments_dir = root.join("attachments");
        fs::create_dir_all(&attachments_dir).map_err(|error| {
            crate::utils::classify_fs_error(
                "create Agent Chat attachment storage",
                &attachments_dir,
                &error,
            )
        })?;
        restrict_directory(&attachments_dir)?;
        let attachments_dir = fs::canonicalize(&attachments_dir).map_err(|error| {
            crate::utils::classify_fs_error(
                "access Agent Chat attachment storage",
                &attachments_dir,
                &error,
            )
        })?;

        let database_path = root.join("threads.sqlite3");
        let connection = Connection::open(&database_path).map_err(|error| {
            storage_error(format!(
                "Could not open {}: {error}",
                database_path.display()
            ))
        })?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| {
                storage_error(format!("Could not configure Agent Chat storage: {error}"))
            })?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
            )
            .map_err(|error| {
                storage_error(format!("Could not configure Agent Chat storage: {error}"))
            })?;
        migrate(&connection).map_err(|error| {
            storage_error(format!(
                "Could not migrate {}: {error}",
                database_path.display()
            ))
        })?;
        check_integrity(&connection).map_err(|error| {
            storage_error(format!(
                "Could not verify {}: {error}",
                database_path.display()
            ))
        })?;
        restrict_file(&database_path)?;

        Ok(Self {
            connection: Mutex::new(connection),
            attachments_dir,
            database_path,
        })
    }

    pub(super) fn schema_version(&self) -> u32 {
        SCHEMA_VERSION
    }

    pub(super) fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub(super) fn ensure_project(
        &self,
        git_common_dir: &Path,
        project_path: &Path,
    ) -> Result<String, CommandError> {
        let common_dir = canonical_display(git_common_dir)?;
        let project_path = canonical_display(project_path)?;
        let connection = self.connection()?;
        if let Some(id) = connection
            .query_row(
                "SELECT id FROM projects WHERE git_common_dir = ?1",
                [&common_dir],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_sql_error)?
        {
            connection
                .execute(
                    "UPDATE projects SET last_path = ?2 WHERE id = ?1",
                    params![id, project_path],
                )
                .map_err(storage_sql_error)?;
            return Ok(id);
        }

        let id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, common_dir, project_path, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(storage_sql_error)?;
        Ok(id)
    }

    pub(super) fn relink_project(
        &self,
        project_id: &str,
        git_common_dir: &Path,
        project_path: &Path,
    ) -> Result<(), CommandError> {
        let common_dir = canonical_display(git_common_dir)?;
        let project_path = canonical_display(project_path)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT id FROM projects WHERE git_common_dir = ?1",
                [&common_dir],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_sql_error)?;
        if existing
            .as_deref()
            .is_some_and(|existing| existing != project_id)
        {
            return Err(CommandError::Validation {
                field: "projectPath".into(),
                reason:
                    "This repository is already linked to a different Agent Chat project identity"
                        .into(),
            });
        }
        let changed = transaction
            .execute(
                "UPDATE projects SET git_common_dir = ?2, last_path = ?3 WHERE id = ?1",
                params![project_id, common_dir, project_path],
            )
            .map_err(storage_sql_error)?;
        if changed == 0 {
            return Err(CommandError::expected(
                "The stored Agent Chat project identity is unavailable",
            ));
        }
        let mut statement = transaction
            .prepare("SELECT id, thread_json FROM threads WHERE project_id = ?1")
            .map_err(storage_sql_error)?;
        let saved = statement
            .query_map([project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_sql_error)?;
        drop(statement);
        for (thread_id, encoded) in saved {
            let mut thread: ChatThread = serde_json::from_str(&encoded).map_err(|error| {
                storage_error(format!(
                    "A stored Agent Chat thread could not be decoded: {error}"
                ))
            })?;
            thread.project_path = project_path.clone();
            thread.revision = thread.revision.saturating_add(1);
            let mut metadata = thread.clone();
            metadata.items.clear();
            metadata.requests.clear();
            let metadata_json = serde_json::to_string(&metadata).map_err(|error| {
                storage_error(format!("Could not encode an Agent Chat thread: {error}"))
            })?;
            transaction
                .execute(
                    "UPDATE threads SET project_path = ?2, thread_json = ?3 WHERE id = ?1",
                    params![thread_id, project_path, metadata_json],
                )
                .map_err(storage_sql_error)?;
        }
        transaction.commit().map_err(storage_sql_error)
    }

    pub(super) fn list_unlinked_projects(&self) -> Result<Vec<StoredProject>, CommandError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.git_common_dir, p.last_path, COUNT(t.id) \
                 FROM projects p LEFT JOIN threads t ON t.project_id = p.id \
                 GROUP BY p.id ORDER BY MAX(t.updated_at) DESC, p.created_at DESC",
            )
            .map_err(storage_sql_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredProject {
                    id: row.get(0)?,
                    git_common_dir: row.get(1)?,
                    last_path: row.get(2)?,
                    thread_count: row.get::<_, i64>(3)?.max(0) as u64,
                })
            })
            .map_err(storage_sql_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map(|projects| {
                projects
                    .into_iter()
                    .filter(|project| {
                        !Path::new(&project.last_path).is_dir()
                            || !Path::new(&project.git_common_dir).is_dir()
                    })
                    .collect()
            })
            .map_err(storage_sql_error)
    }

    pub(super) fn persist_thread(&self, thread: &ChatThread) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        persist_thread_in(&transaction, thread, &self.attachments_dir)?;
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        if let Err(error) = self.prune_unused_attachments() {
            tracing::warn!(error = %error, "Unused Agent Chat attachment cleanup will retry at startup");
        }
        Ok(())
    }

    pub(super) fn stage_attachment(
        &self,
        app: &tauri::AppHandle,
        source_path: &str,
    ) -> Result<ChatAttachment, CommandError> {
        // Acquire the SQLite write lock before creating the file. Cleanup uses
        // the same database lock, so it cannot observe the new bytes as
        // unowned between the copy and the lease commit.
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_sql_error)?;
        let attachment = super::attachments::stage(app, source_path)?;
        let reserve =
            reserve_staged_attachment_in(&transaction, &self.attachments_dir, &attachment);
        if let Err(error) = reserve {
            let _ = fs::remove_file(&attachment.path);
            return Err(error);
        }
        if let Err(error) = transaction.commit() {
            let _ = fs::remove_file(&attachment.path);
            return Err(storage_sql_error(error));
        }
        Ok(attachment)
    }

    pub(super) fn recheck_attachments(
        &self,
        attachments: &[ChatAttachment],
    ) -> Result<Vec<ChatAttachment>, CommandError> {
        let connection = self.connection()?;
        let now = chrono::Utc::now().timestamp_millis();
        attachments
            .iter()
            .map(|attachment| {
                let saved_metadata = connection
                    .query_row(
                        "SELECT a.metadata_json FROM attachments a \
                         WHERE a.id = ?1 AND a.path = ?2 AND ( \
                           EXISTS (SELECT 1 FROM attachment_owners o WHERE o.attachment_id = a.id) OR \
                           EXISTS (SELECT 1 FROM draft_attachment_owners d WHERE d.attachment_id = a.id) OR \
                           EXISTS (SELECT 1 FROM staged_attachment_leases l WHERE l.attachment_id = a.id AND l.expires_at > ?3) \
                         )",
                        params![attachment.id, attachment.path, now],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(storage_sql_error)?;
                let matches_saved_identity = saved_metadata
                    .map(|encoded| {
                        serde_json::from_str::<ChatAttachment>(&encoded)
                            .map(|saved| {
                                saved.id == attachment.id
                                    && saved.name == attachment.name
                                    && saved.path == attachment.path
                                    && saved.mime_type == attachment.mime_type
                                    && saved.size == attachment.size
                                    && saved.kind == attachment.kind
                            })
                            .map_err(|error| {
                                storage_error(format!(
                                    "A stored chat attachment could not be decoded: {error}"
                                ))
                            })
                    })
                    .transpose()?
                    .unwrap_or(false);
                let mut checked = attachment.clone();
                checked.available = matches_saved_identity
                    && super::attachments::staged_file_is_valid(&self.attachments_dir, attachment);
                Ok(checked)
            })
            .collect()
    }

    pub(super) fn persist_thread_activity(
        &self,
        thread: &ChatThread,
        event_key: &str,
    ) -> Result<bool, CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO provider_event_keys (thread_id, event_key, recorded_at) VALUES (?1, ?2, ?3)",
                params![thread.id, event_key, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(storage_sql_error)?;
        if inserted == 0 {
            transaction.commit().map_err(storage_sql_error)?;
            return Ok(false);
        }
        persist_thread_in(&transaction, thread, &self.attachments_dir)?;
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        if let Err(error) = self.prune_unused_attachments() {
            tracing::warn!(error = %error, "Unused Agent Chat attachment cleanup will retry at startup");
        }
        Ok(true)
    }

    pub(super) fn delete_thread(&self, thread_id: &str) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        transaction
            .execute(
                "UPDATE saved_drafts SET state = 'discarded' WHERE promoted_thread_id = ?1",
                [thread_id],
            )
            .map_err(storage_sql_error)?;
        transaction
            .execute("DELETE FROM threads WHERE id = ?1", [thread_id])
            .map_err(storage_sql_error)?;
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        if let Err(error) = self.prune_unused_attachments() {
            tracing::warn!(error = %error, "Discarded Agent Chat attachment cleanup will retry at startup");
        }
        Ok(())
    }

    pub(super) fn list_saved_drafts(
        &self,
        project_id: &str,
        checkout_identity: &str,
        limit: u32,
        offset: u32,
    ) -> Result<SavedChatDraftPage, CommandError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT draft_id, project_id, checkout_path, checkout_identity, draft_json, \
                 settings_json, saved_at, state, promoted_thread_id FROM saved_drafts \
                 WHERE project_id = ?1 AND checkout_identity = ?2 AND state != 'discarded' \
                 ORDER BY saved_at DESC, draft_id DESC LIMIT ?3 OFFSET ?4",
            )
            .map_err(storage_sql_error)?;
        let rows = statement
            .query_map(
                params![project_id, checkout_identity, i64::from(limit) + 1, offset],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .map_err(storage_sql_error)?;
        let mut drafts = rows
            .map(|row| {
                let (
                    draft_id,
                    project_id,
                    checkout_path,
                    checkout_identity,
                    draft_json,
                    settings_json,
                    saved_at,
                    state,
                    promoted_thread_id,
                ) = row.map_err(storage_sql_error)?;
                let mut draft: ChatDraft = serde_json::from_str(&draft_json).map_err(|error| {
                    storage_error(format!(
                        "A saved Agent Chat draft could not be decoded: {error}"
                    ))
                })?;
                mark_missing_attachments(&self.attachments_dir, &mut draft.attachments);
                let settings =
                    serde_json::from_str::<ChatSettings>(&settings_json).map_err(|error| {
                        storage_error(format!(
                            "Saved Agent Chat settings could not be decoded: {error}"
                        ))
                    })?;
                Ok(SavedChatDraft {
                    draft_id,
                    project_id,
                    checkout_path,
                    checkout_identity,
                    checkout_status: "available".into(),
                    draft,
                    settings,
                    saved_at,
                    state,
                    promoted_thread_id,
                })
            })
            .collect::<Result<Vec<_>, CommandError>>()?;
        let has_more = drafts.len() > limit as usize;
        if has_more {
            drafts.pop();
        }
        Ok(SavedChatDraftPage {
            drafts,
            next_offset: has_more.then_some(offset.saturating_add(limit)),
        })
    }

    pub(super) fn get_saved_draft(
        &self,
        project_id: &str,
        draft_id: &str,
    ) -> Result<Option<SavedChatDraft>, CommandError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT draft_id, project_id, checkout_path, checkout_identity, draft_json, \
                 settings_json, saved_at, state, promoted_thread_id FROM saved_drafts \
                 WHERE project_id = ?1 AND draft_id = ?2",
                params![project_id, draft_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_sql_error)?;
        row.map(
            |(
                draft_id,
                project_id,
                checkout_path,
                checkout_identity,
                draft_json,
                settings_json,
                saved_at,
                state,
                promoted_thread_id,
            )| {
                let mut draft: ChatDraft = serde_json::from_str(&draft_json).map_err(|error| {
                    storage_error(format!(
                        "A saved Agent Chat draft could not be decoded: {error}"
                    ))
                })?;
                mark_missing_attachments(&self.attachments_dir, &mut draft.attachments);
                let settings =
                    serde_json::from_str::<ChatSettings>(&settings_json).map_err(|error| {
                        storage_error(format!(
                            "Saved Agent Chat settings could not be decoded: {error}"
                        ))
                    })?;
                Ok(SavedChatDraft {
                    draft_id,
                    project_id,
                    checkout_path,
                    checkout_identity,
                    checkout_status: "available".into(),
                    draft,
                    settings,
                    saved_at,
                    state,
                    promoted_thread_id,
                })
            },
        )
        .transpose()
    }

    pub(super) fn save_project_draft(
        &self,
        draft: &SavedChatDraft,
    ) -> Result<SavedChatDraft, CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let existing = transaction
            .query_row(
                "SELECT project_id, checkout_path, checkout_identity, state FROM saved_drafts WHERE draft_id = ?1",
                [&draft.draft_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_sql_error)?;
        if let Some((project_id, checkout_path, identity, state)) = existing {
            if project_id != draft.project_id
                || checkout_path != draft.checkout_path
                || identity != draft.checkout_identity
            {
                return Err(CommandError::Validation {
                    field: "draftId".into(),
                    reason: "This draft belongs to a different project or checkout".into(),
                });
            }
            if state != "draft" {
                return Err(CommandError::expected(
                    "This saved draft has already been promoted or discarded",
                ));
            }
        }
        let saved_at = chrono::Utc::now().timestamp_millis();
        let draft_json = serde_json::to_string(&draft.draft).map_err(|error| {
            storage_error(format!(
                "Could not encode a saved Agent Chat draft: {error}"
            ))
        })?;
        let settings_json = serde_json::to_string(&draft.settings).map_err(|error| {
            storage_error(format!(
                "Could not encode saved Agent Chat settings: {error}"
            ))
        })?;
        transaction
            .execute(
                "INSERT INTO saved_drafts (draft_id, project_id, checkout_path, checkout_identity, draft_json, settings_json, saved_at, state, promoted_thread_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', NULL) \
                 ON CONFLICT(draft_id) DO UPDATE SET draft_json=excluded.draft_json, \
                 settings_json=excluded.settings_json, saved_at=excluded.saved_at",
                params![
                    draft.draft_id,
                    draft.project_id,
                    draft.checkout_path,
                    draft.checkout_identity,
                    draft_json,
                    settings_json,
                    saved_at,
                ],
            )
            .map_err(storage_sql_error)?;
        transaction
            .execute(
                "DELETE FROM draft_attachment_owners WHERE draft_id = ?1",
                [&draft.draft_id],
            )
            .map_err(storage_sql_error)?;
        for (ordinal, attachment) in draft.draft.attachments.iter().enumerate() {
            persist_saved_draft_attachment_owner(
                &transaction,
                &self.attachments_dir,
                &draft.draft_id,
                ordinal,
                attachment,
            )?;
        }
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        if let Err(error) = self.prune_unused_attachments() {
            tracing::warn!(error = %error, "Unused Agent Chat attachment cleanup will retry at startup");
        }
        let mut saved = draft.clone();
        saved.saved_at = saved_at;
        saved.state = "draft".into();
        saved.promoted_thread_id = None;
        Ok(saved)
    }

    pub(super) fn delete_saved_draft(
        &self,
        project_id: &str,
        draft_id: &str,
    ) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let state = transaction
            .query_row(
                "SELECT state FROM saved_drafts WHERE project_id = ?1 AND draft_id = ?2",
                params![project_id, draft_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_sql_error)?;
        match state.as_deref() {
            None => return Err(CommandError::expected("The saved draft is unavailable")),
            Some("draft") => {}
            Some(_) => {
                return Err(CommandError::expected(
                    "This draft has already been promoted; discard its bound chat explicitly",
                ));
            }
        }
        transaction
            .execute(
                "DELETE FROM saved_drafts WHERE project_id = ?1 AND draft_id = ?2",
                params![project_id, draft_id],
            )
            .map_err(storage_sql_error)?;
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        self.prune_unused_attachments()?;
        Ok(())
    }

    pub(super) fn promote_saved_draft(
        &self,
        thread: &ChatThread,
        draft_id: &str,
    ) -> Result<(String, bool), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let existing = transaction
            .query_row(
                "SELECT checkout_path, checkout_identity, state, promoted_thread_id FROM saved_drafts WHERE project_id = ?1 AND draft_id = ?2",
                params![thread.project_id, draft_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_sql_error)?
            .ok_or_else(|| CommandError::expected("The saved draft is unavailable"))?;
        if existing.0 != thread.checkout_path || existing.1 != thread.checkout_identity {
            return Err(CommandError::Validation {
                field: "checkoutPath".into(),
                reason: "This draft belongs to a different Git checkout".into(),
            });
        }
        if existing.2 == "promoted" {
            let thread_id = existing
                .3
                .ok_or_else(|| storage_error("A promoted saved draft has no bound chat thread"))?;
            transaction.commit().map_err(storage_sql_error)?;
            return Ok((thread_id, false));
        }
        if existing.2 != "draft" {
            return Err(CommandError::expected("This saved draft was discarded"));
        }
        persist_thread_in(&transaction, thread, &self.attachments_dir)?;
        let updated = transaction
            .execute(
                "UPDATE saved_drafts SET state = 'promoted', promoted_thread_id = ?3, saved_at = ?4 \
                 WHERE project_id = ?1 AND draft_id = ?2 AND state = 'draft'",
                params![
                    thread.project_id,
                    draft_id,
                    thread.id,
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .map_err(storage_sql_error)?;
        if updated != 1 {
            return Err(CommandError::expected(
                "This saved draft was promoted by another request",
            ));
        }
        transaction
            .execute(
                "DELETE FROM draft_attachment_owners WHERE draft_id = ?1",
                [draft_id],
            )
            .map_err(storage_sql_error)?;
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        if let Err(error) = self.prune_unused_attachments() {
            tracing::warn!(error = %error, "Unused Agent Chat attachment cleanup will retry at startup");
        }
        Ok((thread.id.clone(), true))
    }

    pub(super) fn load_threads(&self) -> Result<Vec<ChatThread>, CommandError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT thread_json, project_path, checkout_identity FROM threads ORDER BY updated_at DESC, created_at DESC")
            .map_err(storage_sql_error)?;
        let json_rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_sql_error)?;
        let encoded = json_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_sql_error)?;
        drop(statement);

        let mut message_statement = connection
            .prepare("SELECT payload FROM messages WHERE thread_id = ?1 ORDER BY ordinal ASC")
            .map_err(storage_sql_error)?;
        let mut threads = Vec::with_capacity(encoded.len());
        for (json, project_path, checkout_identity) in encoded {
            let mut thread: ChatThread = serde_json::from_str(&json).map_err(|error| {
                storage_error(format!(
                    "A stored Agent Chat thread could not be decoded: {error}"
                ))
            })?;
            thread.project_path = project_path;
            thread.checkout_identity = checkout_identity;
            let mut items = message_statement
                .query_map([&thread.id], |row| row.get::<_, String>(0))
                .map_err(storage_sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_sql_error)?
                .into_iter()
                .map(|item| {
                    serde_json::from_str::<ChatItem>(&item).map_err(|error| {
                        storage_error(format!(
                            "A stored Agent Chat message could not be decoded: {error}"
                        ))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            for item in &mut items {
                mark_missing_attachments(&self.attachments_dir, &mut item.attachments);
            }
            mark_missing_attachments(&self.attachments_dir, &mut thread.draft.attachments);
            thread.items = items;
            thread.requests.clear();
            threads.push(thread);
        }
        Ok(threads)
    }

    pub(super) fn cleanup_orphans(&self) -> Result<(), CommandError> {
        self.prune_unused_attachments()?;
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT path FROM attachments")
            .map_err(storage_sql_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_sql_error)?;
        let referenced = rows
            .collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(storage_sql_error)?;
        drop(statement);
        for entry in fs::read_dir(&self.attachments_dir).map_err(|error| {
            crate::utils::classify_fs_error(
                "inspect Agent Chat attachments",
                &self.attachments_dir,
                &error,
            )
        })? {
            let entry = entry.map_err(|error| {
                storage_error(format!(
                    "Could not inspect a staged chat attachment: {error}"
                ))
            })?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let canonical = match fs::canonicalize(&path) {
                Ok(canonical) if canonical.parent() == Some(self.attachments_dir.as_path()) => {
                    canonical
                }
                _ => continue,
            };
            if !referenced.contains(&canonical.to_string_lossy().into_owned()) {
                fs::remove_file(&canonical).map_err(|error| {
                    crate::utils::classify_fs_error(
                        "remove an unowned chat attachment",
                        &canonical,
                        &error,
                    )
                })?;
            }
        }
        Ok(())
    }

    pub(super) fn recover_threads(&self, threads: &mut [ChatThread]) -> Result<(), CommandError> {
        for thread in threads {
            if thread.checkout_status != "missing" {
                thread.checkout_status = "unknown".into();
            }
            thread.resume_status = "unknown".into();
            thread.provider_status = "unknown".into();
            thread.requests.clear();
            if matches!(thread.status.as_str(), "starting" | "running" | "waiting") {
                let was_initializing = thread.provider_thread_id.is_none();
                thread.status = if was_initializing {
                    "error"
                } else {
                    "interrupted"
                }
                .into();
                thread.turn_id = None;
                let message = if was_initializing {
                    "Ship Studio closed while creating the provider conversation. It was not retried; create a new chat to continue.".to_string()
                } else {
                    "Ship Studio closed while this turn was active. The turn was not replayed; check provider availability before continuing.".to_string()
                };
                thread.error = Some(message.clone());
                thread.items.push(ChatItem {
                    id: format!("restart-recovery:{}", thread.id),
                    turn_id: None,
                    kind: "activity".into(),
                    text: message,
                    status: Some("interrupted".into()),
                    attachments: Vec::new(),
                });
                thread.activity_cursor = thread.activity_cursor.saturating_add(1);
                thread.latest_activity_at = Some(chrono::Utc::now().timestamp_millis());
                thread.unread = thread.activity_cursor > thread.read_cursor;
                thread.revision = thread.revision.saturating_add(1);
                self.persist_thread(thread)?;
            }
        }
        Ok(())
    }

    fn prune_unused_attachments(&self) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let now = chrono::Utc::now().timestamp_millis();
        transaction
            .execute(
                "DELETE FROM staged_attachment_leases WHERE expires_at <= ?1",
                [now],
            )
            .map_err(storage_sql_error)?;
        let mut statement = transaction
            .prepare(
                "SELECT a.id, a.path FROM attachments a \
                 WHERE NOT EXISTS (SELECT 1 FROM attachment_owners o WHERE o.attachment_id = a.id) \
                   AND NOT EXISTS (SELECT 1 FROM draft_attachment_owners d WHERE d.attachment_id = a.id) \
                   AND NOT EXISTS (SELECT 1 FROM staged_attachment_leases l WHERE l.attachment_id = a.id AND l.expires_at > ?1)",
            )
            .map_err(storage_sql_error)?;
        let stale = statement
            .query_map([now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_sql_error)?;
        drop(statement);
        for (id, _) in &stale {
            transaction
                .execute("DELETE FROM attachments WHERE id = ?1", [id])
                .map_err(storage_sql_error)?;
        }
        transaction.commit().map_err(storage_sql_error)?;
        for (_, path) in stale {
            let path = PathBuf::from(path);
            if path.parent() == Some(self.attachments_dir.as_path()) && path.is_file() {
                if let Err(error) = fs::remove_file(&path) {
                    tracing::warn!(path = %path.display(), error = %error, "Unused Agent Chat attachment cleanup will retry at startup");
                }
            }
        }
        Ok(())
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, CommandError> {
        self.connection
            .lock()
            .map_err(|_| storage_error("Agent Chat storage is unavailable"))
    }
}

pub(super) fn recoverable_storage_error(error: &CommandError, store: Option<&ChatStore>) -> String {
    let database = store
        .map(|store| store.database_path().display().to_string())
        .unwrap_or_else(|| "the Agent Chat database".into());
    format!("{error} ({database})")
}

fn migrate(connection: &Connection) -> Result<(), CommandError> {
    let mut current: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage_sql_error)?;
    if current > SCHEMA_VERSION {
        return Err(storage_error(format!(
            "Agent Chat storage uses schema version {current}; this app supports up to {SCHEMA_VERSION}. The database was left unchanged."
        )));
    }
    if current == 0 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE projects (
                   id TEXT PRIMARY KEY NOT NULL,
                   git_common_dir TEXT NOT NULL UNIQUE,
                   last_path TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );
                 CREATE TABLE threads (
                   id TEXT PRIMARY KEY NOT NULL,
                   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   project_path TEXT NOT NULL,
                   checkout_path TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   thread_json TEXT NOT NULL
                 );
                 CREATE INDEX threads_project_activity ON threads(project_id, updated_at DESC);
                 CREATE TABLE messages (
                   thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                   ordinal INTEGER NOT NULL,
                   item_id TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   PRIMARY KEY(thread_id, item_id),
                   UNIQUE(thread_id, ordinal)
                 );
                 CREATE INDEX messages_thread_item ON messages(thread_id, item_id);
                 CREATE TABLE attachments (
                   id TEXT PRIMARY KEY NOT NULL,
                   path TEXT NOT NULL UNIQUE,
                   metadata_json TEXT NOT NULL
                 );
                 CREATE TABLE attachment_owners (
                   thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                   owner_kind TEXT NOT NULL,
                   owner_id TEXT NOT NULL,
                   ordinal INTEGER NOT NULL,
                   attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
                   PRIMARY KEY(thread_id, owner_kind, owner_id, ordinal)
                 );
                 CREATE TABLE provider_event_keys (
                   thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                   event_key TEXT NOT NULL,
                   recorded_at INTEGER NOT NULL,
                   PRIMARY KEY(thread_id, event_key)
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(storage_sql_error)?;
        current = 1;
    }
    if current == 1 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE threads ADD COLUMN checkout_identity TEXT NOT NULL DEFAULT '';
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(storage_sql_error)?;
        current = 2;
    }
    if current == 2 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE saved_drafts (
                   draft_id TEXT PRIMARY KEY NOT NULL,
                   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   checkout_path TEXT NOT NULL,
                   checkout_identity TEXT NOT NULL,
                   draft_json TEXT NOT NULL,
                   settings_json TEXT NOT NULL,
                   saved_at INTEGER NOT NULL,
                   state TEXT NOT NULL CHECK (state IN ('draft', 'promoted', 'discarded')),
                   promoted_thread_id TEXT UNIQUE
                 );
                 CREATE INDEX saved_drafts_checkout ON saved_drafts(project_id, checkout_identity, saved_at DESC);
                 CREATE TABLE draft_attachment_owners (
                   draft_id TEXT NOT NULL REFERENCES saved_drafts(draft_id) ON DELETE CASCADE,
                   ordinal INTEGER NOT NULL,
                   attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
                   PRIMARY KEY(draft_id, ordinal)
                 );
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(storage_sql_error)?;
        current = 3;
    }
    if current == 3 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE staged_attachment_leases (
                   attachment_id TEXT PRIMARY KEY NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
                   expires_at INTEGER NOT NULL
                 );
                 CREATE INDEX staged_attachment_lease_expiry ON staged_attachment_leases(expires_at);
                 PRAGMA user_version = 4;
                 COMMIT;",
            )
            .map_err(storage_sql_error)?;
    }
    Ok(())
}

fn check_integrity(connection: &Connection) -> Result<(), CommandError> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| {
            storage_error(format!(
                "Agent Chat database integrity check failed: {error}"
            ))
        })?;
    if result != "ok" {
        return Err(storage_error(format!(
            "Agent Chat database integrity check failed: {result}. The database was left unchanged."
        )));
    }
    Ok(())
}

fn persist_thread_in(
    transaction: &Transaction<'_>,
    thread: &ChatThread,
    attachments_dir: &Path,
) -> Result<(), CommandError> {
    let now = chrono::Utc::now().timestamp_millis();
    let created_at: i64 = transaction
        .query_row(
            "SELECT created_at FROM threads WHERE id = ?1",
            [&thread.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_sql_error)?
        .unwrap_or(now);
    let mut metadata = thread.clone();
    metadata.items.clear();
    metadata.requests.clear();
    let metadata_json = serde_json::to_string(&metadata).map_err(|error| {
        storage_error(format!("Could not encode an Agent Chat thread: {error}"))
    })?;
    transaction
        .execute(
            "INSERT INTO threads (id, project_id, project_path, checkout_path, checkout_identity, created_at, updated_at, thread_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, project_path=excluded.project_path, \
             checkout_path=excluded.checkout_path, checkout_identity=excluded.checkout_identity, \
             updated_at=excluded.updated_at, thread_json=excluded.thread_json",
            params![thread.id, thread.project_id, thread.project_path, thread.checkout_path, thread.checkout_identity, created_at, now, metadata_json],
        )
        .map_err(storage_sql_error)?;

    for item in &thread.items {
        let existing = transaction
            .query_row(
                "SELECT ordinal, payload FROM messages WHERE thread_id = ?1 AND item_id = ?2",
                params![thread.id, item.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_sql_error)?;
        let (message_ordinal, persisted_item) = if let Some((message_ordinal, payload)) = existing {
            let previous: ChatItem = serde_json::from_str(&payload).map_err(|error| {
                storage_error(format!(
                    "A stored Agent Chat message could not be decoded: {error}"
                ))
            })?;
            let mut persisted_item = item.clone();
            if item.text.ends_with(TRANSCRIPT_TRUNCATION_SUFFIX) {
                let visible_prefix = item
                    .text
                    .strip_suffix(TRANSCRIPT_TRUNCATION_SUFFIX)
                    .unwrap_or_default();
                if previous.text.starts_with(visible_prefix)
                    && previous.text.len() > item.text.len()
                {
                    persisted_item.text = previous.text;
                }
            }
            (message_ordinal, persisted_item)
        } else {
            let message_ordinal = transaction
                .query_row(
                    "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM messages WHERE thread_id = ?1",
                    [&thread.id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(storage_sql_error)?;
            (message_ordinal, item.clone())
        };
        let payload = serde_json::to_string(&persisted_item).map_err(|error| {
            storage_error(format!("Could not encode an Agent Chat message: {error}"))
        })?;
        transaction
            .execute(
                "INSERT INTO messages (thread_id, ordinal, item_id, payload) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(thread_id, item_id) DO UPDATE SET payload=excluded.payload",
                params![thread.id, message_ordinal, item.id, payload],
            )
            .map_err(storage_sql_error)?;
        transaction
            .execute(
                "DELETE FROM attachment_owners WHERE thread_id = ?1 AND owner_kind = 'message' AND owner_id = ?2",
                params![thread.id, item.id],
            )
            .map_err(storage_sql_error)?;
        for (attachment_ordinal, attachment) in item.attachments.iter().enumerate() {
            persist_attachment_owner(
                transaction,
                attachments_dir,
                &thread.id,
                "message",
                &item.id,
                attachment_ordinal,
                attachment,
            )?;
        }
    }
    transaction
        .execute(
            "DELETE FROM attachment_owners WHERE thread_id = ?1 AND owner_kind = 'draft'",
            [&thread.id],
        )
        .map_err(storage_sql_error)?;
    for (ordinal, attachment) in thread.draft.attachments.iter().enumerate() {
        persist_attachment_owner(
            transaction,
            attachments_dir,
            &thread.id,
            "draft",
            "",
            ordinal,
            attachment,
        )?;
    }
    Ok(())
}

fn persist_attachment_owner(
    transaction: &Transaction<'_>,
    attachments_dir: &Path,
    thread_id: &str,
    owner_kind: &str,
    owner_id: &str,
    ordinal: usize,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    persist_attachment_record(transaction, attachments_dir, attachment)?;
    transaction
        .execute(
            "INSERT INTO attachment_owners (thread_id, owner_kind, owner_id, ordinal, attachment_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![thread_id, owner_kind, owner_id, ordinal as i64, attachment.id],
        )
        .map_err(storage_sql_error)?;
    release_staged_attachment_lease(transaction, &attachment.id)?;
    Ok(())
}

fn persist_saved_draft_attachment_owner(
    transaction: &Transaction<'_>,
    attachments_dir: &Path,
    draft_id: &str,
    ordinal: usize,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    persist_attachment_record(transaction, attachments_dir, attachment)?;
    transaction
        .execute(
            "INSERT INTO draft_attachment_owners (draft_id, ordinal, attachment_id) VALUES (?1, ?2, ?3)",
            params![draft_id, ordinal as i64, attachment.id],
        )
        .map_err(storage_sql_error)?;
    release_staged_attachment_lease(transaction, &attachment.id)?;
    Ok(())
}

fn release_staged_attachment_lease(
    transaction: &Transaction<'_>,
    attachment_id: &str,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "DELETE FROM staged_attachment_leases WHERE attachment_id = ?1",
            [attachment_id],
        )
        .map_err(storage_sql_error)?;
    Ok(())
}

fn persist_attachment_record(
    transaction: &Transaction<'_>,
    attachments_dir: &Path,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    let parsed_id = Uuid::parse_str(&attachment.id).map_err(|_| invalid_attachment())?;
    if parsed_id.to_string() != attachment.id {
        return Err(invalid_attachment());
    }
    let path = PathBuf::from(&attachment.path);
    let canonical = match fs::canonicalize(&path) {
        Ok(canonical) => canonical,
        Err(_) if !attachment.available && path.parent() == Some(attachments_dir) => path,
        Err(_) => return Err(invalid_attachment()),
    };
    let parent = canonical.parent().ok_or_else(invalid_attachment)?;
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid_attachment)?;
    if parent != attachments_dir
        || !(file_name == attachment.id || file_name.starts_with(&format!("{}.", attachment.id)))
        || (attachment.available
            && (!canonical.is_file()
                || fs::metadata(&canonical).map_or(true, |meta| meta.len() != attachment.size)))
    {
        return Err(invalid_attachment());
    }
    let metadata = serde_json::to_string(attachment).map_err(|error| {
        storage_error(format!(
            "Could not encode chat attachment metadata: {error}"
        ))
    })?;
    transaction
        .execute(
            "INSERT INTO attachments (id, path, metadata_json) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET path=excluded.path, metadata_json=excluded.metadata_json",
            params![attachment.id, canonical.to_string_lossy(), metadata],
        )
        .map_err(storage_sql_error)?;
    Ok(())
}

fn reserve_staged_attachment_in(
    transaction: &Transaction<'_>,
    attachments_dir: &Path,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    persist_attachment_record(transaction, attachments_dir, attachment)?;
    let expires_at = chrono::Utc::now()
        .timestamp_millis()
        .saturating_add(STAGED_ATTACHMENT_LEASE_MS);
    transaction
        .execute(
            "INSERT INTO staged_attachment_leases (attachment_id, expires_at) VALUES (?1, ?2)",
            params![attachment.id, expires_at],
        )
        .map_err(storage_sql_error)?;
    Ok(())
}

fn mark_missing_attachments(directory: &Path, attachments: &mut [ChatAttachment]) {
    for attachment in attachments {
        let path = PathBuf::from(&attachment.path);
        let available = fs::canonicalize(&path).is_ok_and(|canonical| {
            canonical.parent() == Some(directory)
                && canonical.is_file()
                && fs::metadata(canonical).is_ok_and(|metadata| metadata.len() == attachment.size)
        });
        attachment.available = available;
    }
}

fn canonical_display(path: &Path) -> Result<String, CommandError> {
    fs::canonicalize(path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| {
            crate::utils::classify_fs_error("access Agent Chat project storage", path, &error)
        })
}

fn storage_sql_error(error: rusqlite::Error) -> CommandError {
    storage_error(format!("Agent Chat storage could not be updated: {error}"))
}

fn storage_error(message: impl Into<String>) -> CommandError {
    CommandError::Io {
        message: message.into(),
    }
}

fn invalid_attachment() -> CommandError {
    CommandError::Validation {
        field: "attachments".into(),
        reason: "An attachment is missing, changed, or was not staged by Ship Studio".into(),
    }
}

fn restrict_directory(path: &Path) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            crate::utils::classify_fs_error("secure Agent Chat storage", path, &error)
        })?;
    }
    Ok(())
}

fn restrict_file(path: &Path) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            crate::utils::classify_fs_error("secure the Agent Chat database", path, &error)
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::types::{ChatDraft, ChatSettings};
    use super::*;

    fn thread(project_path: &Path, items: Vec<ChatItem>) -> ChatThread {
        ChatThread {
            id: "thread-1".into(),
            project_id: "project-1".into(),
            project_path: project_path.to_string_lossy().into_owned(),
            checkout_path: project_path.to_string_lossy().into_owned(),
            checkout_identity: "checkout-1".into(),
            checkout_status: "available".into(),
            provider_id: "codex".into(),
            provider_thread_id: Some("provider-1".into()),
            resume_status: "available".into(),
            provider_status: "idle".into(),
            title: "Thread".into(),
            title_source: "prompt".into(),
            status: "idle".into(),
            turn_id: None,
            items,
            requests: Vec::new(),
            draft: ChatDraft::default(),
            settings: ChatSettings::default(),
            disposition: "active".into(),
            activity_cursor: 0,
            settled_cursor: None,
            read_cursor: 0,
            unread: false,
            latest_activity_at: Some(1),
            error: None,
            revision: 0,
        }
    }

    fn staged_attachment(directory: &Path, name: &str) -> ChatAttachment {
        let id = Uuid::new_v4().to_string();
        let path = directory.join(format!("{id}.png"));
        fs::write(&path, b"attachment bytes").expect("write staged attachment");
        ChatAttachment {
            id,
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".into(),
            size: 16,
            kind: "image".into(),
            available: true,
        }
    }

    #[test]
    fn migrations_create_transactional_thread_and_message_tables() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let connection =
            Connection::open(directory.path().join("threads.sqlite3")).expect("open test database");

        migrate(&connection).expect("apply initial migration");
        check_integrity(&connection).expect("database integrity check");

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read schema version");
        assert_eq!(version, SCHEMA_VERSION);
        let messages: String = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
                [],
                |row| row.get(0),
            )
            .expect("messages table exists");
        assert_eq!(messages, "messages");
    }

    #[test]
    fn staged_attachment_lease_bridges_stage_to_save_and_expires_cleanly() {
        let directory = tempfile::tempdir().expect("temporary lease storage");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir =
            fs::canonicalize(attachment_dir).expect("canonical attachment directory");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open lease database");
        migrate(&connection).expect("apply storage migrations");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params!["project-1", directory.path().to_string_lossy(), directory.path().to_string_lossy(), 1],
            )
            .expect("insert test project");
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir.clone(),
            database_path,
        };

        let attachment = staged_attachment(&attachment_dir, "capture.png");
        let attachment_path = PathBuf::from(&attachment.path);
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin staged ownership transaction");
            reserve_staged_attachment_in(&transaction, &attachment_dir, &attachment)
                .expect("record a temporary staged lease");
            transaction.commit().expect("commit staged lease");
        }
        store
            .cleanup_orphans()
            .expect("cleanup must preserve leased staged bytes");
        assert_eq!(
            fs::read(&attachment_path).expect("leased staged file remains"),
            b"attachment bytes"
        );
        let checked = store
            .recheck_attachments(&[attachment.clone()])
            .expect("recheck leased attachment");
        assert!(checked[0].available, "active lease confirms staged bytes");

        let draft_id = Uuid::new_v4().to_string();
        store
            .save_project_draft(&SavedChatDraft {
                draft_id: draft_id.clone(),
                project_id: "project-1".into(),
                checkout_path: directory.path().to_string_lossy().into_owned(),
                checkout_identity: "checkout-1".into(),
                checkout_status: "available".into(),
                draft: ChatDraft {
                    text: "Saved capture".into(),
                    attachments: vec![attachment.clone()],
                },
                settings: ChatSettings::default(),
                saved_at: 0,
                state: "draft".into(),
                promoted_thread_id: None,
            })
            .expect("transfer staged lease to saved draft owner");
        let lease_count: i64 = store
            .connection()
            .expect("access test database")
            .query_row(
                "SELECT COUNT(*) FROM staged_attachment_leases WHERE attachment_id = ?1",
                [&attachment.id],
                |row| row.get(0),
            )
            .expect("count staged lease");
        assert_eq!(lease_count, 0, "durable draft ownership replaces the lease");
        store
            .cleanup_orphans()
            .expect("cleanup retains the saved draft attachment");
        assert!(attachment_path.is_file());
        assert!(
            store
                .recheck_attachments(&[attachment.clone()])
                .expect("recheck saved draft attachment")[0]
                .available
        );

        store
            .delete_saved_draft("project-1", &draft_id)
            .expect("explicitly delete the saved draft");
        assert!(
            !attachment_path.exists(),
            "bytes are removed after their only durable owner is explicitly deleted"
        );
        assert!(
            !store
                .recheck_attachments(&[attachment])
                .expect("recheck explicitly deleted attachment")[0]
                .available
        );

        let expired = staged_attachment(&attachment_dir, "expired.png");
        let expired_path = PathBuf::from(&expired.path);
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin expired lease transaction");
            reserve_staged_attachment_in(&transaction, &attachment_dir, &expired)
                .expect("record expiring staged lease");
            transaction
                .execute(
                    "UPDATE staged_attachment_leases SET expires_at = ?2 WHERE attachment_id = ?1",
                    params![expired.id, chrono::Utc::now().timestamp_millis() - 1],
                )
                .expect("expire staged lease");
            transaction.commit().expect("commit expired lease");
        }
        store
            .cleanup_orphans()
            .expect("cleanup may remove expired, unowned bytes");
        assert!(!expired_path.exists());
        assert!(
            !store
                .recheck_attachments(&[expired])
                .expect("recheck expired attachment")[0]
                .available
        );
    }

    #[test]
    fn durable_history_keeps_order_attachments_and_full_text_when_the_live_view_moves() {
        let directory = tempfile::tempdir().expect("temporary persistence directory");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir =
            fs::canonicalize(attachment_dir).expect("canonical attachment directory");
        let database = directory.path().join("threads.sqlite3");
        let mut connection = Connection::open(database).expect("open test database");
        migrate(&connection).expect("apply storage migrations");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params!["project-1", directory.path().to_string_lossy(), directory.path().to_string_lossy(), 1],
            )
            .expect("insert test project");

        let first_attachment = staged_attachment(&attachment_dir, "first.png");
        let later_attachment = staged_attachment(&attachment_dir, "later.png");
        let full_text = "x".repeat(80 * 1024);
        let first_user = ChatItem {
            id: "user-1".into(),
            turn_id: Some("turn-1".into()),
            kind: "user".into(),
            text: "first prompt".into(),
            status: Some("completed".into()),
            attachments: vec![first_attachment],
        };
        let streamed_answer = ChatItem {
            id: "answer-1".into(),
            turn_id: Some("turn-1".into()),
            kind: "assistant".into(),
            text: full_text.clone(),
            status: Some("running".into()),
            attachments: Vec::new(),
        };
        let mut saved = thread(directory.path(), vec![first_user, streamed_answer.clone()]);
        let transaction = connection.transaction().expect("begin first persist");
        persist_thread_in(&transaction, &saved, &attachment_dir).expect("persist first window");
        transaction.commit().expect("commit first window");

        saved.items = vec![
            ChatItem {
                text: super::super::types::truncate_utf8(
                    &full_text,
                    super::super::types::MAX_ITEM_TEXT_BYTES,
                ),
                status: Some("completed".into()),
                ..streamed_answer
            },
            ChatItem {
                id: "later-user".into(),
                turn_id: Some("turn-2".into()),
                kind: "user".into(),
                text: "later prompt".into(),
                status: Some("completed".into()),
                attachments: vec![later_attachment],
            },
        ];
        let transaction = connection.transaction().expect("begin second persist");
        persist_thread_in(&transaction, &saved, &attachment_dir).expect("persist moved window");
        transaction.commit().expect("commit moved window");

        let rows = connection
            .prepare("SELECT item_id, ordinal, payload FROM messages WHERE thread_id = 'thread-1' ORDER BY ordinal")
            .expect("prepare ordered history query")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query ordered history")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect ordered history");
        assert_eq!(
            rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            ["user-1", "answer-1", "later-user"]
        );
        assert_eq!(rows.iter().map(|row| row.1).collect::<Vec<_>>(), [0, 1, 2]);
        let saved_answer: ChatItem = serde_json::from_str(&rows[1].2).expect("decode saved answer");
        assert_eq!(saved_answer.text, full_text);

        let owners: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM attachment_owners WHERE thread_id = 'thread-1'",
                [],
                |row| row.get(0),
            )
            .expect("count attachment owners");
        assert_eq!(owners, 2, "older saved message attachments remain owned");
    }

    #[test]
    fn saved_draft_survives_restart_keeps_owned_bytes_and_promotes_once() {
        let directory = tempfile::tempdir().expect("temporary saved-draft storage");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir =
            fs::canonicalize(attachment_dir).expect("canonical attachment directory");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply storage migrations");
        connection
            .execute_batch(
                "DROP TABLE staged_attachment_leases; DROP TABLE draft_attachment_owners; DROP TABLE saved_drafts; PRAGMA user_version = 2;",
            )
            .expect("prepare an existing v2 database");
        migrate(&connection).expect("upgrade existing v2 storage");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    "project-1",
                    directory.path().to_string_lossy(),
                    directory.path().to_string_lossy(),
                    1
                ],
            )
            .expect("insert test project");

        let attachment = staged_attachment(&attachment_dir, "capture.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let draft_id = Uuid::new_v4().to_string();
        let saved_draft = SavedChatDraft {
            draft_id: draft_id.clone(),
            project_id: "project-1".into(),
            checkout_path: directory.path().to_string_lossy().into_owned(),
            checkout_identity: "checkout-1".into(),
            checkout_status: "available".into(),
            draft: ChatDraft {
                text: "Saved before the first send".into(),
                attachments: vec![attachment],
            },
            settings: ChatSettings {
                model_id: Some("gpt-test".into()),
                reasoning_effort: Some("high".into()),
                auto_accept_mode: true,
            },
            saved_at: 0,
            state: "draft".into(),
            promoted_thread_id: None,
        };
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir.clone(),
            database_path: database_path.clone(),
        };
        store
            .save_project_draft(&saved_draft)
            .expect("commit the draft and attachment owner");
        store
            .cleanup_orphans()
            .expect("run startup cleanup without deleting owned bytes");
        assert_eq!(
            fs::read(&attachment_path).expect("read staged file"),
            b"attachment bytes"
        );
        drop(store);

        let reopened = ChatStore {
            connection: Mutex::new(Connection::open(&database_path).expect("reopen test database")),
            attachments_dir: attachment_dir.clone(),
            database_path: database_path.clone(),
        };
        let restored = reopened
            .list_saved_drafts("project-1", "checkout-1", 50, 0)
            .expect("restore saved drafts")
            .drafts
            .pop()
            .expect("saved draft is present after restart");
        assert_eq!(restored.draft.text, "Saved before the first send");
        assert_eq!(restored.settings.model_id.as_deref(), Some("gpt-test"));
        assert!(restored.draft.attachments[0].available);

        let mut promoted = thread(directory.path(), Vec::new());
        promoted.id = "promoted-thread".into();
        promoted.provider_thread_id = None;
        promoted.status = "starting".into();
        promoted.draft = restored.draft;
        promoted.settings = restored.settings;
        let (thread_id, created) = reopened
            .promote_saved_draft(&promoted, &draft_id)
            .expect("persist promotion before provider start");
        assert_eq!(thread_id, "promoted-thread");
        assert!(created);
        drop(reopened);

        let after_promotion_restart = ChatStore {
            connection: Mutex::new(
                Connection::open(&database_path).expect("reopen after promotion"),
            ),
            attachments_dir: attachment_dir.clone(),
            database_path: database_path.clone(),
        };
        let mut duplicate = promoted.clone();
        duplicate.id = "duplicate-thread-must-not-be-created".into();
        let (bound_thread_id, created_again) = after_promotion_restart
            .promote_saved_draft(&duplicate, &draft_id)
            .expect("retry promotion after restart");
        assert_eq!(bound_thread_id, "promoted-thread");
        assert!(!created_again);
        after_promotion_restart
            .cleanup_orphans()
            .expect("cleanup retains transferred thread attachment");
        assert_eq!(
            fs::read(&attachment_path).expect("attachment remains owned"),
            b"attachment bytes"
        );
        let owner_count: i64 = after_promotion_restart
            .connection()
            .expect("access test database")
            .query_row(
                "SELECT COUNT(*) FROM attachment_owners WHERE thread_id = 'promoted-thread' AND owner_kind = 'draft'",
                [],
                |row| row.get(0),
            )
            .expect("count transferred owners");
        assert_eq!(owner_count, 1);
    }
}
