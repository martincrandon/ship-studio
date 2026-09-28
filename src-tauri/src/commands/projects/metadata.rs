//! Project metadata read/write commands.
//!
//! Generic read/write of `.shipstudio/project.json`, plus the `has_vercel_config`
//! check. Per-topic metadata accessors live in sibling modules (`ui_state`,
//! `dev_server`).

use crate::errors::CommandError;
use crate::types::{ProjectMetadata, PROJECT_METADATA_SCHEMA_VERSION};
use crate::utils::validate_project_path;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

/// Process-local read-modify-write locks, keyed by validated project path.
///
/// The lock is deliberately synchronous and is held only while reading and
/// replacing project.json. Callers must do unrelated work before or after
/// `update_project_metadata`; no async lock is held across that work.
static PROJECT_METADATA_LOCKS: LazyLock<Mutex<HashMap<std::path::PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn project_metadata_lock(project: &Path) -> Result<Arc<Mutex<()>>, CommandError> {
    let mut locks = PROJECT_METADATA_LOCKS
        .lock()
        .map_err(|_| "project metadata lock map poisoned")?;
    Ok(locks
        .entry(project.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn read_project_metadata_unlocked(project: &Path) -> Result<ProjectMetadata, CommandError> {
    let metadata_path = project.join(".shipstudio").join("project.json");
    if !metadata_path.exists() {
        return Ok(ProjectMetadata::default());
    }

    let contents = std::fs::read_to_string(&metadata_path).map_err(|e| {
        crate::utils::classify_fs_error("read project metadata", &metadata_path, &e)
    })?;
    let mut metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {e}"))?;
    if metadata.migrate() {
        // The caller already holds the project lock. Keep legacy metadata
        // migration atomic with the read that triggered it.
        save_project_metadata_unlocked(project, &metadata)?;
    }
    Ok(metadata)
}

/// Read, mutate, and atomically replace one project's metadata as one
/// serialized operation. The closure runs while the per-project lock is held,
/// so it must remain a small in-memory mutation only.
pub(crate) fn update_project_metadata<F, T>(project: &Path, mutate: F) -> Result<T, CommandError>
where
    F: FnOnce(&mut ProjectMetadata) -> Result<T, CommandError>,
{
    let lock = project_metadata_lock(project)?;
    let _guard = lock.lock().map_err(|_| "project metadata lock poisoned")?;
    let mut metadata = read_project_metadata_unlocked(project)?;
    let result = mutate(&mut metadata)?;
    save_project_metadata_unlocked(project, &metadata)?;
    Ok(result)
}

/// Persist `metadata` to `<project>/.shipstudio/project.json`, creating the
/// `.shipstudio` directory as needed.
///
/// Shared by every project.json writer (metadata, ui_state, dev_server,
/// shopify, thumbnail) so filesystem failures classify identically through
/// `classify_fs_error`: macOS TCC EPERM, Windows access-denied, and read-only
/// volumes become actionable `Expected` errors instead of a bare "Operation
/// not permitted (os error 1)" reaching telemetry (issue #625).
pub(crate) fn save_project_metadata(
    project: &std::path::Path,
    metadata: &ProjectMetadata,
) -> Result<(), CommandError> {
    let lock = project_metadata_lock(project)?;
    let _guard = lock.lock().map_err(|_| "project metadata lock poisoned")?;
    save_project_metadata_unlocked(project, metadata)
}

fn save_project_metadata_unlocked(
    project: &std::path::Path,
    metadata: &ProjectMetadata,
) -> Result<(), CommandError> {
    let shipstudio_dir = project.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| {
            crate::utils::classify_fs_error(
                "create this project's .shipstudio folder",
                &shipstudio_dir,
                &e,
            )
        })?;
    }

    let metadata_path = shipstudio_dir.join("project.json");
    let contents = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;

    // Write beside the destination and rename so readers never observe a
    // partially-written JSON document. The temporary file and destination
    // share a directory, preserving atomic replacement on supported
    // filesystems.
    let mut temporary = tempfile::NamedTempFile::new_in(&shipstudio_dir).map_err(|e| {
        crate::utils::classify_fs_error(
            "create project metadata temporary file",
            &metadata_path,
            &e,
        )
    })?;
    temporary.write_all(contents.as_bytes()).map_err(|e| {
        crate::utils::classify_fs_error("write project metadata", &metadata_path, &e)
    })?;
    temporary.as_file().sync_all().map_err(|e| {
        crate::utils::classify_fs_error("sync project metadata", &metadata_path, &e)
    })?;
    let temporary_path = temporary.into_temp_path();
    crate::utils::atomic_replace(&temporary_path, &metadata_path).map_err(|error| {
        crate::utils::classify_fs_error("replace project metadata", &metadata_path, &error)
    })?;
    Ok(())
}

/// Reads project metadata from .shipstudio/project.json with automatic schema migration
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn read_project_metadata(
    project_path: String,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let project = validate_project_path(&project_path)?;
    read_project_metadata_sync(&project)
}

pub(crate) fn read_project_metadata_sync(
    project: &Path,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let metadata_path = project.join(".shipstudio").join("project.json");
    if !metadata_path.exists() {
        return Ok(None);
    }

    let lock = project_metadata_lock(project)?;
    let _guard = lock.lock().map_err(|_| "project metadata lock poisoned")?;
    Ok(Some(read_project_metadata_unlocked(project)?))
}

/// Writes project metadata to .shipstudio/project.json
/// Always ensures the schema_version is set to the current version.
#[tauri::command]
#[tracing::instrument(skip(metadata), fields(project = %project_path))]
pub async fn write_project_metadata(
    project_path: String,
    mut metadata: ProjectMetadata,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;

    // Ensure schema_version is current when writing
    metadata.schema_version = PROJECT_METADATA_SCHEMA_VERSION;

    save_project_metadata(&project, &metadata)
}

/// Checks whether a project has a `.vercel/project.json` config file.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn has_vercel_config(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(project.join(".vercel").join("project.json").exists())
}

#[cfg(test)]
mod save_project_metadata_tests {
    use super::*;
    use crate::types::{PublishRecord, SavedTerminalTab, TerminalState};
    use std::sync::{Arc, Barrier, Mutex as StdMutex};
    use std::thread;

    #[test]
    fn roundtrips_metadata_and_creates_shipstudio_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let metadata = ProjectMetadata {
            custom_dev_command: Some("bun dev".to_string()),
            ..Default::default()
        };
        save_project_metadata(tmp.path(), &metadata).unwrap();

        let written = tmp.path().join(".shipstudio").join("project.json");
        let parsed: ProjectMetadata =
            serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        assert_eq!(parsed.custom_dev_command.as_deref(), Some("bun dev"));
    }

    // The #625 shape: a write failure must route through classify_fs_error
    // (labeled with action + path), never a bare OS string.
    #[test]
    #[cfg(unix)]
    fn write_failure_is_labeled() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        // Pre-create .shipstudio, then make it unwritable so fs::write fails.
        let dir = tmp.path().join(".shipstudio");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let err = save_project_metadata(tmp.path(), &ProjectMetadata::default()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("project metadata"), "got: {msg}");
        assert!(msg.contains("project.json"), "got: {msg}");

        // Restore so TempDir cleanup can delete it.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn concurrent_metadata_updates_preserve_unrelated_fields() {
        let tmp = tempfile::TempDir::new().unwrap();
        let project = tmp.path().to_path_buf();
        let mut initial = ProjectMetadata::default();
        initial.last_opened = Some(7);
        initial.publish.staging = Some(PublishRecord {
            url: "https://staging.example.test".to_string(),
            state: "ready".to_string(),
            published_at: 8,
        });
        initial.publish.production = Some(PublishRecord {
            url: "https://production.example.test".to_string(),
            state: "ready".to_string(),
            published_at: 9,
        });
        save_project_metadata(&project, &initial).unwrap();

        // Release several independent writers together. Each update must read
        // the state produced by the previous writer while retaining fields it
        // does not own; the old read-then-write call sites lost one of these
        // updates whenever their reads interleaved.
        let start = Arc::new(Barrier::new(3));
        let errors = Arc::new(StdMutex::new(Vec::new()));
        let mut workers = Vec::new();
        for update in [0_u8, 1, 2] {
            let project = project.clone();
            let start = Arc::clone(&start);
            let errors = Arc::clone(&errors);
            workers.push(thread::spawn(move || {
                start.wait();
                let result = update_project_metadata(&project, |metadata| {
                    thread::yield_now();
                    match update {
                        0 => {
                            metadata.component_canvas = Some(serde_json::json!({
                                "version": 2,
                                "nodes": [{"id": "canvas-node"}]
                            }))
                        }
                        1 => {
                            metadata.terminal_state = Some(TerminalState {
                                tabs: vec![SavedTerminalTab {
                                    agent_id: "codex".to_string(),
                                    session_id: "session-1".to_string(),
                                    custom_title: None,
                                }],
                                active_tab_index: 0,
                            })
                        }
                        2 => metadata.last_opened = Some(42),
                        _ => unreachable!(),
                    }
                    Ok(())
                });
                if let Err(error) = result {
                    errors.lock().unwrap().push(error.to_string());
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(errors.lock().unwrap().is_empty());

        let final_metadata = read_project_metadata_sync(&project).unwrap().unwrap();
        assert_eq!(final_metadata.last_opened, Some(42));
        assert_eq!(
            final_metadata.component_canvas.as_ref().unwrap()["version"],
            2
        );
        assert_eq!(
            final_metadata.terminal_state.as_ref().unwrap().tabs[0].agent_id,
            "codex"
        );
        assert_eq!(
            final_metadata.publish.staging.as_ref().unwrap().url,
            "https://staging.example.test"
        );
        assert_eq!(
            final_metadata.publish.production.as_ref().unwrap().url,
            "https://production.example.test"
        );
    }
}
