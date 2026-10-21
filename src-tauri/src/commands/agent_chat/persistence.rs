//! App-owned durable storage for Agent Chat.
//!
//! SQLite is kept outside worktrees. Thread metadata and ordered display items
//! are committed together; attachment bytes live beside the database and are
//! referenced only by committed draft/message ownership rows.

use super::identity::{folder_instance_identity, refresh_copied_marker};
use super::types::{
    mark_unfinished_turns_interrupted, ChatAttachment, ChatDraft, ChatItem, ChatSettings,
    ChatThread, SavedChatDraft, SavedChatDraftPage, TRANSCRIPT_TRUNCATION_SUFFIX,
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

const SCHEMA_VERSION: u32 = 8;
const STAGED_ATTACHMENT_LEASE_MS: i64 = 24 * 60 * 60 * 1000;
const PLAIN_IDENTITY_PREFIX: &str = "plain:";
const UNLINKED_PLAIN_IDENTITY_PREFIX: &str = "plain-unlinked:";

pub(super) struct ChatStore {
    connection: Mutex<Connection>,
    attachments_dir: PathBuf,
    database_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProject {
    pub id: String,
    pub identity_key: String,
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
        main_checkout_path: Option<&Path>,
    ) -> Result<String, CommandError> {
        let common_dir = canonical_display(git_common_dir)?;
        let project_path = canonical_display(project_path)?;
        let main_checkout_path = main_checkout_path.map(canonical_display).transpose()?;
        let mut main_folder_instance_id = main_checkout_path
            .as_deref()
            .map(|path| folder_instance_identity(Path::new(path)))
            .transpose()?
            .flatten();
        let plain_key = main_checkout_path
            .as_ref()
            .map(|path| format!("{PLAIN_IDENTITY_PREFIX}{path}"));
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_sql_error)?;
        let git_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM projects WHERE git_common_dir = ?1",
                [&common_dir],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_sql_error)?;
        let plain_binding: Option<(String, Option<String>, String)> = if let Some(plain_key) =
            plain_key.as_ref()
        {
            transaction
                .query_row(
                    "SELECT id, folder_instance_id, last_path FROM projects WHERE git_common_dir = ?1",
                    [plain_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?)),
                )
                .optional()
                .map_err(storage_sql_error)?
        } else {
            None
        };
        let mut plain_id = None;
        if let Some((id, stored_instance_id, stored_path)) = plain_binding {
            let same_instance = stored_instance_id
                .as_deref()
                .zip(main_folder_instance_id.as_deref())
                .is_some_and(|(stored, current)| stored == current);
            if same_instance {
                plain_id = Some(id);
            } else {
                if stored_instance_id == main_folder_instance_id
                    && main_folder_instance_id
                        .as_deref()
                        .is_some_and(|identity| identity.starts_with("marker:"))
                    && folder_instance_identity(Path::new(&stored_path))?.as_deref()
                        == main_folder_instance_id.as_deref()
                {
                    let main_checkout_path = main_checkout_path.as_deref().ok_or_else(|| {
                        CommandError::expected(
                            "Git could not identify the original plain-folder checkout",
                        )
                    })?;
                    main_folder_instance_id = refresh_copied_marker(Path::new(main_checkout_path))?
                        .or(main_folder_instance_id);
                }
                transaction
                    .execute(
                        "UPDATE projects SET git_common_dir = ?2 WHERE id = ?1",
                        params![id, format!("{UNLINKED_PLAIN_IDENTITY_PREFIX}{id}")],
                    )
                    .map_err(storage_sql_error)?;
            }
        }
        if plain_id.is_none() {
            if let Some(instance_id) = main_folder_instance_id.as_deref() {
                let moved_plain_binding: Option<(String, String)> = transaction
                    .query_row(
                        "SELECT id, last_path FROM projects WHERE folder_instance_id = ?1 AND git_common_dir LIKE 'plain:%'",
                        [instance_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(storage_sql_error)?;
                if let Some((_id, prior_path)) = moved_plain_binding {
                    let current_main_path = main_checkout_path
                        .as_deref()
                        .map(str::to_owned)
                        .unwrap_or_default();
                    if prior_path != current_main_path {
                        let duplicate_marker = Path::new(&prior_path).is_dir()
                            && instance_id.starts_with("marker:")
                            && folder_instance_identity(Path::new(&prior_path))?.as_deref()
                                == Some(instance_id);
                        if duplicate_marker {
                            let main_checkout_path =
                                main_checkout_path.as_deref().ok_or_else(|| {
                                    CommandError::expected(
                                        "Git could not identify the original plain-folder checkout",
                                    )
                                })?;
                            let _ = refresh_copied_marker(Path::new(main_checkout_path))?;
                        } else {
                            return Err(CommandError::expected(
                                "This plain folder moved after its Agent Chat identity was saved. Explicitly relink the saved project before initializing Git here.",
                            ));
                        }
                    }
                }
            }
        }
        if git_id.is_some() && plain_id.is_some() && git_id != plain_id {
            return Err(CommandError::Validation {
                field: "projectPath".into(),
                reason: "This folder and repository already have different Agent Chat identities. Relink the saved identity explicitly before continuing.".into(),
            });
        }
        if let Some(id) = plain_id {
            let main_checkout_path = main_checkout_path.as_ref().ok_or_else(|| {
                CommandError::expected("Git could not identify the original plain-folder checkout")
            })?;
            let conflict: Option<String> = transaction
                .query_row(
                    "SELECT id FROM projects WHERE git_common_dir = ?1",
                    [&common_dir],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage_sql_error)?;
            if conflict.as_deref().is_some_and(|other| other != id) {
                return Err(CommandError::Validation {
                    field: "projectPath".into(),
                    reason: "This repository already has a different Agent Chat identity. Relink the saved identity explicitly before continuing.".into(),
                });
            }
            transaction
                .execute(
                    "UPDATE projects SET git_common_dir = ?2, last_path = ?3, \
                     pending_checkout_identity = COALESCE(pending_checkout_identity, id), \
                     pending_checkout_path = COALESCE(pending_checkout_path, ?4) WHERE id = ?1",
                    params![id, common_dir, project_path, main_checkout_path],
                )
                .map_err(storage_sql_error)?;
            transaction.commit().map_err(storage_sql_error)?;
            return Ok(id);
        }
        if let Some(id) = git_id {
            transaction
                .execute(
                    "UPDATE projects SET last_path = ?2 WHERE id = ?1",
                    params![id, project_path],
                )
                .map_err(storage_sql_error)?;
            transaction.commit().map_err(storage_sql_error)?;
            return Ok(id);
        }

        if main_checkout_path.is_none() {
            return Err(CommandError::expected(
                "Git could not identify a main checkout to resolve this project's saved Chat identity",
            ));
        }

        let id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at, folder_instance_id) VALUES (?1, ?2, ?3, ?4, NULL)",
                params![id, common_dir, project_path, chrono::Utc::now().timestamp_millis()],
            )
            .map_err(storage_sql_error)?;
        transaction.commit().map_err(storage_sql_error)?;
        Ok(id)
    }

    pub(super) fn ensure_plain_project(&self, project_path: &Path) -> Result<String, CommandError> {
        let project_path = canonical_display(project_path)?;
        let mut folder_instance_id = folder_instance_identity(Path::new(&project_path))?.ok_or_else(|| {
            CommandError::expected(
                "Ship Studio could not verify this folder's stable identity. Make the folder writable for its Agent Chat identity marker, then reload or explicitly relink saved conversations.",
            )
        })?;
        let identity_key = format!("{PLAIN_IDENTITY_PREFIX}{project_path}");
        let connection = self.connection()?;
        let previous_git_identity: Option<String> = connection
            .query_row(
                "SELECT id FROM projects WHERE last_path = ?1 AND git_common_dir NOT LIKE 'plain:%' AND git_common_dir NOT LIKE 'plain-unlinked:%'",
                [&project_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_sql_error)?;
        if previous_git_identity.is_some() {
            return Err(CommandError::expected(
                "Git metadata for this saved Agent Chat project is unavailable. Restore it or explicitly relink the saved project identity before continuing.",
            ));
        }

        let matching_instance: Option<(String, String)> = connection
            .query_row(
                "SELECT id, last_path FROM projects WHERE folder_instance_id = ?1 AND git_common_dir LIKE 'plain:%'",
                [&folder_instance_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_sql_error)?;
        if let Some((id, last_path)) = matching_instance {
            if last_path != project_path {
                if Path::new(&last_path).is_dir()
                    && folder_instance_id.starts_with("marker:")
                    && folder_instance_identity(Path::new(&last_path))?.as_deref()
                        == Some(folder_instance_id.as_str())
                {
                    if let Some(new_instance_id) = refresh_copied_marker(Path::new(&project_path))?
                    {
                        folder_instance_id = new_instance_id;
                    } else {
                        return Err(CommandError::expected(
                            "This saved plain-folder chat belongs to a folder that moved. Explicitly relink the saved project before using Chat here.",
                        ));
                    }
                } else {
                    return Err(CommandError::expected(
                        "This saved plain-folder chat belongs to a folder that moved. Explicitly relink the saved project before using Chat here.",
                    ));
                }
            } else {
                return Ok(id);
            }
        }

        let path_binding: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT id, folder_instance_id FROM projects WHERE git_common_dir = ?1",
                [&identity_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_sql_error)?;
        if let Some((id, stored_instance_id)) = path_binding {
            if stored_instance_id.as_deref() == Some(folder_instance_id.as_str()) {
                connection
                    .execute(
                        "UPDATE projects SET last_path = ?2 WHERE id = ?1",
                        params![id, project_path],
                    )
                    .map_err(storage_sql_error)?;
                return Ok(id);
            }
            connection
                .execute(
                    "UPDATE projects SET git_common_dir = ?2 WHERE id = ?1",
                    params![id, format!("{UNLINKED_PLAIN_IDENTITY_PREFIX}{id}")],
                )
                .map_err(storage_sql_error)?;
        }

        let id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at, folder_instance_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, identity_key, project_path, chrono::Utc::now().timestamp_millis(), folder_instance_id],
            )
            .map_err(storage_sql_error)?;
        Ok(id)
    }

    pub(super) fn pending_checkout_binding(
        &self,
        project_id: &str,
    ) -> Result<Option<(String, String)>, CommandError> {
        let (identity, path): (Option<String>, Option<String>) = self
            .connection()?
            .query_row(
                "SELECT pending_checkout_identity, pending_checkout_path FROM projects WHERE id = ?1",
                [project_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .map_err(storage_sql_error)?;
        match (identity, path) {
            (Some(identity), Some(path)) => Ok(Some((identity, path))),
            (None, None) => Ok(None),
            _ => Err(storage_error(
                "The pending Agent Chat checkout migration is incomplete",
            )),
        }
    }

    pub(super) fn clear_pending_checkout_binding(
        &self,
        project_id: &str,
        identity: &str,
        checkout_path: &str,
    ) -> Result<(), CommandError> {
        self.connection()?
            .execute(
                "UPDATE projects SET pending_checkout_identity = NULL, pending_checkout_path = NULL \
                 WHERE id = ?1 AND pending_checkout_identity = ?2 AND pending_checkout_path = ?3",
                params![project_id, identity, checkout_path],
            )
            .map_err(storage_sql_error)?;
        Ok(())
    }

    pub(super) fn relink_project(
        &self,
        project_id: &str,
        identity_key: &str,
        project_path: &Path,
        folder_instance_id: Option<&str>,
    ) -> Result<String, CommandError> {
        let project_path = canonical_display(project_path)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        let source: Option<(String, String)> = transaction
            .query_row(
                "SELECT git_common_dir, last_path FROM projects WHERE id = ?1",
                [project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_sql_error)?;
        let (source_identity, source_path) = source.ok_or_else(|| {
            CommandError::expected("The stored Agent Chat project identity is unavailable")
        })?;
        let source_is_plain = source_identity.starts_with(PLAIN_IDENTITY_PREFIX)
            || source_identity.starts_with(UNLINKED_PLAIN_IDENTITY_PREFIX);
        let target_is_plain = identity_key.starts_with(PLAIN_IDENTITY_PREFIX);
        if source_is_plain != target_is_plain {
            let has_data: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM threads WHERE project_id = ?1) \
                     OR EXISTS(SELECT 1 FROM saved_drafts WHERE project_id = ?1 AND state != 'discarded')",
                    [project_id],
                    |row| row.get(0),
                )
                .map_err(storage_sql_error)?;
            if has_data {
                return Err(CommandError::Validation {
                    field: "projectPath".into(),
                    reason: if source_is_plain {
                        "Plain-folder Agent Chat history can be relinked only to another plain folder. Relink the folder first, then initialize Git in that registered folder to preserve its checkout identity.".into()
                    } else {
                        "Git-backed Agent Chat history must be relinked to a Git repository so its checkout bindings remain valid. Restore the Git metadata or leave the saved project unlinked.".into()
                    },
                });
            }
        }
        let existing: Option<String> = transaction
            .query_row(
                "SELECT id FROM projects WHERE git_common_dir = ?1",
                [identity_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_sql_error)?;
        if let Some(existing_id) = existing.filter(|existing| existing != project_id) {
            let target_has_data: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM threads WHERE project_id = ?1) OR EXISTS(SELECT 1 FROM saved_drafts WHERE project_id = ?1 AND state != 'discarded')",
                    [&existing_id],
                    |row| row.get(0),
                )
                .map_err(storage_sql_error)?;
            if target_has_data {
                return Err(CommandError::Validation {
                    field: "projectPath".into(),
                    reason: "This folder or repository already has saved Agent Chat data under a different identity. The histories were left separate.".into(),
                });
            }
            transaction
                .execute("DELETE FROM projects WHERE id = ?1", [&existing_id])
                .map_err(storage_sql_error)?;
        }
        let changed = transaction
            .execute(
                "UPDATE projects SET git_common_dir = ?2, last_path = ?3, \
                 pending_checkout_identity = NULL, pending_checkout_path = NULL, \
                 folder_instance_id = ?4 WHERE id = ?1",
                params![project_id, identity_key, project_path, folder_instance_id],
            )
            .map_err(storage_sql_error)?;
        if changed == 0 {
            return Err(CommandError::expected(
                "The stored Agent Chat project identity is unavailable",
            ));
        }
        let mut statement = transaction
            .prepare("SELECT id, thread_json, checkout_identity FROM threads WHERE project_id = ?1")
            .map_err(storage_sql_error)?;
        let saved = statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_sql_error)?;
        drop(statement);
        for (thread_id, encoded, checkout_identity) in saved {
            let mut thread: ChatThread = serde_json::from_str(&encoded).map_err(|error| {
                storage_error(format!(
                    "A stored Agent Chat thread could not be decoded: {error}"
                ))
            })?;
            thread.project_path = project_path.clone();
            // checkout_identity is intentionally omitted from thread_json for
            // IPC, so restore it from its authoritative SQL column before
            // deciding which plain-folder binding may move.
            thread.checkout_identity = checkout_identity;
            if source_is_plain
                && target_is_plain
                && thread.checkout_identity == project_id
                && thread.checkout_path == source_path
            {
                thread.checkout_path = project_path.clone();
                thread.checkout_status = "available".into();
            }
            thread.revision = thread.revision.saturating_add(1);
            let mut metadata = thread.clone();
            metadata.items.clear();
            metadata.requests.clear();
            let metadata_json = serde_json::to_string(&metadata).map_err(|error| {
                storage_error(format!("Could not encode an Agent Chat thread: {error}"))
            })?;
            transaction
                .execute(
                    "UPDATE threads SET project_path = ?2, checkout_path = ?3, thread_json = ?4 WHERE id = ?1",
                    params![thread_id, project_path, thread.checkout_path, metadata_json],
                )
                .map_err(storage_sql_error)?;
        }
        if source_is_plain && target_is_plain {
            transaction
                .execute(
                    "UPDATE saved_drafts SET checkout_path = ?3 \
                     WHERE project_id = ?1 AND checkout_identity = ?4 AND checkout_path = ?2",
                    params![project_id, source_path, project_path, project_id],
                )
                .map_err(storage_sql_error)?;
        }
        transaction.commit().map_err(storage_sql_error)?;
        Ok(source_path)
    }

    pub(super) fn list_unlinked_projects(&self) -> Result<Vec<StoredProject>, CommandError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.git_common_dir, p.last_path, COUNT(t.id), p.folder_instance_id \
                 FROM projects p LEFT JOIN threads t ON t.project_id = p.id \
                 GROUP BY p.id ORDER BY MAX(t.updated_at) DESC, p.created_at DESC",
            )
            .map_err(storage_sql_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    StoredProject {
                        id: row.get(0)?,
                        identity_key: row.get(1)?,
                        last_path: row.get(2)?,
                        thread_count: row.get::<_, i64>(3)?.max(0) as u64,
                    },
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(storage_sql_error)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map(|projects| {
                projects
                    .into_iter()
                    .filter(|(project, folder_instance_id)| {
                        let plain = project.identity_key.starts_with(PLAIN_IDENTITY_PREFIX);
                        let current_path = Path::new(&project.last_path);
                        let folder_identity_mismatch = plain
                            && folder_instance_id.as_deref().is_some_and(|stored| {
                                folder_instance_identity(current_path)
                                    .ok()
                                    .flatten()
                                    .as_deref()
                                    != Some(stored)
                            });
                        project
                            .identity_key
                            .starts_with(UNLINKED_PLAIN_IDENTITY_PREFIX)
                            || (plain && (folder_instance_id.is_none() || folder_identity_mismatch))
                            || !current_path.is_dir()
                            || (!plain
                                && !project
                                    .identity_key
                                    .starts_with(UNLINKED_PLAIN_IDENTITY_PREFIX)
                                && !Path::new(&project.identity_key).is_dir())
                    })
                    .map(|(project, _)| project)
                    .collect()
            })
            .map_err(storage_sql_error)
    }

    pub(super) fn persist_thread(&self, thread: &ChatThread) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_sql_error)?;
        persist_thread_in(&transaction, thread, &self.attachments_dir, None)?;
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
        project_id: &str,
    ) -> Result<ChatAttachment, CommandError> {
        // Acquire the SQLite write lock before creating the file. Cleanup uses
        // the same database lock, so it cannot observe the new bytes as
        // unowned between the copy and the lease commit.
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_sql_error)?;
        let (attachment, content_sha256) = super::attachments::stage(app, source_path)?;
        let reserve = reserve_staged_attachment_in(
            &transaction,
            &self.attachments_dir,
            &attachment,
            &content_sha256,
            project_id,
        );
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
        project_id: &str,
        attachments: &[ChatAttachment],
    ) -> Result<Vec<ChatAttachment>, CommandError> {
        let connection = self.connection()?;
        let now = chrono::Utc::now().timestamp_millis();
        attachments
            .iter()
            .map(|attachment| {
                let in_project = super::attachments::attachment_scope_is_valid(
                    &connection,
                    &attachment.id,
                    project_id,
                    super::attachments::AttachmentOwnerScope::Project,
                    now,
                )
                .map_err(storage_sql_error)?;
                let saved_record = connection
                    .query_row(
                        "SELECT metadata_json, content_sha256 FROM attachments \
                         WHERE id = ?1 AND path = ?2 AND project_id = ?3",
                        params![attachment.id, attachment.path, project_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                    .optional()
                    .map_err(storage_sql_error)?;
                let (matches_saved_identity, content_sha256) = saved_record
                    .map(|(encoded, content_sha256)| {
                        serde_json::from_str::<ChatAttachment>(&encoded)
                            .map(|saved| {
                                (same_attachment_identity(&saved, attachment), content_sha256)
                            })
                            .map_err(|error| {
                                storage_error(format!(
                                    "A stored chat attachment could not be decoded: {error}"
                                ))
                            })
                    })
                    .transpose()?
                    .unwrap_or((false, None));
                let mut checked = attachment.clone();
                checked.available = in_project
                    && matches_saved_identity
                    && super::attachments::staged_file_is_valid(
                        &self.attachments_dir,
                        attachment,
                        content_sha256.as_deref(),
                    );
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
        persist_thread_in(&transaction, thread, &self.attachments_dir, None)?;
        transaction.commit().map_err(storage_sql_error)?;
        drop(connection);
        if let Err(error) = self.prune_unused_attachments() {
            tracing::warn!(error = %error, "Unused Agent Chat attachment cleanup will retry at startup");
        }
        Ok(true)
    }

    pub(super) fn delete_thread(&self, thread_id: &str) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_sql_error)?;
        // Retain only the draft ID, project scope, and discarded state as a
        // tombstone. Save and promotion both serialize through SQLite and
        // reject that state, so delayed requests cannot recreate this content.
        transaction
            .execute(
                "DELETE FROM draft_attachment_owners WHERE draft_id IN \
                 (SELECT draft_id FROM saved_drafts WHERE promoted_thread_id = ?1)",
                [thread_id],
            )
            .map_err(storage_sql_error)?;
        transaction
            .execute(
                "UPDATE saved_drafts SET checkout_path = '', checkout_identity = '', \
                 draft_json = '{}', settings_json = '{}', saved_at = 0, \
                 state = 'discarded', promoted_thread_id = NULL \
                 WHERE promoted_thread_id = ?1",
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
                let owner_scope = promoted_thread_id
                    .as_deref()
                    .map(
                        |thread_id| super::attachments::AttachmentOwnerScope::Thread {
                            thread_id,
                            source_draft_id: Some(&draft_id),
                        },
                    )
                    .unwrap_or_else(|| {
                        super::attachments::AttachmentOwnerScope::SavedDraft(&draft_id)
                    });
                mark_missing_attachments(
                    &connection,
                    &self.attachments_dir,
                    &project_id,
                    owner_scope,
                    &mut draft.attachments,
                )?;
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
                 WHERE project_id = ?1 AND draft_id = ?2 AND state != 'discarded'",
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
                let owner_scope = promoted_thread_id
                    .as_deref()
                    .map(
                        |thread_id| super::attachments::AttachmentOwnerScope::Thread {
                            thread_id,
                            source_draft_id: Some(&draft_id),
                        },
                    )
                    .unwrap_or_else(|| {
                        super::attachments::AttachmentOwnerScope::SavedDraft(&draft_id)
                    });
                mark_missing_attachments(
                    &connection,
                    &self.attachments_dir,
                    &project_id,
                    owner_scope,
                    &mut draft.attachments,
                )?;
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
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_sql_error)?;
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
            if state != "draft" {
                return Err(CommandError::expected(
                    "This saved draft has already been promoted or discarded",
                ));
            }
            if project_id != draft.project_id
                || checkout_path != draft.checkout_path
                || identity != draft.checkout_identity
            {
                return Err(CommandError::Validation {
                    field: "draftId".into(),
                    reason: "This draft belongs to a different project or checkout".into(),
                });
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
        for attachment in &draft.draft.attachments {
            if !super::attachments::attachment_scope_is_valid(
                &transaction,
                &attachment.id,
                &draft.project_id,
                super::attachments::AttachmentOwnerScope::SavedDraft(&draft.draft_id),
                chrono::Utc::now().timestamp_millis(),
            )
            .map_err(storage_sql_error)?
            {
                return Err(invalid_attachment());
            }
        }
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
                &draft.project_id,
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
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_sql_error)?;
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
        if existing.2 == "discarded" {
            return Err(CommandError::expected("This saved draft was discarded"));
        }
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
        persist_thread_in(&transaction, thread, &self.attachments_dir, Some(draft_id))?;
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
                mark_missing_attachments(
                    &connection,
                    &self.attachments_dir,
                    &thread.project_id,
                    super::attachments::AttachmentOwnerScope::Thread {
                        thread_id: &thread.id,
                        source_draft_id: None,
                    },
                    &mut item.attachments,
                )?;
            }
            mark_missing_attachments(
                &connection,
                &self.attachments_dir,
                &thread.project_id,
                super::attachments::AttachmentOwnerScope::Thread {
                    thread_id: &thread.id,
                    source_draft_id: None,
                },
                &mut thread.draft.attachments,
            )?;
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
            let thread_was_active =
                matches!(thread.status.as_str(), "starting" | "running" | "waiting");
            let recovered_at = chrono::Utc::now().timestamp_millis();
            let recovered_record = mark_unfinished_turns_interrupted(thread, recovered_at);
            if thread_was_active || recovered_record {
                let was_initializing = thread.provider_thread_id.is_none();
                if thread_was_active {
                    thread.status = if was_initializing {
                        "error"
                    } else {
                        "interrupted"
                    }
                    .into();
                }
                thread.turn_id = None;
                if thread_was_active {
                    let message = if was_initializing {
                        "Ship Studio closed while creating the provider conversation. It was not retried; create a new chat to continue.".to_string()
                    } else {
                        "Ship Studio closed while this turn was active. The turn was not replayed; check provider availability before continuing.".to_string()
                    };
                    thread.error = Some(message.clone());
                    if !thread
                        .items
                        .iter()
                        .any(|item| item.id == format!("restart-recovery:{}", thread.id))
                    {
                        thread.items.push(ChatItem {
                            id: format!("restart-recovery:{}", thread.id),
                            turn_id: None,
                            kind: "activity".into(),
                            text: message,
                            status: Some("interrupted".into()),
                            attachments: Vec::new(),
                        });
                    }
                } else if !thread
                    .items
                    .iter()
                    .any(|item| item.id == format!("restart-recovery:{}", thread.id))
                {
                    thread.items.push(ChatItem {
                        id: format!("restart-recovery:{}", thread.id),
                        turn_id: None,
                        kind: "activity".into(),
                        text: "An unfinished turn was marked interrupted during recovery. It was not replayed.".into(),
                        status: Some("interrupted".into()),
                        attachments: Vec::new(),
                    });
                }
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
        current = 4;
    }
    if current == 4 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE projects ADD COLUMN pending_checkout_identity TEXT;
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(storage_sql_error)?;
        current = 5;
    }
    if current == 5 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE projects ADD COLUMN pending_checkout_path TEXT;
                 UPDATE projects SET pending_checkout_path = last_path \
                   WHERE pending_checkout_identity IS NOT NULL;
                 PRAGMA user_version = 6;
                 COMMIT;",
            )
            .map_err(storage_sql_error)?;
        current = 6;
    }
    if current == 6 {
        // Existing rows stay NULL: schema v6 did not store a trusted byte
        // digest, so migration must not bless whatever bytes happen to exist.
        let result = connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE attachments ADD COLUMN content_sha256 TEXT;
             PRAGMA user_version = 7;
             COMMIT;",
        );
        if let Err(error) = result {
            // execute_batch leaves an explicit transaction open when one of
            // its statements fails. Roll it back so a failed upgrade does not
            // strand this connection in a partial migration.
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(storage_sql_error(error));
        }
        current = 7;
    }
    if current == 7 {
        migrate_v7_to_v8(connection)?;
    }
    Ok(())
}

fn migrate_v7_to_v8(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute_batch("BEGIN IMMEDIATE;")
        .map_err(storage_sql_error)?;
    let migration = (|| {
        connection
            .execute_batch(
                "ALTER TABLE projects ADD COLUMN folder_instance_id TEXT;
                 ALTER TABLE attachments ADD COLUMN project_id TEXT;
                 CREATE UNIQUE INDEX projects_folder_instance_unique \
                   ON projects(folder_instance_id) WHERE folder_instance_id IS NOT NULL;
                 PRAGMA user_version = 8;",
            )
            .map_err(storage_sql_error)?;
        let owners = {
            let mut statement = connection
                .prepare(
                    "SELECT attachment_id, project_id FROM (\
                       SELECT o.attachment_id, t.project_id FROM attachment_owners o \
                         JOIN threads t ON t.id = o.thread_id \
                       UNION \
                       SELECT d.attachment_id, s.project_id FROM draft_attachment_owners d \
                         JOIN saved_drafts s ON s.draft_id = d.draft_id\
                     ) ORDER BY attachment_id, project_id",
                )
                .map_err(storage_sql_error)?;
            let owners = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage_sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_sql_error)?;
            owners
        };
        let mut owner_projects =
            std::collections::HashMap::<String, std::collections::HashSet<String>>::new();
        for (attachment_id, project_id) in owners {
            owner_projects
                .entry(attachment_id)
                .or_default()
                .insert(project_id);
        }
        for (attachment_id, projects) in owner_projects {
            if let Some(project_id) = (projects.len() == 1)
                .then(|| projects.into_iter().next())
                .flatten()
            {
                connection
                    .execute(
                        "UPDATE attachments SET project_id = ?2 WHERE id = ?1",
                        params![attachment_id, project_id],
                    )
                    .map_err(storage_sql_error)?;
            }
        }
        Ok(())
    })();

    if let Err(error) = migration {
        let _ = connection.execute_batch("ROLLBACK;");
        return Err(error);
    }
    if let Err(error) = connection.execute_batch("COMMIT;") {
        let _ = connection.execute_batch("ROLLBACK;");
        return Err(storage_sql_error(error));
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
    source_draft_id: Option<&str>,
) -> Result<(), CommandError> {
    let now = chrono::Utc::now().timestamp_millis();
    let owner_scope = super::attachments::AttachmentOwnerScope::Thread {
        thread_id: &thread.id,
        source_draft_id,
    };
    for attachment in thread
        .items
        .iter()
        .flat_map(|item| item.attachments.iter())
        .chain(thread.draft.attachments.iter())
    {
        if !super::attachments::attachment_scope_is_valid(
            transaction,
            &attachment.id,
            &thread.project_id,
            owner_scope,
            now,
        )
        .map_err(storage_sql_error)?
        {
            return Err(invalid_attachment());
        }
    }
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
                &thread.project_id,
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
            &thread.project_id,
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
    project_id: &str,
    thread_id: &str,
    owner_kind: &str,
    owner_id: &str,
    ordinal: usize,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    persist_attachment_record(transaction, attachments_dir, project_id, attachment)?;
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
    project_id: &str,
    draft_id: &str,
    ordinal: usize,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    persist_attachment_record(transaction, attachments_dir, project_id, attachment)?;
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
    project_id: &str,
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
    let saved_metadata = transaction
        .query_row(
            "SELECT metadata_json FROM attachments WHERE id = ?1 AND path = ?2 AND project_id = ?3",
            params![attachment.id, canonical.to_string_lossy(), project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_sql_error)?
        .ok_or_else(invalid_attachment)?;
    let saved = serde_json::from_str::<ChatAttachment>(&saved_metadata).map_err(|error| {
        storage_error(format!(
            "Stored chat attachment metadata could not be decoded: {error}"
        ))
    })?;
    if !same_attachment_identity(&saved, attachment) {
        return Err(invalid_attachment());
    }
    Ok(())
}

fn reserve_staged_attachment_in(
    transaction: &Transaction<'_>,
    attachments_dir: &Path,
    attachment: &ChatAttachment,
    content_sha256: &str,
    project_id: &str,
) -> Result<(), CommandError> {
    record_staged_attachment_in(
        transaction,
        attachments_dir,
        attachment,
        content_sha256,
        project_id,
    )?;
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

fn record_staged_attachment_in(
    transaction: &Transaction<'_>,
    attachments_dir: &Path,
    attachment: &ChatAttachment,
    content_sha256: &str,
    project_id: &str,
) -> Result<(), CommandError> {
    let parsed_id = Uuid::parse_str(&attachment.id).map_err(|_| invalid_attachment())?;
    if parsed_id.to_string() != attachment.id
        || content_sha256.len() != 64
        || !content_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_attachment());
    }
    let path = dunce::canonicalize(&attachment.path).map_err(|_| invalid_attachment())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid_attachment)?;
    if path.parent() != Some(attachments_dir)
        || !(file_name == attachment.id || file_name.starts_with(&format!("{}.", attachment.id)))
        || !path.is_file()
        || fs::metadata(&path).map_or(true, |metadata| metadata.len() != attachment.size)
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
            "INSERT INTO attachments (id, path, metadata_json, content_sha256, project_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![attachment.id, path.to_string_lossy(), metadata, content_sha256, project_id],
        )
        .map_err(storage_sql_error)?;
    Ok(())
}

fn mark_missing_attachments(
    connection: &Connection,
    directory: &Path,
    project_id: &str,
    owner_scope: super::attachments::AttachmentOwnerScope<'_>,
    attachments: &mut [ChatAttachment],
) -> Result<(), CommandError> {
    for attachment in attachments {
        let now = chrono::Utc::now().timestamp_millis();
        let in_scope = super::attachments::attachment_scope_is_valid(
            connection,
            &attachment.id,
            project_id,
            owner_scope,
            now,
        )
        .map_err(storage_sql_error)?;
        let saved_record = connection
            .query_row(
                "SELECT metadata_json, content_sha256 FROM attachments \
                 WHERE id = ?1 AND path = ?2 AND project_id = ?3",
                params![attachment.id, attachment.path, project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(storage_sql_error)?;
        let available = if let Some((encoded, digest)) = saved_record {
            let saved = serde_json::from_str::<ChatAttachment>(&encoded).map_err(|error| {
                storage_error(format!(
                    "Stored chat attachment metadata could not be decoded: {error}"
                ))
            })?;
            in_scope
                && same_attachment_identity(&saved, attachment)
                && super::attachments::staged_file_is_valid(
                    directory,
                    attachment,
                    digest.as_deref(),
                )
        } else {
            false
        };
        attachment.available = available;
    }
    Ok(())
}

fn same_attachment_identity(saved: &ChatAttachment, candidate: &ChatAttachment) -> bool {
    saved.id == candidate.id
        && saved.name == candidate.name
        && saved.path == candidate.path
        && saved.mime_type == candidate.mime_type
        && saved.size == candidate.size
        && saved.kind == candidate.kind
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
    use super::super::attachments;
    use super::super::types::{ChatDraft, ChatSettings, ChatTurnRecord};
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
            approval_policy: None,
            sandbox_policy: None,
            turns: Vec::new(),
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

    #[test]
    fn legacy_thread_json_defaults_provider_policies_and_turn_records() {
        let mut legacy = serde_json::to_value(thread(Path::new("/project"), Vec::new()))
            .expect("encode legacy-compatible thread");
        let fields = legacy.as_object_mut().expect("thread object");
        fields.remove("approvalPolicy");
        fields.remove("sandboxPolicy");
        fields.remove("turns");

        let restored: ChatThread =
            serde_json::from_value(legacy).expect("decode pre-turn-record thread JSON");

        assert_eq!(restored.approval_policy, None);
        assert_eq!(restored.sandbox_policy, None);
        assert!(restored.turns.is_empty());
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
        let digest_column: String = connection
            .query_row(
                "SELECT name FROM pragma_table_info('attachments') WHERE name = 'content_sha256'",
                [],
                |row| row.get(0),
            )
            .expect("attachments store trusted content digests");
        assert_eq!(digest_column, "content_sha256");
    }

    #[test]
    fn v6_migration_preserves_legacy_bytes_as_integrity_unknown() {
        let directory = tempfile::tempdir().expect("temporary migration fixture");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let attachment = staged_attachment(&attachment_dir, "legacy.png");
        let owned_attachment = staged_attachment(&attachment_dir, "owned-legacy.png");
        let cross_project_attachment = staged_attachment(&attachment_dir, "shared-legacy.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("create current schema");
        connection
            .execute_batch(
                "DROP INDEX projects_folder_instance_unique;
                 ALTER TABLE projects DROP COLUMN folder_instance_id;
                 ALTER TABLE attachments DROP COLUMN project_id;
                 ALTER TABLE attachments DROP COLUMN content_sha256;
                 PRAGMA user_version = 6;",
            )
            .expect("prepare a v6 database without a digest column");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at, pending_checkout_identity, pending_checkout_path) \
                 VALUES ('project-1', 'git-common', 'project-path', 1, 'checkout-1', 'checkout-path')",
                [],
            )
            .expect("insert a v6 project with a pending checkout binding");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) \
                 VALUES ('project-2', 'other-git-common', 'other-project-path', 2)",
                [],
            )
            .expect("insert second v6 project");
        for (thread_id, project_id) in [("thread-1", "project-1"), ("thread-2", "project-2")] {
            connection
                .execute(
                    "INSERT INTO threads (id, project_id, project_path, checkout_path, checkout_identity, created_at, updated_at, thread_json) \
                     VALUES (?1, ?2, 'path', 'path', 'checkout', 1, 1, '{}')",
                    params![thread_id, project_id],
                )
                .expect("insert v6 attachment owner thread");
        }
        let metadata = serde_json::to_string(&attachment).expect("encode legacy metadata");
        connection
            .execute(
                "INSERT INTO attachments (id, path, metadata_json) VALUES (?1, ?2, ?3)",
                params![attachment.id, attachment.path, metadata],
            )
            .expect("insert a v6 attachment row");
        for (owned, owner_threads) in [
            (&owned_attachment, vec!["thread-1"]),
            (&cross_project_attachment, vec!["thread-1", "thread-2"]),
        ] {
            let metadata = serde_json::to_string(&owned).expect("encode owned legacy metadata");
            connection
                .execute(
                    "INSERT INTO attachments (id, path, metadata_json) VALUES (?1, ?2, ?3)",
                    params![owned.id, owned.path, metadata],
                )
                .expect("insert owned legacy attachment");
            for owner_thread in owner_threads {
                connection
                    .execute(
                        "INSERT INTO attachment_owners (thread_id, owner_kind, owner_id, ordinal, attachment_id) \
                         VALUES (?1, 'draft', ?2, 0, ?2)",
                        params![owner_thread, owned.id],
                    )
                    .expect("insert explicit legacy attachment owner");
            }
        }
        connection
            .execute(
                "INSERT INTO staged_attachment_leases (attachment_id, expires_at) VALUES (?1, ?2)",
                params![
                    attachment.id,
                    chrono::Utc::now().timestamp_millis() + 60_000
                ],
            )
            .expect("insert ownerless legacy staging lease");

        migrate(&connection).expect("upgrade the v6 database");

        let digest: Option<String> = connection
            .query_row(
                "SELECT content_sha256 FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| row.get(0),
            )
            .expect("read migrated integrity state");
        assert_eq!(digest, None, "migration must not bless current bytes");
        let migrated_project_scope = |attachment_id: &str| {
            connection
                .query_row(
                    "SELECT project_id FROM attachments WHERE id = ?1",
                    [attachment_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("read migrated project scope")
        };
        assert_eq!(
            migrated_project_scope(&attachment.id),
            None,
            "ownerless leases stay unscoped"
        );
        assert_eq!(
            migrated_project_scope(&owned_attachment.id),
            Some("project-1".into()),
            "one explicit owner relation scopes a legacy attachment"
        );
        assert_eq!(
            migrated_project_scope(&cross_project_attachment.id),
            None,
            "conflicting project owners remain unscoped"
        );
        assert!(
            attachments::staged_file_is_valid(&attachment_dir, &attachment, digest.as_deref(),),
            "legacy bytes with unknown integrity remain available under the v6 structural checks"
        );
        assert_eq!(
            fs::read(&attachment_path).expect("legacy attachment bytes remain"),
            b"attachment bytes"
        );
        let pending_binding: (String, String) = connection
            .query_row(
                "SELECT pending_checkout_identity, pending_checkout_path FROM projects WHERE id = 'project-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("pending checkout binding survives digest migration");
        assert_eq!(
            pending_binding,
            ("checkout-1".into(), "checkout-path".into())
        );
        check_integrity(&connection).expect("migrated database remains sound");
    }

    #[test]
    fn future_schema_and_corrupt_database_are_left_untouched() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let future_path = directory.path().join("future.sqlite3");
        let future = Connection::open(&future_path).expect("open future-version fixture");
        future
            .execute_batch("PRAGMA user_version = 99;")
            .expect("mark database as newer than this app");
        assert!(migrate(&future).is_err(), "future schemas must be rejected");
        let future_version: u32 = future
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read unchanged future schema version");
        assert_eq!(future_version, 99);

        let corrupt_path = directory.path().join("corrupt.sqlite3");
        let corrupt_bytes = b"not a SQLite database";
        fs::write(&corrupt_path, corrupt_bytes).expect("write corrupt database fixture");
        let corrupt = Connection::open(&corrupt_path).expect("open corrupt database handle");
        assert!(
            check_integrity(&corrupt).is_err(),
            "corruption must be reported"
        );
        drop(corrupt);
        assert_eq!(
            fs::read(&corrupt_path).expect("corrupt database remains available for recovery"),
            corrupt_bytes
        );
    }

    #[test]
    fn failed_v6_migration_rolls_back_schema_version_and_preserves_bytes() {
        let directory = tempfile::tempdir().expect("temporary migration rollback fixture");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let attachment = staged_attachment(&attachment_dir, "rollback.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let connection = Connection::open(directory.path().join("threads.sqlite3"))
            .expect("open rollback database");
        migrate(&connection).expect("create current schema");
        let digest = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash rollback fixture attachment");
        let metadata = serde_json::to_string(&attachment).expect("encode rollback metadata");
        connection
            .execute(
                "INSERT INTO attachments (id, path, metadata_json, content_sha256) VALUES (?1, ?2, ?3, ?4)",
                params![attachment.id, attachment.path, metadata, digest],
            )
            .expect("insert attachment before failed migration");
        connection
            .execute_batch("PRAGMA user_version = 6;")
            .expect("simulate a version marker ahead of the migration");

        assert!(
            migrate(&connection).is_err(),
            "duplicate column should abort upgrade"
        );

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read schema version after failed migration");
        assert_eq!(version, 6, "failed migration must not advance user_version");
        let saved_digest: String = connection
            .query_row(
                "SELECT content_sha256 FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| row.get(0),
            )
            .expect("existing digest survives failed migration");
        assert_eq!(saved_digest, digest);
        assert_eq!(
            fs::read(&attachment_path).expect("attachment bytes survive failed migration"),
            b"attachment bytes"
        );
    }

    #[test]
    fn failed_v8_migration_rolls_back_schema_version_and_preserves_bytes() {
        let directory = tempfile::tempdir().expect("temporary v8 migration rollback fixture");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(&attachment_dir).expect("canonical attachment dir");
        let attachment = staged_attachment(&attachment_dir, "v7-owned.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open v8 rollback database");
        migrate(&connection).expect("create current schema");
        connection
            .execute_batch(
                "DROP INDEX projects_folder_instance_unique;
                 ALTER TABLE projects DROP COLUMN folder_instance_id;
                 ALTER TABLE attachments DROP COLUMN project_id;
                 PRAGMA user_version = 7;",
            )
            .expect("prepare a schema v7 database");
        let digest = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash v7 attachment");
        let metadata = serde_json::to_string(&attachment).expect("encode v7 metadata");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) \
                 VALUES ('project-v7', 'git-common-v7', 'project-path-v7', 1)",
                [],
            )
            .expect("insert v7 project");
        connection
            .execute(
                "INSERT INTO threads (id, project_id, project_path, checkout_path, checkout_identity, created_at, updated_at, thread_json) \
                 VALUES ('thread-v7', 'project-v7', 'project-path-v7', 'project-path-v7', 'checkout-v7', 1, 1, '{}')",
                [],
            )
            .expect("insert v7 attachment owner thread");
        connection
            .execute(
                "INSERT INTO attachments (id, path, metadata_json, content_sha256) VALUES (?1, ?2, ?3, ?4)",
                params![attachment.id, attachment.path, metadata, digest],
            )
            .expect("insert v7 attachment");
        connection
            .execute(
                "INSERT INTO attachment_owners (thread_id, owner_kind, owner_id, ordinal, attachment_id) \
                 VALUES ('thread-v7', 'message', 'user-v7', 0, ?1)",
                [&attachment.id],
            )
            .expect("link attachment to its v7 project owner");
        connection
            .execute_batch(
                "CREATE TRIGGER force_v8_backfill_failure BEFORE UPDATE ON attachments \
                 BEGIN SELECT RAISE(ABORT, 'forced v8 migration failure'); END;",
            )
            .expect("install v8 backfill failure trigger");

        assert!(
            migrate(&connection).is_err(),
            "forced v8 backfill must fail"
        );

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read schema version after failed v8 migration");
        assert_eq!(version, 7, "failed migration must keep the prior version");
        assert!(
            connection.is_autocommit(),
            "failed migration must roll back"
        );
        let project_identity_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'folder_instance_id'",
                [],
                |row| row.get(0),
            )
            .expect("inspect prior projects schema");
        let attachment_scope_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('attachments') WHERE name = 'project_id'",
                [],
                |row| row.get(0),
            )
            .expect("inspect prior attachments schema");
        let identity_index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'projects_folder_instance_unique'",
                [],
                |row| row.get(0),
            )
            .expect("inspect prior index set");
        assert_eq!(project_identity_column_count, 0);
        assert_eq!(attachment_scope_column_count, 0);
        assert_eq!(identity_index_count, 0);
        let saved_digest: String = connection
            .query_row(
                "SELECT content_sha256 FROM attachments WHERE id = ?1",
                [&attachment.id],
                |row| row.get(0),
            )
            .expect("read attachment digest after failed v8 migration");
        assert_eq!(saved_digest, digest);
        assert_eq!(
            fs::read(&attachment_path).expect("attachment bytes survive failed v8 migration"),
            b"attachment bytes"
        );
    }

    #[test]
    fn plain_identity_migrates_when_non_main_checkout_opens_first() {
        let directory = tempfile::tempdir().expect("temporary project and database");
        let project_path = directory.path().join("project");
        let worktree_path = directory.path().join("worktree");
        let git_common_dir = project_path.join(".git");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&git_common_dir).expect("create project and Git metadata");
        fs::create_dir_all(worktree_path.join(".git-admin"))
            .expect("create secondary worktree metadata");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply migrations");
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir,
            database_path,
        };

        let project_id = store
            .ensure_plain_project(&project_path)
            .expect("register plain folder");
        let mut saved_thread = thread(&project_path, Vec::new());
        saved_thread.project_id = project_id.clone();
        saved_thread.checkout_identity = project_id.clone();
        store
            .persist_thread(&saved_thread)
            .expect("persist plain-folder conversation");
        let draft_id = Uuid::new_v4().to_string();
        store
            .save_project_draft(&SavedChatDraft {
                draft_id: draft_id.clone(),
                project_id: project_id.clone(),
                checkout_path: dunce::canonicalize(&project_path)
                    .expect("canonical project path")
                    .to_string_lossy()
                    .into_owned(),
                checkout_identity: project_id.clone(),
                checkout_status: "available".into(),
                draft: ChatDraft {
                    text: "Saved before Git was initialized".into(),
                    attachments: Vec::new(),
                },
                settings: ChatSettings {
                    model_id: Some("model-before-git".into()),
                    reasoning_effort: Some("high".into()),
                    auto_accept_mode: true,
                },
                saved_at: 0,
                state: "draft".into(),
                promoted_thread_id: None,
            })
            .expect("persist plain-folder draft");

        let transitioned_id = store
            .ensure_project(&git_common_dir, &worktree_path, Some(&project_path))
            .expect("resolve the plain identity from the main checkout");
        assert_eq!(transitioned_id, project_id);
        let (pending_identity, pending_path) = store
            .pending_checkout_binding(&project_id)
            .expect("read pending checkout binding")
            .expect("Git transition has a pending checkout binding");
        assert_eq!(
            pending_path,
            dunce::canonicalize(&project_path)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );

        // Reopening the secondary worktree before the main checkout remains
        // idempotent across an app restart while the main marker is pending.
        assert_eq!(
            store
                .ensure_project(&git_common_dir, &worktree_path, Some(&project_path))
                .expect("reuse the migrated repository identity"),
            project_id
        );
        assert_eq!(
            store
                .pending_checkout_binding(&project_id)
                .expect("read pending binding after restart")
                .expect("main checkout binding remains pending")
                .1,
            pending_path
        );

        let marker_identity = super::super::commands::checkout_marker_identity_with_default(
            &git_common_dir,
            Some(&pending_identity),
        )
        .expect("seed the main checkout with its prior plain-folder identity");
        assert_eq!(marker_identity, project_id);
        store
            .clear_pending_checkout_binding(&project_id, &pending_identity, &pending_path)
            .expect("finish the checkout marker handoff");
        let connection = store.connection().expect("read transitioned project");
        let (identity_key, pending_identity, pending_path):
            (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT git_common_dir, pending_checkout_identity, pending_checkout_path FROM projects WHERE id = ?1",
                [&project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read migrated project row");
        assert_eq!(
            identity_key,
            dunce::canonicalize(&git_common_dir)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(pending_identity, None);
        assert_eq!(pending_path, None);
        let thread_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM threads WHERE project_id = ?1",
                [&project_id],
                |row| row.get(0),
            )
            .expect("count retained conversations");
        let draft_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM saved_drafts WHERE project_id = ?1 AND draft_id = ?2",
                params![project_id, draft_id],
                |row| row.get(0),
            )
            .expect("count retained drafts");
        assert_eq!(thread_count, 1);
        assert_eq!(draft_count, 1);
    }

    #[test]
    fn replaced_plain_folder_gets_new_identity_and_old_history_stays_recoverable() {
        let directory = tempfile::tempdir().expect("temporary project and database");
        let project_path = directory.path().join("project");
        let moved_original = directory.path().join("original-folder");
        fs::create_dir(&project_path).expect("create original project folder");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply storage migrations");
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir,
            database_path,
        };

        let original_id = store
            .ensure_plain_project(&project_path)
            .expect("register original folder identity");
        let mut saved_thread = thread(&project_path, Vec::new());
        saved_thread.project_id = original_id.clone();
        saved_thread.checkout_identity = original_id.clone();
        store
            .persist_thread(&saved_thread)
            .expect("save history under original folder identity");

        fs::rename(&project_path, &moved_original).expect("move original folder away");
        fs::create_dir(&project_path).expect("replace the original folder path");
        let replacement_id = store
            .ensure_plain_project(&project_path)
            .expect("register replacement folder as a new identity");
        assert_ne!(replacement_id, original_id);
        assert_eq!(
            store
                .ensure_plain_project(&project_path)
                .expect("reopen same physical replacement folder"),
            replacement_id
        );

        let old_key: String = store
            .connection()
            .expect("access test database")
            .query_row(
                "SELECT git_common_dir FROM projects WHERE id = ?1",
                [&original_id],
                |row| row.get(0),
            )
            .expect("read preserved old project identity");
        assert!(old_key.starts_with(UNLINKED_PLAIN_IDENTITY_PREFIX));
        let unlinked = store
            .list_unlinked_projects()
            .expect("list recoverable identities while replacement path exists");
        assert_eq!(unlinked.len(), 1);
        assert_eq!(unlinked[0].id, original_id);
        let preserved_threads = store.load_threads().expect("load preserved history");
        assert_eq!(
            preserved_threads
                .iter()
                .filter(|thread| thread.project_id == original_id)
                .count(),
            1
        );
    }

    #[test]
    fn explicit_plain_folder_relink_moves_root_bindings_and_keeps_worktree_drafts() {
        let directory = tempfile::tempdir().expect("temporary project and database");
        let old_path = directory.path().join("old-project");
        let new_path = directory.path().join("moved-project");
        let worktree_path = directory.path().join("worktree");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&old_path).expect("create original project");
        fs::create_dir_all(&new_path).expect("create moved project");
        fs::create_dir_all(&worktree_path).expect("create worktree");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply migrations");
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir,
            database_path,
        };

        let project_id = store
            .ensure_plain_project(&old_path)
            .expect("register original plain folder");
        let old_path = dunce::canonicalize(old_path)
            .expect("canonical original project")
            .to_string_lossy()
            .into_owned();
        let new_path = dunce::canonicalize(new_path)
            .expect("canonical moved project")
            .to_string_lossy()
            .into_owned();
        let worktree_path = dunce::canonicalize(worktree_path)
            .expect("canonical worktree")
            .to_string_lossy()
            .into_owned();

        let mut root_thread = thread(Path::new(&old_path), Vec::new());
        root_thread.id = "plain-root-thread".into();
        root_thread.project_id = project_id.clone();
        root_thread.project_path = old_path.clone();
        root_thread.checkout_path = old_path.clone();
        root_thread.checkout_identity = project_id.clone();
        store
            .persist_thread(&root_thread)
            .expect("persist plain-root conversation");

        let mut worktree_thread = thread(Path::new(&worktree_path), Vec::new());
        worktree_thread.id = "git-worktree-thread".into();
        worktree_thread.project_id = project_id.clone();
        worktree_thread.project_path = old_path.clone();
        worktree_thread.checkout_path = worktree_path.clone();
        worktree_thread.checkout_identity = "git-worktree-marker".into();
        store
            .persist_thread(&worktree_thread)
            .expect("persist separate worktree conversation");

        let root_draft_id = Uuid::new_v4().to_string();
        let worktree_draft_id = Uuid::new_v4().to_string();
        for (draft_id, checkout_path, checkout_identity, text) in [
            (
                &root_draft_id,
                &old_path,
                project_id.clone(),
                "plain root draft",
            ),
            (
                &worktree_draft_id,
                &worktree_path,
                "git-worktree-marker".to_string(),
                "worktree draft",
            ),
        ] {
            store
                .save_project_draft(&SavedChatDraft {
                    draft_id: draft_id.clone(),
                    project_id: project_id.clone(),
                    checkout_path: checkout_path.clone(),
                    checkout_identity,
                    checkout_status: "available".into(),
                    draft: ChatDraft {
                        text: text.into(),
                        attachments: Vec::new(),
                    },
                    settings: ChatSettings::default(),
                    saved_at: 0,
                    state: "draft".into(),
                    promoted_thread_id: None,
                })
                .expect("persist project draft");
        }

        let new_folder_instance_id =
            folder_instance_identity(Path::new(&new_path)).expect("read moved folder identity");
        store
            .relink_project(
                &project_id,
                &format!("{PLAIN_IDENTITY_PREFIX}{new_path}"),
                Path::new(&new_path),
                new_folder_instance_id.as_deref(),
            )
            .expect("explicitly relink moved plain folder");

        let threads = store.load_threads().expect("load relinked conversations");
        let root_thread = threads
            .iter()
            .find(|thread| thread.id == "plain-root-thread")
            .expect("find original root conversation");
        assert_eq!(root_thread.project_path, new_path);
        assert_eq!(root_thread.checkout_path, new_path);
        assert_eq!(root_thread.checkout_identity, project_id);
        assert_eq!(root_thread.checkout_status, "available");
        let worktree_thread = threads
            .iter()
            .find(|thread| thread.id == "git-worktree-thread")
            .expect("find worktree conversation");
        assert_eq!(worktree_thread.project_path, new_path);
        assert_eq!(worktree_thread.checkout_path, worktree_path);
        assert_eq!(worktree_thread.checkout_identity, "git-worktree-marker");

        let root_drafts = store
            .list_saved_drafts(&project_id, &project_id, 50, 0)
            .expect("load moved root drafts");
        assert_eq!(root_drafts.drafts.len(), 1);
        assert_eq!(root_drafts.drafts[0].draft_id, root_draft_id);
        assert_eq!(root_drafts.drafts[0].checkout_path, new_path);
        let worktree_drafts = store
            .list_saved_drafts(&project_id, "git-worktree-marker", 50, 0)
            .expect("load unchanged worktree drafts");
        assert_eq!(worktree_drafts.drafts.len(), 1);
        assert_eq!(worktree_drafts.drafts[0].draft_id, worktree_draft_id);
        assert_eq!(worktree_drafts.drafts[0].checkout_path, worktree_path);
    }

    #[test]
    fn git_backed_history_cannot_be_relinked_to_a_plain_folder() {
        let directory = tempfile::tempdir().expect("temporary project and database");
        let git_project = directory.path().join("git-project");
        let plain_project = directory.path().join("plain-project");
        let git_common_dir = git_project.join(".git");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&git_common_dir).expect("create Git metadata directory");
        fs::create_dir_all(&plain_project).expect("create plain target");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply migrations");
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir,
            database_path,
        };

        let project_id = store
            .ensure_project(&git_common_dir, &git_project, Some(&git_project))
            .expect("register Git project");
        let mut saved_thread = thread(&git_project, Vec::new());
        saved_thread.project_id = project_id.clone();
        saved_thread.checkout_identity = "git-checkout-marker".into();
        store
            .persist_thread(&saved_thread)
            .expect("persist Git-backed conversation");

        let plain_identity = format!(
            "{PLAIN_IDENTITY_PREFIX}{}",
            dunce::canonicalize(&plain_project)
                .expect("canonical plain target")
                .display()
        );
        let plain_folder_instance_id =
            folder_instance_identity(&plain_project).expect("read plain target identity");
        let error = store
            .relink_project(
                &project_id,
                &plain_identity,
                &plain_project,
                plain_folder_instance_id.as_deref(),
            )
            .expect_err("reject relink that would strand Git checkout bindings");
        assert!(error.to_string().contains("Git-backed Agent Chat history"));
        let identity_key: String = store
            .connection()
            .expect("access test database")
            .query_row(
                "SELECT git_common_dir FROM projects WHERE id = ?1",
                [&project_id],
                |row| row.get(0),
            )
            .expect("read unchanged Git identity");
        assert_eq!(
            identity_key,
            dunce::canonicalize(git_common_dir)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
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
        let content_sha256 = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash staged fixture attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin staged ownership transaction");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &attachment,
                &content_sha256,
                "project-1",
            )
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
            .recheck_attachments("project-1", &[attachment.clone()])
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
                .recheck_attachments("project-1", &[attachment.clone()])
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
                .recheck_attachments("project-1", &[attachment])
                .expect("recheck explicitly deleted attachment")[0]
                .available
        );

        let expired = staged_attachment(&attachment_dir, "expired.png");
        let expired_path = PathBuf::from(&expired.path);
        let expired_digest = attachments::digest_file(&expired_path, expired.size)
            .expect("hash staged fixture attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin expired lease transaction");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &expired,
                &expired_digest,
                "project-1",
            )
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
                .recheck_attachments("project-1", &[expired])
                .expect("recheck expired attachment")[0]
                .available
        );
    }

    #[test]
    fn staged_attachment_scope_rejects_another_projects_recheck_draft_and_thread() {
        let directory = tempfile::tempdir().expect("temporary attachment scope storage");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply storage migrations");
        for project_id in ["project-a", "project-b"] {
            connection
                .execute(
                    "INSERT INTO projects (id, git_common_dir, last_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![project_id, format!("{project_id}-identity"), directory.path().to_string_lossy(), 1],
                )
                .expect("insert test project");
        }
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir.clone(),
            database_path,
        };
        let attachment = staged_attachment(&attachment_dir, "project-a.png");
        let digest = attachments::digest_file(Path::new(&attachment.path), attachment.size)
            .expect("hash staged attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin attachment staging transaction");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &attachment,
                &digest,
                "project-a",
            )
            .expect("stage attachment for project A");
            transaction
                .commit()
                .expect("commit scoped attachment lease");
        }

        assert!(
            store
                .recheck_attachments("project-a", &[attachment.clone()])
                .expect("recheck attachment for owner project")[0]
                .available
        );
        assert!(
            !store
                .recheck_attachments("project-b", &[attachment.clone()])
                .expect("recheck from another project returns unavailable")[0]
                .available
        );

        let draft_id = Uuid::new_v4().to_string();
        let rejected_draft = SavedChatDraft {
            draft_id,
            project_id: "project-b".into(),
            checkout_path: directory.path().to_string_lossy().into_owned(),
            checkout_identity: "checkout-b".into(),
            checkout_status: "available".into(),
            draft: ChatDraft {
                text: "must not inherit project A bytes".into(),
                attachments: vec![attachment.clone()],
            },
            settings: ChatSettings::default(),
            saved_at: 0,
            state: "draft".into(),
            promoted_thread_id: None,
        };
        assert!(store.save_project_draft(&rejected_draft).is_err());

        let mut thread_b = thread(
            directory.path(),
            vec![ChatItem {
                id: "user-b".into(),
                turn_id: None,
                kind: "user".into(),
                text: "must not send project A bytes".into(),
                status: Some("sending".into()),
                attachments: vec![attachment],
            }],
        );
        thread_b.id = "thread-b".into();
        thread_b.project_id = "project-b".into();
        assert!(store.persist_thread(&thread_b).is_err());
        assert!(
            store
                .load_threads()
                .expect("list B history after rejected attachment")
                .iter()
                .filter(|thread| thread.project_id == "project-b")
                .count()
                == 0
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
        let first_digest =
            attachments::digest_file(Path::new(&first_attachment.path), first_attachment.size)
                .expect("hash first fixture attachment");
        let later_digest =
            attachments::digest_file(Path::new(&later_attachment.path), later_attachment.size)
                .expect("hash later fixture attachment");
        let full_text = "x".repeat(80 * 1024);
        let first_user = ChatItem {
            id: "user-1".into(),
            turn_id: Some("turn-1".into()),
            kind: "user".into(),
            text: "first prompt".into(),
            status: Some("completed".into()),
            attachments: vec![first_attachment.clone()],
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
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin first attachment transaction");
        reserve_staged_attachment_in(
            &transaction,
            &attachment_dir,
            &first_attachment,
            &first_digest,
            "project-1",
        )
        .expect("reserve first attachment");
        persist_thread_in(&transaction, &saved, &attachment_dir, None)
            .expect("persist first window");
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
                attachments: vec![later_attachment.clone()],
            },
        ];
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin attachment registration transaction");
        reserve_staged_attachment_in(
            &transaction,
            &attachment_dir,
            &later_attachment,
            &later_digest,
            "project-1",
        )
        .expect("reserve later attachment");
        persist_thread_in(&transaction, &saved, &attachment_dir, None)
            .expect("persist moved window");
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
    fn file_backed_restart_loads_ordered_history_settings_provider_id_and_attachment_bytes() {
        let directory = tempfile::tempdir().expect("temporary restart fixture");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
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
            database_path: database_path.clone(),
        };
        let attachment = staged_attachment(&attachment_dir, "screen.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let digest = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash staged attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin attachment registration");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &attachment,
                &digest,
                "project-1",
            )
            .expect("register staged attachment bytes");
            transaction
                .commit()
                .expect("commit staged attachment lease");
        }

        let mut saved = thread(
            directory.path(),
            vec![
                ChatItem {
                    id: "user-first".into(),
                    turn_id: Some("turn-1".into()),
                    kind: "user".into(),
                    text: "Inspect this capture".into(),
                    status: Some("completed".into()),
                    attachments: vec![attachment],
                },
                ChatItem {
                    id: "assistant-second".into(),
                    turn_id: Some("turn-1".into()),
                    kind: "assistant".into(),
                    text: "I can see the capture.".into(),
                    status: Some("completed".into()),
                    attachments: Vec::new(),
                },
            ],
        );
        saved.provider_thread_id = Some("provider-thread-77".into());
        saved.settings = ChatSettings {
            model_id: Some("gpt-test".into()),
            reasoning_effort: Some("high".into()),
            auto_accept_mode: true,
        };
        saved.status = "running".into();
        saved.approval_policy = Some(serde_json::json!({ "type": "on-request" }));
        saved.sandbox_policy = Some(serde_json::json!({ "type": "workspace-write" }));
        saved.turns.push(ChatTurnRecord {
            id: "attempt-1".into(),
            provider_turn_id: Some("turn-1".into()),
            user_item_id: "user-first".into(),
            outcome: "running".into(),
            settings: ChatSettings {
                model_id: Some("gpt-turn-snapshot".into()),
                reasoning_effort: Some("medium".into()),
                auto_accept_mode: false,
            },
            approval_policy: saved.approval_policy.clone(),
            sandbox_policy: saved.sandbox_policy.clone(),
            baseline_known: true,
            baseline_last_item_id: None,
            reconciliation: None,
            started_at: 10,
            finished_at: None,
        });
        store
            .persist_thread(&saved)
            .expect("persist durable conversation");
        drop(store);

        let reopened = ChatStore {
            connection: Mutex::new(Connection::open(&database_path).expect("reopen database")),
            attachments_dir: attachment_dir,
            database_path,
        };
        let restored = reopened.load_threads().expect("load after process restart");
        assert_eq!(restored.len(), 1);
        let mut restored = restored;
        assert_eq!(restored[0].turns[0].outcome, "running");
        assert_eq!(
            restored[0].turns[0].settings.model_id.as_deref(),
            Some("gpt-turn-snapshot")
        );
        assert_eq!(
            restored[0].approval_policy,
            Some(serde_json::json!({ "type": "on-request" }))
        );
        reopened
            .recover_threads(&mut restored)
            .expect("recover an interrupted provider turn");
        assert_eq!(restored[0].turns[0].outcome, "interrupted");
        assert!(restored[0].turns[0].finished_at.is_some());
        let restored = &restored[0];
        assert_eq!(
            restored
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [
                "user-first",
                "assistant-second",
                "restart-recovery:thread-1"
            ]
        );
        let recovery_notice = &restored.items[2];
        assert_eq!(recovery_notice.kind, "activity");
        assert_eq!(recovery_notice.turn_id, None);
        assert_eq!(recovery_notice.status.as_deref(), Some("interrupted"));
        assert_eq!(
            recovery_notice.text,
            "Ship Studio closed while this turn was active. The turn was not replayed; check provider availability before continuing."
        );

        let durably_recovered = reopened
            .load_threads()
            .expect("load durably recovered conversation after restart");
        assert_eq!(durably_recovered.len(), 1);
        let durably_recovered = &durably_recovered[0];
        assert_eq!(durably_recovered.status, "interrupted");
        assert_eq!(durably_recovered.turns[0].outcome, "interrupted");
        assert!(durably_recovered.turns[0].finished_at.is_some());
        assert_eq!(
            durably_recovered
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [
                "user-first",
                "assistant-second",
                "restart-recovery:thread-1"
            ]
        );
        let durable_recovery_notice = &durably_recovered.items[2];
        assert_eq!(durable_recovery_notice.kind, "activity");
        assert_eq!(durable_recovery_notice.turn_id, None);
        assert_eq!(
            durable_recovery_notice.status.as_deref(),
            Some("interrupted")
        );
        assert_eq!(
            durable_recovery_notice.text,
            "Ship Studio closed while this turn was active. The turn was not replayed; check provider availability before continuing."
        );
        assert_eq!(
            durably_recovered
                .items
                .iter()
                .filter(|item| item.id == "restart-recovery:thread-1")
                .count(),
            1
        );
        assert_eq!(
            durably_recovered.provider_thread_id.as_deref(),
            Some("provider-thread-77")
        );
        assert_eq!(
            durably_recovered.settings.model_id.as_deref(),
            Some("gpt-test")
        );
        assert_eq!(
            durably_recovered.settings.reasoning_effort.as_deref(),
            Some("high")
        );
        assert!(durably_recovered.settings.auto_accept_mode);
        assert!(durably_recovered.items[0].attachments[0].available);
        assert_eq!(
            fs::read(&attachment_path).expect("owned attachment bytes survive restart"),
            b"attachment bytes"
        );
    }

    #[test]
    fn recovery_finishes_a_stale_running_turn_after_shutdown_already_interrupted_thread() {
        let directory = tempfile::tempdir().expect("temporary shutdown recovery fixture");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
        migrate(&connection).expect("apply storage migrations");
        connection
            .execute(
                "INSERT INTO projects (id, git_common_dir, last_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params!["project-1", directory.path().to_string_lossy(), directory.path().to_string_lossy(), 1],
            )
            .expect("insert test project");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let store = ChatStore {
            connection: Mutex::new(connection),
            attachments_dir: attachment_dir.clone(),
            database_path: database_path.clone(),
        };
        let mut saved = thread(directory.path(), Vec::new());
        saved.status = "interrupted".into();
        saved.turns.push(ChatTurnRecord {
            id: "attempt-left-running-by-legacy-shutdown".into(),
            provider_turn_id: Some("provider-turn-1".into()),
            user_item_id: "user-1".into(),
            outcome: "running".into(),
            settings: ChatSettings::default(),
            approval_policy: None,
            sandbox_policy: None,
            baseline_known: true,
            baseline_last_item_id: None,
            reconciliation: None,
            started_at: 10,
            finished_at: None,
        });
        store
            .persist_thread(&saved)
            .expect("persist interrupted thread with legacy running record");
        drop(store);

        let reopened = ChatStore {
            connection: Mutex::new(Connection::open(&database_path).expect("reopen database")),
            attachments_dir: attachment_dir,
            database_path,
        };
        let mut restored = reopened.load_threads().expect("load interrupted thread");
        reopened
            .recover_threads(&mut restored)
            .expect("normalize stale turn record on reload");
        assert_eq!(restored[0].status, "interrupted");
        assert_eq!(restored[0].turns[0].outcome, "interrupted");
        assert!(restored[0].turns[0].finished_at.is_some());
        assert_eq!(
            restored
                .iter()
                .flat_map(|thread| thread.items.iter())
                .filter(|item| item.id == "restart-recovery:thread-1")
                .count(),
            1,
            "recovery adds one durable interruption notice"
        );
    }

    #[test]
    fn same_size_attachment_replacement_is_unavailable_after_recheck_and_restart() {
        let directory = tempfile::tempdir().expect("temporary mutation fixture");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
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
            database_path: database_path.clone(),
        };
        let attachment = staged_attachment(&attachment_dir, "same-size.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let digest = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash original attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin attachment registration");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &attachment,
                &digest,
                "project-1",
            )
            .expect("register original attachment digest");
            transaction
                .commit()
                .expect("commit staged attachment lease");
        }
        let saved = thread(
            directory.path(),
            vec![ChatItem {
                id: "user-with-attachment".into(),
                turn_id: Some("turn-1".into()),
                kind: "user".into(),
                text: "Original prompt".into(),
                status: Some("completed".into()),
                attachments: vec![attachment.clone()],
            }],
        );
        store
            .persist_thread(&saved)
            .expect("persist owned attachment");
        assert!(
            store
                .recheck_attachments("project-1", &[attachment.clone()])
                .expect("initial recheck")[0]
                .available
        );

        fs::write(&attachment_path, b"tampered bytes!!").expect("replace with same-size bytes");
        assert_eq!(
            fs::metadata(&attachment_path)
                .expect("inspect replacement")
                .len(),
            attachment.size,
            "replacement keeps the original size"
        );
        assert!(
            !store
                .recheck_attachments("project-1", &[attachment])
                .expect("recheck changed bytes")[0]
                .available
        );

        drop(store);
        let reopened = ChatStore {
            connection: Mutex::new(Connection::open(&database_path).expect("reopen database")),
            attachments_dir: attachment_dir,
            database_path,
        };
        let restored = reopened
            .load_threads()
            .expect("load changed attachment after restart");
        assert!(!restored[0].items[0].attachments[0].available);
        assert_eq!(restored[0].items[0].text, "Original prompt");
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
                "DROP INDEX projects_folder_instance_unique; \
                 ALTER TABLE projects DROP COLUMN folder_instance_id; \
                 ALTER TABLE attachments DROP COLUMN project_id; \
                 DROP TABLE staged_attachment_leases; DROP TABLE draft_attachment_owners; DROP TABLE saved_drafts; \
                 ALTER TABLE projects DROP COLUMN pending_checkout_path; \
                 ALTER TABLE projects DROP COLUMN pending_checkout_identity; \
                 ALTER TABLE attachments DROP COLUMN content_sha256; \
                 PRAGMA user_version = 2;",
            )
            .expect("prepare a genuine v2 database shape");
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
                attachments: vec![attachment.clone()],
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
        let content_sha256 = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash staged draft attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin staged draft attachment transaction");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &saved_draft.draft.attachments[0],
                &content_sha256,
                "project-1",
            )
            .expect("register staged draft attachment");
            transaction.commit().expect("commit staged draft lease");
        }
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
        assert!(
            after_promotion_restart
                .recheck_attachments("project-1", &[attachment.clone()])
                .expect("recheck promoted attachment after restart")[0]
                .available
        );
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
                "SELECT COUNT(*) FROM attachment_owners WHERE thread_id = 'promoted-thread' AND owner_kind = 'draft' AND attachment_id = ?1",
                [&attachment.id],
                |row| row.get(0),
            )
            .expect("count transferred owners");
        assert_eq!(owner_count, 1);

        let late_capture = staged_attachment(&attachment_dir, "late-capture.png");
        let late_digest =
            attachments::digest_file(Path::new(&late_capture.path), late_capture.size)
                .expect("hash late capture");
        {
            let mut connection = after_promotion_restart
                .connection()
                .expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin late capture staging transaction");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &late_capture,
                &late_digest,
                "project-1",
            )
            .expect("stage late capture for project A");
            transaction
                .commit()
                .expect("commit late capture stage lease");
        }
        let mut late_draft_update = promoted;
        late_draft_update.draft.attachments = vec![attachment.clone(), late_capture.clone()];
        after_promotion_restart
            .persist_thread(&late_draft_update)
            .expect("persist late capture into the promoted thread draft");
        assert!(
            after_promotion_restart
                .recheck_attachments("project-1", &[late_capture.clone()])
                .expect("recheck late capture for its project")[0]
                .available
        );
        drop(after_promotion_restart);

        let after_late_capture_restart = ChatStore {
            connection: Mutex::new(
                Connection::open(&database_path).expect("reopen after late capture"),
            ),
            attachments_dir: attachment_dir.clone(),
            database_path,
        };
        let restored_thread = after_late_capture_restart
            .load_threads()
            .expect("restore promoted thread and late capture");
        let restored_attachments = &restored_thread[0].draft.attachments;
        assert_eq!(restored_attachments.len(), 2);
        assert!(restored_attachments
            .iter()
            .all(|attachment| attachment.available));
        assert!(
            after_late_capture_restart
                .recheck_attachments("project-1", &[late_capture])
                .expect("recheck late capture after restart")[0]
                .available
        );
    }

    #[test]
    fn discarding_thread_erases_promoted_draft_and_keeps_only_rejection_tombstone() {
        let directory = tempfile::tempdir().expect("temporary discard fixture");
        let attachment_dir = directory.path().join("attachments");
        fs::create_dir_all(&attachment_dir).expect("create attachment directory");
        let attachment_dir = fs::canonicalize(attachment_dir).expect("canonical attachment dir");
        let database_path = directory.path().join("threads.sqlite3");
        let connection = Connection::open(&database_path).expect("open test database");
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

        let attachment = staged_attachment(&attachment_dir, "private-capture.png");
        let attachment_path = PathBuf::from(&attachment.path);
        let digest = attachments::digest_file(&attachment_path, attachment.size)
            .expect("hash fixture attachment");
        {
            let mut connection = store.connection().expect("access test database");
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("begin stage registration");
            reserve_staged_attachment_in(
                &transaction,
                &attachment_dir,
                &attachment,
                &digest,
                "project-1",
            )
            .expect("record staged bytes and lease");
            transaction.commit().expect("commit staged ownership");
        }
        let draft_id = Uuid::new_v4().to_string();
        let saved_draft = SavedChatDraft {
            draft_id: draft_id.clone(),
            project_id: "project-1".into(),
            checkout_path: directory.path().to_string_lossy().into_owned(),
            checkout_identity: "checkout-1".into(),
            checkout_status: "available".into(),
            draft: ChatDraft {
                text: "Sensitive prompt text".into(),
                attachments: vec![attachment],
            },
            settings: ChatSettings {
                model_id: Some("private-model-choice".into()),
                reasoning_effort: Some("high".into()),
                auto_accept_mode: true,
            },
            saved_at: 1,
            state: "draft".into(),
            promoted_thread_id: None,
        };
        store
            .save_project_draft(&saved_draft)
            .expect("save sensitive draft");
        let mut promoted = thread(directory.path(), Vec::new());
        promoted.id = "local-thread-1".into();
        promoted.provider_thread_id = Some("provider-owned-thread-1".into());
        promoted.draft = saved_draft.draft.clone();
        promoted.settings = saved_draft.settings.clone();
        store
            .promote_saved_draft(&promoted, &draft_id)
            .expect("promote draft to local thread");

        store
            .delete_thread("local-thread-1")
            .expect("discard local history");

        let connection = store.connection().expect("inspect discarded storage");
        let tombstone: (String, String, String, String, String, Option<String>) = connection
            .query_row(
                "SELECT state, checkout_path, checkout_identity, draft_json, settings_json, promoted_thread_id \
                 FROM saved_drafts WHERE draft_id = ?1",
                [&draft_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .expect("retain a minimal discard tombstone");
        assert_eq!(tombstone.0, "discarded");
        assert!(tombstone.1.is_empty() && tombstone.2.is_empty());
        assert_eq!(tombstone.3, "{}");
        assert_eq!(tombstone.4, "{}");
        assert_eq!(tombstone.5, None);
        let saved_owner_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM draft_attachment_owners WHERE draft_id = ?1",
                [&draft_id],
                |row| row.get(0),
            )
            .expect("count promoted draft attachment owners");
        let thread_owner_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM attachment_owners WHERE thread_id = 'local-thread-1'",
                [],
                |row| row.get(0),
            )
            .expect("count thread attachment owners");
        let attachment_row_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE id = ?1",
                [&saved_draft.draft.attachments[0].id],
                |row| row.get(0),
            )
            .expect("count cleaned attachment record");
        assert_eq!(saved_owner_count, 0);
        assert_eq!(thread_owner_count, 0);
        assert_eq!(attachment_row_count, 0);
        assert!(
            !attachment_path.exists(),
            "discard removes owned staged bytes"
        );
        drop(connection);

        assert!(store
            .get_saved_draft("project-1", &draft_id)
            .expect("read draft")
            .is_none());
        assert!(store
            .save_project_draft(&saved_draft)
            .expect_err("stale save cannot recreate discarded content")
            .to_string()
            .contains("discarded"));
        let mut stale_promotion = promoted;
        stale_promotion.id = "stale-promoted-thread".into();
        assert!(store
            .promote_saved_draft(&stale_promotion, &draft_id)
            .expect_err("stale promotion cannot recreate discarded content")
            .to_string()
            .contains("discarded"));
        let local_thread_count: i64 = store
            .connection()
            .expect("access storage after stale requests")
            .query_row("SELECT COUNT(*) FROM threads", [], |row| row.get(0))
            .expect("count local threads");
        assert_eq!(local_thread_count, 0);
    }
}
