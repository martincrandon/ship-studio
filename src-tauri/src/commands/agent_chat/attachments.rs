use super::types::{ChatAttachment, MAX_ATTACHMENT_BYTES};
use crate::errors::CommandError;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub(super) enum AttachmentOwnerScope<'a> {
    Project,
    Thread {
        thread_id: &'a str,
        source_draft_id: Option<&'a str>,
    },
    SavedDraft(&'a str),
}

pub(super) fn stage(
    app: &AppHandle,
    source_path: &str,
) -> Result<(ChatAttachment, String), CommandError> {
    let source_path = dunce::canonicalize(source_path).map_err(|error| CommandError::Io {
        message: format!("Could not open the selected attachment: {error}"),
    })?;
    let path_metadata = fs::metadata(&source_path).map_err(|error| CommandError::Io {
        message: format!("Could not inspect the selected attachment: {error}"),
    })?;
    if !path_metadata.is_file() {
        return Err(CommandError::Validation {
            field: "path".into(),
            reason: "Attachments must be regular files".into(),
        });
    }
    if path_metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(CommandError::Validation {
            field: "path".into(),
            reason: format!(
                "Attachments must be no larger than {} MB",
                MAX_ATTACHMENT_BYTES / 1024 / 1024
            ),
        });
    }
    let mut source = File::open(&source_path).map_err(|error| CommandError::Io {
        message: format!("Could not open the selected attachment: {error}"),
    })?;
    let handle_metadata = source.metadata().map_err(|error| CommandError::Io {
        message: format!("Could not inspect the selected attachment: {error}"),
    })?;
    if !handle_metadata.is_file() || handle_metadata.len() != path_metadata.len() {
        return Err(CommandError::Validation {
            field: "path".into(),
            reason: "The selected attachment changed before it could be staged".into(),
        });
    }

    let original_name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "attachment".into());
    let name = safe_display_name(&original_name);
    let extension = safe_extension(&source_path);
    let (mime_type, kind) = mime_and_kind(extension.as_deref());
    let id = Uuid::new_v4().to_string();
    let directory = staged_dir(app)?;
    fs::create_dir_all(&directory).map_err(|error| CommandError::Io {
        message: format!("Could not prepare local chat attachments: {error}"),
    })?;
    restrict_directory(&directory)?;
    let directory = dunce::canonicalize(&directory).map_err(|error| CommandError::Io {
        message: format!("Could not access local chat attachments: {error}"),
    })?;
    // Staged previews are rendered with `convertFileSrc` in the webview. App
    // data is outside the static asset-protocol scope, so grant only this
    // dedicated attachment directory after canonicalizing it.
    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|error| CommandError::Io {
            message: format!("Could not enable previews for local chat attachments: {error}"),
        })?;
    let file_name = match extension {
        Some(extension) => format!("{id}.{extension}"),
        None => id.clone(),
    };
    let target = directory.join(file_name);
    let destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| CommandError::Io {
            message: format!("Could not stage the selected attachment: {error}"),
        })?;
    let (copied, content_sha256) = finish_staging(&target, &mut source, destination)?;

    Ok((
        ChatAttachment {
            id,
            name,
            path: target.to_string_lossy().into_owned(),
            mime_type,
            size: copied,
            kind,
            available: true,
        },
        content_sha256,
    ))
}

pub(super) fn validate_staged(
    app: &AppHandle,
    project_id: &str,
    owner_scope: AttachmentOwnerScope<'_>,
    attachments: &[ChatAttachment],
) -> Result<(), CommandError> {
    if attachments.is_empty() {
        return Ok(());
    }
    let directory = staged_dir(app)?;
    fs::create_dir_all(&directory).map_err(|error| CommandError::Io {
        message: format!("Could not access local chat attachments: {error}"),
    })?;
    let directory = dunce::canonicalize(directory).map_err(|error| CommandError::Io {
        message: format!("Could not access local chat attachments: {error}"),
    })?;
    let database_path = app
        .path()
        .app_data_dir()
        .map(|path| path.join("agent-chat").join("threads.sqlite3"))
        .map_err(|error| CommandError::Io {
            message: format!("Could not locate local chat storage: {error}"),
        })?;
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| CommandError::Io {
        message: format!("Could not verify staged chat attachments: {error}"),
    })?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| CommandError::Io {
            message: format!("Could not verify staged chat attachments: {error}"),
        })?;
    let now = chrono::Utc::now().timestamp_millis();
    for attachment in attachments {
        validate_staged_in_directory(&directory, attachment)?;
        if !attachment_scope_is_valid(&connection, &attachment.id, project_id, owner_scope, now)
            .map_err(|error| CommandError::Io {
                message: format!("Could not verify staged chat attachments: {error}"),
            })?
        {
            return Err(invalid_attachment());
        }
        let stored = connection
            .query_row(
                "SELECT metadata_json, content_sha256 FROM attachments \
                 WHERE id = ?1 AND path = ?2 AND project_id = ?3",
                params![attachment.id, attachment.path, project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|error| CommandError::Io {
                message: format!("Could not verify staged chat attachments: {error}"),
            })?
            .ok_or_else(invalid_attachment)?;
        let metadata_matches = serde_json::from_str::<ChatAttachment>(&stored.0)
            .map(|saved| same_attachment_identity(&saved, attachment))
            .unwrap_or(false);
        if !metadata_matches || !staged_file_is_valid(&directory, attachment, stored.1.as_deref()) {
            return Err(invalid_attachment());
        }
    }
    Ok(())
}

pub(super) fn attachment_scope_is_valid(
    connection: &Connection,
    attachment_id: &str,
    project_id: &str,
    owner_scope: AttachmentOwnerScope<'_>,
    now: i64,
) -> rusqlite::Result<bool> {
    let (scope_kind, target_id, source_draft_id) = match owner_scope {
        AttachmentOwnerScope::Project => ("project", None, None),
        AttachmentOwnerScope::Thread {
            thread_id,
            source_draft_id,
        } => ("thread", Some(thread_id), source_draft_id),
        AttachmentOwnerScope::SavedDraft(draft_id) => ("draft", Some(draft_id), None),
    };
    connection.query_row(
        "SELECT EXISTS(\
           SELECT 1 FROM attachments a \
           WHERE a.id = ?1 AND a.project_id = ?2 AND ( \
             EXISTS (SELECT 1 FROM staged_attachment_leases l \
                     WHERE l.attachment_id = a.id AND l.expires_at > ?3) \
             OR (?4 = 'project' AND ( \
               EXISTS (SELECT 1 FROM attachment_owners o JOIN threads t ON t.id = o.thread_id \
                       WHERE o.attachment_id = a.id AND t.project_id = ?2) \
               OR EXISTS (SELECT 1 FROM draft_attachment_owners d JOIN saved_drafts s ON s.draft_id = d.draft_id \
                          WHERE d.attachment_id = a.id AND s.project_id = ?2))) \
             OR (?4 = 'thread' AND ( \
               EXISTS (SELECT 1 FROM attachment_owners o JOIN threads t ON t.id = o.thread_id \
                       WHERE o.attachment_id = a.id AND o.thread_id = ?5 AND t.project_id = ?2) \
               OR EXISTS (SELECT 1 FROM draft_attachment_owners d JOIN saved_drafts s ON s.draft_id = d.draft_id \
                          WHERE d.attachment_id = a.id AND s.project_id = ?2 AND s.promoted_thread_id = ?5) \
               OR (?6 IS NOT NULL AND EXISTS (SELECT 1 FROM draft_attachment_owners d JOIN saved_drafts s ON s.draft_id = d.draft_id \
                          WHERE d.attachment_id = a.id AND d.draft_id = ?6 AND s.project_id = ?2)))) \
             OR (?4 = 'draft' AND EXISTS ( \
               SELECT 1 FROM draft_attachment_owners d JOIN saved_drafts s ON s.draft_id = d.draft_id \
               WHERE d.attachment_id = a.id AND d.draft_id = ?5 AND s.project_id = ?2)) \
           ) \
         )",
        params![attachment_id, project_id, now, scope_kind, target_id, source_draft_id],
        |row| row.get(0),
    )
}

pub(super) fn staged_file_is_valid(
    directory: &Path,
    attachment: &ChatAttachment,
    expected_sha256: Option<&str>,
) -> bool {
    let mut candidate = attachment.clone();
    candidate.available = true;
    if validate_staged_in_directory(directory, &candidate).is_err() {
        return false;
    }
    expected_sha256.map_or(true, |expected| {
        digest_file(Path::new(&candidate.path), candidate.size)
            .is_some_and(|actual| actual == expected)
    })
}

fn finish_staging(
    target: &Path,
    source: &mut impl Read,
    mut destination: impl Write,
) -> Result<(u64, String), CommandError> {
    let staged = (|| {
        restrict_file(target)?;
        let (copied, content_sha256) =
            copy_and_hash(source, &mut destination).map_err(|error| CommandError::Io {
                message: format!("Could not stage the selected attachment: {error}"),
            })?;
        if copied > MAX_ATTACHMENT_BYTES {
            return Err(CommandError::Validation {
                field: "path".into(),
                reason: format!(
                    "Attachments must be no larger than {} MB",
                    MAX_ATTACHMENT_BYTES / 1024 / 1024
                ),
            });
        }
        destination.flush().map_err(|error| CommandError::Io {
            message: format!("Could not finish staging the selected attachment: {error}"),
        })?;
        Ok((copied, content_sha256))
    })();
    match staged {
        Ok(staged) => Ok(staged),
        Err(error) => {
            drop(destination);
            let _ = fs::remove_file(target);
            Err(error)
        }
    }
}

pub(super) fn digest_file(path: &Path, expected_size: u64) -> Option<String> {
    if expected_size > MAX_ATTACHMENT_BYTES {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return None;
    }
    let (read, digest) = copy_and_hash(&mut file, &mut io::sink()).ok()?;
    if read != expected_size || file.metadata().ok()?.len() != expected_size {
        return None;
    }
    Some(digest)
}

fn copy_and_hash(
    source: &mut impl Read,
    destination: &mut impl Write,
) -> io::Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    while total <= MAX_ATTACHMENT_BYTES {
        let remaining = MAX_ATTACHMENT_BYTES + 1 - total;
        let read_limit = buffer.len().min(remaining as usize);
        let read = source.read(&mut buffer[..read_limit])?;
        if read == 0 {
            break;
        }
        destination.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn validate_staged_in_directory(
    directory: &Path,
    attachment: &ChatAttachment,
) -> Result<(), CommandError> {
    if !attachment.available {
        return Err(invalid_attachment());
    }
    let id = Uuid::parse_str(&attachment.id).map_err(|_| invalid_attachment())?;
    if id.to_string() != attachment.id {
        return Err(invalid_attachment());
    }
    if attachment.name.is_empty()
        || attachment.name.chars().count() > 255
        || attachment.name.chars().any(char::is_control)
    {
        return Err(invalid_attachment());
    }
    if attachment.size > MAX_ATTACHMENT_BYTES {
        return Err(invalid_attachment());
    }
    let path = dunce::canonicalize(&attachment.path).map_err(|_| invalid_attachment())?;
    if path.parent() != Some(directory) {
        return Err(invalid_attachment());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(invalid_attachment)?;
    let extension = file_name
        .strip_prefix(&attachment.id)
        .and_then(|tail| tail.strip_prefix('.'));
    if file_name != attachment.id && extension.is_none() {
        return Err(invalid_attachment());
    }
    if extension
        .is_some_and(|value| value.is_empty() || !value.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err(invalid_attachment());
    }
    let metadata = fs::metadata(&path).map_err(|_| invalid_attachment())?;
    if !metadata.is_file() || metadata.len() != attachment.size {
        return Err(invalid_attachment());
    }
    let (mime_type, kind) = mime_and_kind(extension);
    if mime_type != attachment.mime_type || kind != attachment.kind {
        return Err(invalid_attachment());
    }
    Ok(())
}

fn staged_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("agent-chat").join("attachments"))
        .map_err(|error| CommandError::Io {
            message: format!("Could not locate local chat attachment storage: {error}"),
        })
}

fn safe_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| {
            (1..=12).contains(&extension.len())
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map(str::to_ascii_lowercase)
}

fn mime_and_kind(extension: Option<&str>) -> (String, String) {
    let mime = match extension.unwrap_or_default() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "rs" => "text/x-rust",
        "ts" | "tsx" => "text/typescript",
        "js" | "jsx" => "text/javascript",
        "css" => "text/css",
        _ => "application/octet-stream",
    };
    let kind = if mime.starts_with("image/") {
        "image"
    } else {
        "file"
    };
    (mime.into(), kind.into())
}

fn safe_display_name(name: &str) -> String {
    let name = name
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect::<String>();
    if name.is_empty() {
        "attachment".into()
    } else {
        name
    }
}

fn invalid_attachment() -> CommandError {
    CommandError::Validation {
        field: "attachments".into(),
        reason: "An attachment is missing, changed, or was not staged by Ship Studio".into(),
    }
}

fn same_attachment_identity(saved: &ChatAttachment, candidate: &ChatAttachment) -> bool {
    saved.id == candidate.id
        && saved.name == candidate.name
        && saved.path == candidate.path
        && saved.mime_type == candidate.mime_type
        && saved.size == candidate.size
        && saved.kind == candidate.kind
}

fn restrict_directory(path: &Path) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            CommandError::Io {
                message: format!("Could not secure local chat attachment storage: {error}"),
            }
        })?;
    }
    Ok(())
}

fn restrict_file(path: &Path) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            CommandError::Io {
                message: format!("Could not secure the staged attachment: {error}"),
            }
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_staging_removes_partial_destination() {
        let directory = tempfile::tempdir().expect("temporary attachment directory");
        let target = directory.path().join("partial.png");
        let destination = File::create(&target).expect("create staged file");
        let mut source = io::Cursor::new(b"partially copied".to_vec());
        let writer = FlushFailWriter { destination };

        let result = finish_staging(&target, &mut source, writer);

        assert!(result.is_err());
        assert!(
            !target.exists(),
            "a failed stage must not leave its partial file in app storage"
        );
    }

    struct FlushFailWriter {
        destination: File,
    }

    impl Write for FlushFailWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.destination.write(buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Other,
                "simulated flush failure",
            ))
        }
    }
}
