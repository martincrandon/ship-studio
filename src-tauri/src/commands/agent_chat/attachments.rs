use super::types::{ChatAttachment, MAX_ATTACHMENT_BYTES};
use crate::errors::CommandError;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub(super) fn stage(app: &AppHandle, source_path: &str) -> Result<ChatAttachment, CommandError> {
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
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| CommandError::Io {
            message: format!("Could not stage the selected attachment: {error}"),
        })?;
    if let Err(error) = restrict_file(&target) {
        let _ = fs::remove_file(&target);
        return Err(error);
    }

    let copied = io::copy(
        &mut Read::by_ref(&mut source).take(MAX_ATTACHMENT_BYTES + 1),
        &mut destination,
    )
    .map_err(|error| {
        let _ = fs::remove_file(&target);
        CommandError::Io {
            message: format!("Could not stage the selected attachment: {error}"),
        }
    })?;
    destination.flush().map_err(|error| CommandError::Io {
        message: format!("Could not finish staging the selected attachment: {error}"),
    })?;
    if copied > MAX_ATTACHMENT_BYTES {
        let _ = fs::remove_file(&target);
        return Err(CommandError::Validation {
            field: "path".into(),
            reason: format!(
                "Attachments must be no larger than {} MB",
                MAX_ATTACHMENT_BYTES / 1024 / 1024
            ),
        });
    }

    Ok(ChatAttachment {
        id,
        name,
        path: target.to_string_lossy().into_owned(),
        mime_type,
        size: copied,
        kind,
        available: true,
    })
}

pub(super) fn validate_staged(
    app: &AppHandle,
    attachments: &[ChatAttachment],
) -> Result<(), CommandError> {
    let directory = staged_dir(app)?;
    fs::create_dir_all(&directory).map_err(|error| CommandError::Io {
        message: format!("Could not access local chat attachments: {error}"),
    })?;
    let directory = dunce::canonicalize(directory).map_err(|error| CommandError::Io {
        message: format!("Could not access local chat attachments: {error}"),
    })?;
    for attachment in attachments {
        validate_staged_in_directory(&directory, attachment)?;
    }
    Ok(())
}

pub(super) fn staged_file_is_valid(directory: &Path, attachment: &ChatAttachment) -> bool {
    let mut candidate = attachment.clone();
    candidate.available = true;
    validate_staged_in_directory(directory, &candidate).is_ok()
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
