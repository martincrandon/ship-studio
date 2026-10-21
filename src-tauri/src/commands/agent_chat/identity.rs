//! Stable instance identity for plain-folder Agent Chat projects.

use crate::errors::CommandError;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MARKER_DIRECTORY: &str = ".shipstudio";
const MARKER_FILE: &str = "agent-chat-project-id";

/// Return a stable identity for this physical folder. Unix uses the native
/// device/inode pair. Other platforms use an app-owned UUID marker when the
/// project folder permits it; an unavailable identity is never replaced with
/// a path-based guess. Filesystems may eventually reuse an inode after a
/// folder is deleted, so the native identity cannot distinguish that rare
/// reuse from the original folder.
pub(super) fn folder_instance_identity(path: &Path) -> Result<Option<String>, CommandError> {
    let path = dunce::canonicalize(path).map_err(|error| {
        crate::utils::classify_fs_error("access the project folder identity", path, &error)
    })?;
    if let Some(identity) = native_folder_identity(&path) {
        return Ok(Some(identity));
    }
    read_or_create_marker_identity(&path)
}

/// A copied project can carry the fallback marker with it. If the original
/// folder still exists at its recorded path, assign the copy a new marker so
/// the two folders cannot share one Chat identity.
pub(super) fn refresh_copied_marker(path: &Path) -> Result<Option<String>, CommandError> {
    let path = dunce::canonicalize(path).map_err(|error| {
        crate::utils::classify_fs_error("access the project folder identity", path, &error)
    })?;
    if native_folder_identity(&path).is_some() {
        return Ok(None);
    }
    refresh_marker_identity(&path)
}

fn refresh_marker_identity(path: &Path) -> Result<Option<String>, CommandError> {
    let Some(marker) = marker_path(path)? else {
        return Ok(None);
    };
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if metadata.len() > 64 {
        return Ok(None);
    }
    let identity = format!("marker:{}", Uuid::new_v4());
    fs::write(
        &marker,
        format!("{}\n", identity.trim_start_matches("marker:")),
    )
    .map_err(|error| CommandError::Io {
        message: format!("Could not assign a new identity to the copied project folder: {error}"),
    })?;
    Ok(Some(identity))
}

#[cfg(unix)]
fn native_folder_identity(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).ok()?;
    metadata
        .is_dir()
        .then(|| format!("unix:{:x}:{:x}", metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn native_folder_identity(_path: &Path) -> Option<String> {
    None
}

fn read_or_create_marker_identity(path: &Path) -> Result<Option<String>, CommandError> {
    let Some(marker) = marker_path(path)? else {
        return Ok(None);
    };
    match fs::symlink_metadata(&marker) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 {
                return Ok(None);
            }
            let value = fs::read_to_string(&marker).map_err(|_| CommandError::expected(
                "This folder's Agent Chat identity marker could not be read. Relink the saved project explicitly.",
            ))?;
            Ok(parse_marker_identity(&value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let id = Uuid::new_v4().to_string();
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return read_or_create_marker_identity(path)
                }
                Err(_) => return Ok(None),
            };
            if file.write_all(id.as_bytes()).is_err() || file.sync_all().is_err() {
                let _ = fs::remove_file(&marker);
                return Ok(None);
            }
            Ok(Some(format!("marker:{id}")))
        }
        Err(_) => Ok(None),
    }
}

fn marker_path(path: &Path) -> Result<Option<PathBuf>, CommandError> {
    if !path.is_dir() {
        return Ok(None);
    }
    let directory = path.join(MARKER_DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if fs::create_dir(&directory).is_err() {
                return Ok(None);
            }
        }
        Err(_) => return Ok(None),
    }
    let canonical = match dunce::canonicalize(&directory) {
        Ok(canonical) if canonical.parent() == Some(path) => canonical,
        _ => return Ok(None),
    };
    Ok(Some(canonical.join(MARKER_FILE)))
}

fn parse_marker_identity(value: &str) -> Option<String> {
    let id = Uuid::parse_str(value.trim()).ok()?;
    (id.to_string() == value.trim()).then(|| format!("marker:{id}"))
}

#[cfg(test)]
mod tests {
    use super::{
        folder_instance_identity, read_or_create_marker_identity, refresh_marker_identity,
        MARKER_DIRECTORY, MARKER_FILE,
    };
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn native_identity_survives_a_move_and_changes_when_the_path_is_replaced() {
        let root = tempfile::tempdir().expect("temporary folder identity fixture");
        let original = root.path().join("project");
        fs::create_dir(&original).expect("create project folder");
        let identity = folder_instance_identity(&original)
            .expect("read folder identity")
            .expect("native folder identity");
        let moved = root.path().join("moved");
        fs::rename(&original, &moved).expect("move folder");
        assert_eq!(
            folder_instance_identity(&moved).expect("identity after move"),
            Some(identity.clone())
        );

        fs::rename(&moved, &original).expect("restore original path");
        fs::remove_dir_all(&original).expect("remove original folder");
        fs::create_dir(&original).expect("replace folder at original path");
        let replacement = folder_instance_identity(&original)
            .expect("identity of replacement")
            .expect("native replacement identity");
        assert_ne!(replacement, identity);
    }

    #[test]
    fn fallback_marker_identity_survives_a_move() {
        let root = tempfile::tempdir().expect("temporary marker fixture");
        let original_path = root.path().join("project");
        fs::create_dir(&original_path).expect("create project folder");
        let original = dunce::canonicalize(original_path).expect("canonical project folder");
        let identity = read_or_create_marker_identity(&original)
            .expect("create identity marker")
            .expect("marker identity");
        let moved_path = root.path().join("moved");
        fs::rename(&original, &moved_path).expect("move project folder");
        let moved = dunce::canonicalize(moved_path).expect("canonical moved folder");
        assert_eq!(
            read_or_create_marker_identity(&moved).expect("read marker after move"),
            Some(identity)
        );
    }

    #[test]
    fn copied_marker_gets_a_new_identity_without_changing_the_original() {
        let root = tempfile::tempdir().expect("temporary copied marker fixture");
        let original_path = root.path().join("original");
        let copied_path = root.path().join("copied");
        fs::create_dir(&original_path).expect("create original folder");
        fs::create_dir(&copied_path).expect("create copied folder");
        let original = dunce::canonicalize(original_path).expect("canonical original folder");
        let copied = dunce::canonicalize(copied_path).expect("canonical copied folder");
        let original_identity = read_or_create_marker_identity(&original)
            .expect("create original marker")
            .expect("original marker identity");
        let original_marker = original.join(MARKER_DIRECTORY).join(MARKER_FILE);
        let copied_marker_directory = copied.join(MARKER_DIRECTORY);
        fs::create_dir(&copied_marker_directory).expect("create copied marker directory");
        fs::copy(&original_marker, copied_marker_directory.join(MARKER_FILE))
            .expect("copy marker with project contents");

        let copied_identity = refresh_marker_identity(&copied)
            .expect("refresh copied marker")
            .expect("new copied marker identity");

        assert_ne!(copied_identity, original_identity);
        assert_eq!(
            read_or_create_marker_identity(&original).expect("original marker remains stable"),
            Some(original_identity)
        );
        assert_eq!(
            read_or_create_marker_identity(&copied).expect("read refreshed copy marker"),
            Some(copied_identity)
        );
    }
}
