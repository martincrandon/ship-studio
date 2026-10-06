//! # Static Server Commands
//!
//! Tauri commands for managing the built-in static file server
//! used by plain HTML/CSS/JS projects.

use crate::errors::CommandError;
use crate::utils::validate_project_path;

/// Start a static file server for a project, returning the port it's listening on.
/// Also starts a file watcher that emits `static-file-changed` events for live reload.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn start_static_server(
    app: tauri::AppHandle,
    window_label: String,
    project_path: String,
    serve_path: String,
) -> Result<u16, CommandError> {
    let validated = validate_project_path(&project_path)?;
    let validated_serve_path = validate_project_path(&serve_path)?;
    let project_root = dunce::canonicalize(&validated)?;
    let serve_root = dunce::canonicalize(&validated_serve_path)?;
    if !serve_root.starts_with(&project_root) {
        return Err(CommandError::Validation {
            field: "serve_path".into(),
            reason: "The static preview folder must be inside the project".into(),
        });
    }
    crate::static_server::start_static_server(
        app,
        window_label,
        validated.to_string_lossy().to_string(),
        validated_serve_path.to_string_lossy().to_string(),
    )
    .await
    .map_err(CommandError::from)
}

/// Stop the static file server for one project in a window.
#[tauri::command]
#[tracing::instrument]
pub fn stop_static_server(window_label: String, project_path: String) -> Result<(), CommandError> {
    crate::static_server::stop_static_server(&window_label, &project_path);
    Ok(())
}
