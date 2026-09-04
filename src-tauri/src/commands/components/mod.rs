//! Native component source commands.
//!
//! Parsing and framework semantics stay in the frontend worker.  These command
//! handlers provide only bounded source reads and the final hash/path/edit
//! guard before source writes.

mod graph_guard;
mod inventory;
mod mutation;
mod types;
mod watch;

pub(crate) use types::content_hash;
pub use types::{
    ComponentFileMutation, ComponentFileOperation, ComponentGraphDelta, ComponentMutationPlan,
    ComponentMutationResult, ComponentSourceDiagnostic, ComponentSourceSnapshot, ComponentTextEdit,
    SourceFileSnapshot,
};

/// Return a bounded source snapshot for the active resolved workspace.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn get_component_source_snapshot(
    project_path: String,
) -> Result<ComponentSourceSnapshot, crate::errors::CommandError> {
    tokio::task::spawn_blocking(move || inventory::snapshot_for_project(&project_path))
        .await
        .map_err(|error| format!("Component inventory task failed: {error}"))?
}

/// Read an exact, validated batch of project-relative source files after
/// checking that the caller's immutable snapshot revision is still current.
#[tauri::command]
#[tracing::instrument(skip(project_path, relative_paths), fields(project = %project_path))]
pub async fn read_component_source_batch(
    project_path: String,
    relative_paths: Vec<String>,
    expected_revision: String,
) -> Result<Vec<SourceFileSnapshot>, crate::errors::CommandError> {
    tokio::task::spawn_blocking(move || {
        inventory::read_batch_for_project(&project_path, &relative_paths, &expected_revision)
    })
    .await
    .map_err(|error| format!("Component source read task failed: {error}"))?
}

/// Apply one or more parser-planned, hash-guarded source edits atomically.
#[tauri::command]
#[tracing::instrument(skip(project_path, plan), fields(project = %project_path))]
pub async fn apply_component_mutation(
    project_path: String,
    plan: ComponentMutationPlan,
) -> Result<ComponentMutationResult, crate::errors::CommandError> {
    tokio::task::spawn_blocking(move || mutation::apply_for_project(&project_path, plan))
        .await
        .map_err(|error| format!("Component mutation task failed: {error}"))?
}

/// Start the per-window debounced source watcher.
#[tauri::command]
#[tracing::instrument(
    name = "start_component_source_watch",
    skip(app),
    fields(project = %project_path, window = %window_label)
)]
pub async fn start_component_source_watch(
    app: tauri::AppHandle,
    window_label: String,
    project_path: String,
) -> Result<(), crate::errors::CommandError> {
    watch::start_component_source_watch(app, window_label, project_path).await
}

/// Stop the per-window debounced source watcher.
#[tauri::command]
#[tracing::instrument(
    name = "stop_component_source_watch",
    fields(project = %project_path, window = %window_label)
)]
pub async fn stop_component_source_watch(
    window_label: String,
    project_path: String,
) -> Result<(), crate::errors::CommandError> {
    watch::stop_component_source_watch(window_label, project_path).await
}

pub(crate) fn stop_component_source_watch_for_window(window_label: &str) {
    watch::stop_for_window(window_label);
}

pub(crate) fn stop_all_component_source_watches() {
    watch::stop_all();
}
