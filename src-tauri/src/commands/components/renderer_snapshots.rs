//! Project-scoped persistence for component renderer snapshots.
//!
//! Snapshot pixels are produced by the existing renderer capture command. This
//! module only persists the explicit metadata that points at those pixels. The
//! path guard is intentionally strict: a snapshot must already exist, must be
//! an image file, and must live below this project's `.shipstudio/screenshots`
//! directory. The manifest is replaced atomically and never participates in
//! broad directory cleanup.

use crate::errors::CommandError;
use crate::utils::{atomic_replace, validate_project_path};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const RENDERER_SNAPSHOT_MANIFEST_VERSION: u8 = 1;
pub const RENDERER_SNAPSHOT_MAX_ENTRIES: usize = 200;
pub const RENDERER_SNAPSHOT_MAX_NODE_ID_LENGTH: usize = 256;
pub const RENDERER_SNAPSHOT_MAX_KEY_LENGTH: usize = 1024;
pub const RENDERER_SNAPSHOT_MAX_PATH_LENGTH: usize = 4096;
pub const RENDERER_SNAPSHOT_MAX_MANIFEST_BYTES: usize = 512 * 1024;

const SNAPSHOT_MANIFEST_RELATIVE_PATH: &str = ".shipstudio/component-renderer/snapshots.json";
const SNAPSHOT_DIRECTORY_RELATIVE_PATH: &str = ".shipstudio/screenshots";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RendererSnapshotRecord {
    pub node_id: String,
    pub snapshot_key: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRendererSnapshotRequest {
    pub node_id: String,
    pub snapshot_key: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererSnapshotManifest {
    schema_version: u8,
    snapshots: Vec<RendererSnapshotRecord>,
}

impl Default for RendererSnapshotManifest {
    fn default() -> Self {
        Self {
            schema_version: RENDERER_SNAPSHOT_MANIFEST_VERSION,
            snapshots: Vec::new(),
        }
    }
}

/// Read only explicitly persisted snapshots whose image files are still
/// present and still resolve inside this project's managed screenshots folder.
pub async fn read_snapshots_impl(
    project_path: String,
) -> Result<Vec<RendererSnapshotRecord>, CommandError> {
    let project = validate_project_path(&project_path)?;
    read_snapshots_for_project(&project)
}

/// Persist one explicit renderer snapshot and safely replace the previous
/// record for its node. The old image is removed only after the manifest has
/// been atomically replaced, and only when it is no longer referenced by a
/// remaining record and is inside the managed screenshots directory.
pub async fn upsert_snapshot_impl(
    project_path: String,
    request: UpsertRendererSnapshotRequest,
) -> Result<RendererSnapshotRecord, CommandError> {
    let project = validate_project_path(&project_path)?;
    upsert_snapshot_for_project(&project, request)
}

fn read_snapshots_for_project(project: &Path) -> Result<Vec<RendererSnapshotRecord>, CommandError> {
    let Some(manifest) = read_manifest(project)? else {
        return Ok(Vec::new());
    };

    let mut snapshots = Vec::with_capacity(manifest.snapshots.len());
    for record in manifest.snapshots {
        let Ok(path) = validate_snapshot_path(project, &record.path) else {
            continue;
        };
        if !valid_node_id(&record.node_id) || !valid_snapshot_key(&record.snapshot_key) {
            continue;
        }
        snapshots.push(RendererSnapshotRecord {
            node_id: record.node_id,
            snapshot_key: record.snapshot_key,
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(snapshots)
}

fn upsert_snapshot_for_project(
    project: &Path,
    request: UpsertRendererSnapshotRequest,
) -> Result<RendererSnapshotRecord, CommandError> {
    validate_node_id(&request.node_id)?;
    validate_snapshot_key(&request.snapshot_key)?;
    let path = validate_snapshot_path(project, &request.path)?;
    let record = RendererSnapshotRecord {
        node_id: request.node_id,
        snapshot_key: request.snapshot_key,
        path: path.to_string_lossy().into_owned(),
    };

    let current = read_manifest(project)?.unwrap_or_default();
    let mut snapshots = Vec::with_capacity(current.snapshots.len().saturating_add(1));
    let mut previous_path = None;
    for existing in current.snapshots {
        if existing.node_id == record.node_id {
            previous_path = Some(existing.path);
            continue;
        }
        // A tampered/stale record is not allowed to be copied back into the
        // manifest. Missing files are deliberately dropped so reopening a
        // project never advertises a snapshot that cannot be loaded.
        if !valid_node_id(&existing.node_id) || !valid_snapshot_key(&existing.snapshot_key) {
            continue;
        }
        let Ok(existing_path) = validate_snapshot_path(project, &existing.path) else {
            continue;
        };
        snapshots.push(RendererSnapshotRecord {
            node_id: existing.node_id,
            snapshot_key: existing.snapshot_key,
            path: existing_path.to_string_lossy().into_owned(),
        });
    }
    if snapshots.len() >= RENDERER_SNAPSHOT_MAX_ENTRIES {
        return Err(CommandError::Validation {
            field: "snapshot".to_string(),
            reason: "the component renderer snapshot manifest is full".to_string(),
        });
    }
    snapshots.push(record.clone());
    let manifest = RendererSnapshotManifest {
        schema_version: RENDERER_SNAPSHOT_MANIFEST_VERSION,
        snapshots,
    };
    write_manifest(project, &manifest)?;

    if let Some(previous_path) = previous_path {
        remove_replaced_snapshot_if_unreferenced(project, &previous_path, &manifest.snapshots);
    }
    Ok(record)
}

fn read_manifest(project: &Path) -> Result<Option<RendererSnapshotManifest>, CommandError> {
    let path = project.join(SNAPSHOT_MANIFEST_RELATIVE_PATH);
    if !path.exists() {
        return Ok(None);
    }
    ensure_managed_manifest_parent(project)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        crate::utils::classify_fs_error("inspect renderer snapshot manifest", &path, &error)
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(CommandError::expected(
            "Renderer snapshot manifest refused a symlink or non-file path.",
        ));
    }
    let contents = fs::read(&path).map_err(|error| {
        crate::utils::classify_fs_error("read renderer snapshot manifest", &path, &error)
    })?;
    if contents.len() > RENDERER_SNAPSHOT_MAX_MANIFEST_BYTES {
        return Err(CommandError::Validation {
            field: "snapshot_manifest".to_string(),
            reason: "the renderer snapshot manifest exceeds the bounded size".to_string(),
        });
    }
    let manifest: RendererSnapshotManifest = serde_json::from_slice(&contents)
        .map_err(|error| format!("Failed to parse renderer snapshot manifest: {error}"))?;
    if manifest.schema_version != RENDERER_SNAPSHOT_MANIFEST_VERSION
        || manifest.snapshots.len() > RENDERER_SNAPSHOT_MAX_ENTRIES
    {
        return Err(CommandError::Validation {
            field: "snapshot_manifest".to_string(),
            reason: "the renderer snapshot manifest is unsupported or oversized".to_string(),
        });
    }
    Ok(Some(manifest))
}

fn write_manifest(project: &Path, manifest: &RendererSnapshotManifest) -> Result<(), CommandError> {
    if manifest.schema_version != RENDERER_SNAPSHOT_MANIFEST_VERSION
        || manifest.snapshots.len() > RENDERER_SNAPSHOT_MAX_ENTRIES
    {
        return Err(CommandError::Validation {
            field: "snapshot_manifest".to_string(),
            reason: "the renderer snapshot manifest is unsupported or oversized".to_string(),
        });
    }
    ensure_managed_manifest_parent(project)?;
    let path = project.join(SNAPSHOT_MANIFEST_RELATIVE_PATH);
    if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            crate::utils::classify_fs_error("inspect renderer snapshot manifest", &path, &error)
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(CommandError::expected(
                "Renderer snapshot manifest refused a symlink or non-file path.",
            ));
        }
    }
    let contents = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Failed to serialize renderer snapshot manifest: {error}"))?;
    if contents.len() > RENDERER_SNAPSHOT_MAX_MANIFEST_BYTES {
        return Err(CommandError::Validation {
            field: "snapshot_manifest".to_string(),
            reason: "the renderer snapshot manifest exceeds the bounded size".to_string(),
        });
    }
    let parent = path.parent().ok_or_else(|| {
        CommandError::expected("Renderer snapshot manifest has no parent directory.")
    })?;
    let temporary = parent.join(format!("snapshots.json.{}.tmp", Uuid::new_v4()));
    if let Err(error) = fs::write(&temporary, contents) {
        let _ = fs::remove_file(&temporary);
        return Err(crate::utils::classify_fs_error(
            "write renderer snapshot manifest",
            &temporary,
            &error,
        ));
    }
    if let Err(error) = atomic_replace(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(crate::utils::classify_fs_error(
            "commit renderer snapshot manifest",
            &path,
            &error,
        ));
    }
    Ok(())
}

fn remove_replaced_snapshot_if_unreferenced(
    project: &Path,
    previous_path: &str,
    snapshots: &[RendererSnapshotRecord],
) {
    let Ok(previous) = validate_snapshot_path(project, previous_path) else {
        return;
    };
    if snapshots
        .iter()
        .any(|snapshot| snapshot.path == previous.to_string_lossy())
    {
        return;
    }
    if let Err(error) = fs::remove_file(&previous) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %previous.display(), %error, "Could not remove replaced renderer snapshot");
        }
    }
}

fn ensure_managed_manifest_parent(project: &Path) -> Result<PathBuf, CommandError> {
    let shipstudio = project.join(".shipstudio");
    ensure_directory_without_symlink(&shipstudio, project)?;
    let parent = shipstudio.join("component-renderer");
    ensure_directory_without_symlink(&parent, project)?;
    Ok(parent)
}

fn ensure_directory_without_symlink(path: &Path, project: &Path) -> Result<(), CommandError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            crate::utils::classify_fs_error("inspect renderer snapshot directory", path, &error)
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(CommandError::expected(
                "Renderer snapshot storage refused a symlink or non-directory path.",
            ));
        }
    } else {
        fs::create_dir_all(path).map_err(|error| {
            crate::utils::classify_fs_error("create renderer snapshot directory", path, &error)
        })?;
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        crate::utils::classify_fs_error("validate renderer snapshot directory", path, &error)
    })?;
    if !canonical.starts_with(project) {
        return Err(CommandError::expected(
            "Renderer snapshot storage resolved outside the project.",
        ));
    }
    Ok(())
}

fn validate_snapshot_path(project: &Path, raw_path: &str) -> Result<PathBuf, CommandError> {
    if raw_path.is_empty()
        || raw_path.len() > RENDERER_SNAPSHOT_MAX_PATH_LENGTH
        || raw_path.contains('\0')
    {
        return Err(CommandError::Validation {
            field: "snapshot.path".to_string(),
            reason: "snapshot path is empty or oversized".to_string(),
        });
    }
    let supplied = PathBuf::from(raw_path);
    let candidate = if supplied.is_absolute() {
        supplied
    } else {
        project.join(supplied)
    };
    let screenshots = project.join(SNAPSHOT_DIRECTORY_RELATIVE_PATH);
    let root_metadata =
        fs::symlink_metadata(&screenshots).map_err(|_| CommandError::Validation {
            field: "snapshot.path".to_string(),
            reason: "snapshot directory does not exist".to_string(),
        })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(CommandError::Validation {
            field: "snapshot.path".to_string(),
            reason: "snapshot directory is not a managed directory".to_string(),
        });
    }
    let canonical_root = fs::canonicalize(&screenshots).map_err(|_| CommandError::Validation {
        field: "snapshot.path".to_string(),
        reason: "snapshot directory does not exist".to_string(),
    })?;
    if !canonical_root.starts_with(project) {
        return Err(CommandError::Validation {
            field: "snapshot.path".to_string(),
            reason: "snapshot directory resolves outside the project".to_string(),
        });
    }
    let canonical = fs::canonicalize(&candidate).map_err(|_| CommandError::Validation {
        field: "snapshot.path".to_string(),
        reason: "snapshot file does not exist".to_string(),
    })?;
    let metadata = fs::symlink_metadata(&candidate).map_err(|_| CommandError::Validation {
        field: "snapshot.path".to_string(),
        reason: "snapshot file cannot be inspected".to_string(),
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || canonical == canonical_root
        || !canonical.starts_with(&canonical_root)
        || !is_image_path(&canonical)
    {
        return Err(CommandError::Validation {
            field: "snapshot.path".to_string(),
            reason: "snapshot must be an existing image inside .shipstudio/screenshots".to_string(),
        });
    }
    Ok(canonical)
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif")
    )
}

fn validate_node_id(node_id: &str) -> Result<(), CommandError> {
    if valid_node_id(node_id) {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "snapshot.nodeId".to_string(),
            reason: "node id is empty, oversized, or contains path/control characters".to_string(),
        })
    }
}

fn valid_node_id(value: &str) -> bool {
    bounded_identifier(value, RENDERER_SNAPSHOT_MAX_NODE_ID_LENGTH)
}

fn validate_snapshot_key(key: &str) -> Result<(), CommandError> {
    if valid_snapshot_key(key) {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "snapshot.snapshotKey".to_string(),
            reason: "snapshot key is empty or oversized".to_string(),
        })
    }
}

fn valid_snapshot_key(value: &str) -> bool {
    bounded_identifier(value, RENDERER_SNAPSHOT_MAX_KEY_LENGTH)
}

fn bounded_identifier(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_length
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn project_with_image() -> (TempDir, PathBuf) {
        let project = tempfile::tempdir().expect("temp project");
        let screenshots = project.path().join(SNAPSHOT_DIRECTORY_RELATIVE_PATH);
        fs::create_dir_all(&screenshots).expect("screenshots dir");
        let image = screenshots.join("component.png");
        fs::write(&image, b"not-real-png-but-an-existing-image-path").expect("image");
        (project, image)
    }

    #[test]
    fn accepts_existing_images_only_inside_project_screenshots() {
        let (project, image) = project_with_image();
        assert!(validate_snapshot_path(project.path(), &image.to_string_lossy()).is_ok());
        assert!(validate_snapshot_path(project.path(), "missing.png").is_err());
        assert!(validate_snapshot_path(project.path(), &project.path().to_string_lossy()).is_err());
    }

    #[test]
    fn upsert_replaces_record_and_removes_previous_unreferenced_image() {
        let (project, first) = project_with_image();
        let screenshots = project.path().join(SNAPSHOT_DIRECTORY_RELATIVE_PATH);
        let second = screenshots.join("component-next.png");
        fs::write(&second, b"second").expect("second image");
        upsert_snapshot_for_project(
            project.path(),
            UpsertRendererSnapshotRequest {
                node_id: "node-a".to_string(),
                snapshot_key: "v1".to_string(),
                path: first.to_string_lossy().into_owned(),
            },
        )
        .expect("first upsert");
        upsert_snapshot_for_project(
            project.path(),
            UpsertRendererSnapshotRequest {
                node_id: "node-a".to_string(),
                snapshot_key: "v2".to_string(),
                path: second.to_string_lossy().into_owned(),
            },
        )
        .expect("second upsert");
        assert!(!first.exists());
        assert!(second.exists());
        let saved = read_snapshots_for_project(project.path()).expect("read manifest");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].snapshot_key, "v2");
    }

    #[test]
    fn upsert_does_not_remove_a_previous_image_still_referenced_by_another_node() {
        let (project, first) = project_with_image();
        upsert_snapshot_for_project(
            project.path(),
            UpsertRendererSnapshotRequest {
                node_id: "node-a".to_string(),
                snapshot_key: "v1".to_string(),
                path: first.to_string_lossy().into_owned(),
            },
        )
        .expect("first upsert");
        let manifest = read_manifest(project.path())
            .expect("read manifest")
            .expect("manifest");
        let mut second_manifest = manifest.clone();
        second_manifest.snapshots.push(RendererSnapshotRecord {
            node_id: "node-b".to_string(),
            snapshot_key: "v1".to_string(),
            path: first.to_string_lossy().into_owned(),
        });
        write_manifest(project.path(), &second_manifest).expect("write shared manifest");
        let second = project
            .path()
            .join(SNAPSHOT_DIRECTORY_RELATIVE_PATH)
            .join("second.png");
        fs::write(&second, b"second").expect("second image");
        upsert_snapshot_for_project(
            project.path(),
            UpsertRendererSnapshotRequest {
                node_id: "node-a".to_string(),
                snapshot_key: "v2".to_string(),
                path: second.to_string_lossy().into_owned(),
            },
        )
        .expect("replace shared record");
        assert!(first.exists());
    }

    #[test]
    fn manifest_is_bounded() {
        let (project, image) = project_with_image();
        let snapshots = (0..=RENDERER_SNAPSHOT_MAX_ENTRIES)
            .map(|index| RendererSnapshotRecord {
                node_id: format!("node-{index}"),
                snapshot_key: "v1".to_string(),
                path: image.to_string_lossy().into_owned(),
            })
            .collect::<Vec<_>>();
        assert!(write_manifest(
            project.path(),
            &RendererSnapshotManifest {
                schema_version: RENDERER_SNAPSHOT_MANIFEST_VERSION,
                snapshots,
            },
        )
        .is_err());
    }
}
