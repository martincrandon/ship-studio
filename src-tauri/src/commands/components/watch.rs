//! Project-scoped source watching for the native Components index.
//!
//! The watcher is deliberately separate from the snapshot command. `notify`
//! only tells us that a source-shaped path may have changed; after a debounce
//! the worker-side catalog is still refreshed from a bounded, validated
//! snapshot. No source contents are emitted in the event payload.

use super::inventory;
use super::types::ComponentSourceSnapshot;
use crate::errors::CommandError;
use crate::utils::validate_project_path;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

const DEBOUNCE_MS: u64 = 250;
const WATCH_EVENT: &str = "component-source-changed";

#[derive(Debug)]
struct WatchHandle {
    project_root: PathBuf,
    shutdown: Option<oneshot::Sender<()>>,
}

/// A source event is intentionally metadata-only. The frontend asks the
/// bounded inventory command for the new snapshot and computes the exact
/// worker update from the previous immutable revision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentSourceChangeEvent {
    pub window_label: String,
    pub project_path: String,
    pub revision: String,
    pub changed_files: Vec<String>,
}

static WATCHERS: LazyLock<Mutex<HashMap<String, WatchHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_watchers(
) -> Result<std::sync::MutexGuard<'static, HashMap<String, WatchHandle>>, CommandError> {
    WATCHERS.lock().map_err(|_| CommandError::Other {
        message: "component source watcher state is unavailable".to_string(),
    })
}

/// Start one watcher for a window. Starting again for the same project is
/// idempotent; starting for another project replaces the old window watcher.
pub(crate) async fn start_component_source_watch(
    app: AppHandle,
    window_label: String,
    project_path: String,
) -> Result<(), CommandError> {
    if window_label.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "windowLabel".to_string(),
            reason: "a window label is required".to_string(),
        });
    }
    let project_root = validate_project_path(&project_path)?;
    let initial = inventory::snapshot_for_root(&project_root)?;

    let previous = {
        let mut watchers = lock_watchers()?;
        if let Some(existing) = watchers.get(&window_label) {
            if existing.project_root == project_root {
                return Ok(());
            }
        }
        watchers.remove(&window_label)
    };
    if let Some(mut previous) = previous {
        if let Some(shutdown) = previous.shutdown.take() {
            let _ = shutdown.send(());
        }
    }

    let shutdown = spawn_watcher(app, window_label.clone(), project_root.clone(), initial);
    lock_watchers()?.insert(
        window_label,
        WatchHandle {
            project_root,
            shutdown: Some(shutdown),
        },
    );
    Ok(())
}

/// Stop the watcher for one window/project pair. A stale cleanup call for a
/// different project is a no-op so it cannot stop a newer session.
pub(crate) async fn stop_component_source_watch(
    window_label: String,
    project_path: String,
) -> Result<(), CommandError> {
    let project_root = validate_project_path(&project_path)?;
    stop_for_window_project(&window_label, &project_root)?;
    Ok(())
}

/// Used by project/window teardown paths that already have a validated window
/// identity and do not need to make a second Tauri command round trip.
pub(crate) fn stop_for_window(window_label: &str) {
    let Ok(mut watchers) = WATCHERS.lock() else {
        warn!(window = %window_label, "component watcher state lock is poisoned");
        return;
    };
    if let Some(mut handle) = watchers.remove(window_label) {
        if let Some(shutdown) = handle.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

pub(crate) fn stop_all() {
    let labels = WATCHERS
        .lock()
        .map(|watchers| watchers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for label in labels {
        stop_for_window(&label);
    }
}

fn stop_for_window_project(window_label: &str, project_root: &Path) -> Result<(), CommandError> {
    let mut watchers = lock_watchers()?;
    let Some(watcher) = watchers.get(window_label) else {
        return Ok(());
    };
    if watcher.project_root != project_root {
        return Ok(());
    }
    let Some(mut handle) = watchers.remove(window_label) else {
        return Ok(());
    };
    if let Some(shutdown) = handle.shutdown.take() {
        let _ = shutdown.send(());
    }
    Ok(())
}

fn spawn_watcher(
    app: AppHandle,
    window_label: String,
    project_root: PathBuf,
    initial: ComponentSourceSnapshot,
) -> oneshot::Sender<()> {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop_flag);
    let watch_root = project_root.clone();
    let thread_window = window_label.clone();

    std::thread::spawn(move || {
        let callback_root = watch_root.clone();
        let mut watcher = match notify::recommended_watcher(
            move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else {
                    return;
                };
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in event.paths {
                            if inventory::is_relevant_watch_path(&path, &callback_root) {
                                let _ = event_tx.send(path);
                            }
                        }
                    }
                    _ => {}
                }
            },
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                warn!(
                    window = %thread_window,
                    error = %error,
                    "could not create component source watcher"
                );
                return;
            }
        };

        let workspace = match inventory::active_workspace_for_root(&watch_root) {
            Ok(workspace) => workspace,
            Err(error) => {
                warn!(window = %thread_window, error = %error, "could not resolve component watch workspace");
                return;
            }
        };
        if let Err(error) = watcher.watch(&workspace, RecursiveMode::Recursive) {
            warn!(window = %thread_window, error = %error, "could not watch component workspace");
            return;
        }
        info!(window = %thread_window, path = %workspace.display(), "component source watcher started");

        while !stop_for_thread.load(Ordering::Relaxed) {
            std::thread::park_timeout(Duration::from_secs(1));
        }
        debug!(window = %thread_window, "component source watcher stopped");
    });

    tokio::spawn(async move {
        let mut last_snapshot = initial;
        loop {
            tokio::select! {
                Some(first_path) = event_rx.recv() => {
                    let mut paths = HashSet::new();
                    paths.insert(first_path);
                    loop {
                        let sleep = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS));
                        tokio::pin!(sleep);
                        tokio::select! {
                            _ = &mut sleep => break,
                            Some(path) = event_rx.recv() => {
                                paths.insert(path);
                            }
                            else => break,
                        }
                    }
                    while let Ok(path) = event_rx.try_recv() {
                        paths.insert(path);
                    }

                    let root = project_root.clone();
                    let next = tokio::task::spawn_blocking(move || inventory::snapshot_for_root(&root)).await;
                    let Ok(Ok(next_snapshot)) = next else {
                        warn!(window = %window_label, "component source snapshot failed after file change");
                        continue;
                    };
                    if next_snapshot.revision == last_snapshot.revision {
                        continue;
                    }
                    let changed_files = changed_files(&last_snapshot, &next_snapshot);
                    if changed_files.is_empty() {
                        last_snapshot = next_snapshot;
                        continue;
                    }
                    let event = ComponentSourceChangeEvent {
                        window_label: window_label.clone(),
                        project_path: project_root.to_string_lossy().to_string(),
                        revision: next_snapshot.revision.clone(),
                        changed_files,
                    };
                    if let Err(error) = app.emit_to(&window_label, WATCH_EVENT, event) {
                        warn!(window = %window_label, error = %error, "could not emit component source change");
                    }
                    last_snapshot = next_snapshot;
                }
                _ = &mut shutdown_rx => {
                    stop_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
        stop_flag.store(true, Ordering::Relaxed);
    });

    shutdown_tx
}

fn changed_files(before: &ComponentSourceSnapshot, after: &ComponentSourceSnapshot) -> Vec<String> {
    let before_hashes = before
        .files
        .iter()
        .map(|file| (file.file.as_str(), file.content_hash.as_str()))
        .collect::<HashMap<_, _>>();
    let after_hashes = after
        .files
        .iter()
        .map(|file| (file.file.as_str(), file.content_hash.as_str()))
        .collect::<HashMap<_, _>>();
    let mut paths = before_hashes
        .keys()
        .chain(after_hashes.keys())
        .map(|path| (*path).to_string())
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter(|path| before_hashes.get(path.as_str()) != after_hashes.get(path.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::inventory;
    use super::*;
    use crate::commands::components::types::{content_hash, SourceFileSnapshot};
    use tempfile::TempDir;

    fn file(path: &str, content: &str) -> SourceFileSnapshot {
        SourceFileSnapshot {
            file: path.to_string(),
            content: content.to_string(),
            content_hash: content_hash(content.as_bytes()),
        }
    }

    fn snapshot(files: Vec<SourceFileSnapshot>) -> ComponentSourceSnapshot {
        ComponentSourceSnapshot {
            workspace_root: ".".to_string(),
            revision: "revision".to_string(),
            files,
            partial: false,
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn changed_files_is_sorted_and_reports_create_change_delete() {
        let before = snapshot(vec![
            file("src/z.tsx", "old"),
            file("src/remove.tsx", "gone"),
        ]);
        let after = snapshot(vec![file("src/z.tsx", "new"), file("src/add.tsx", "new")]);

        assert_eq!(
            changed_files(&before, &after),
            vec![
                "src/add.tsx".to_string(),
                "src/remove.tsx".to_string(),
                "src/z.tsx".to_string(),
            ]
        );
    }

    #[test]
    fn watcher_filter_ignores_generated_trees_and_non_source_files() {
        let temp = TempDir::new().unwrap();
        let workspace = temp.path();

        assert!(inventory::is_relevant_watch_path(
            &workspace.join("src/Button.tsx"),
            workspace
        ));
        assert!(inventory::is_relevant_watch_path(
            &workspace.join("src/components"),
            workspace
        ));
        assert!(!inventory::is_relevant_watch_path(
            &workspace.join("node_modules/pkg/index.ts"),
            workspace
        ));
        assert!(!inventory::is_relevant_watch_path(
            &workspace.join(".next/server/app.js"),
            workspace
        ));
        assert!(!inventory::is_relevant_watch_path(
            &workspace.join("src/styles.css"),
            workspace
        ));
    }
}
