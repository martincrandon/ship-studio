//! Bounded, read-only source inventory for the component index worker.
//!
//! This module never executes project code.  It walks only the resolved active
//! workspace, applies the repository's normal ignore rules plus generated/build
//! directory guards, and returns UTF-8 source files with content hashes.

use super::types::{
    content_hash, revision_for_workspace, ComponentSourceDiagnostic, ComponentSourceSnapshot,
    SourceFileSnapshot,
};
use crate::errors::CommandError;
use crate::utils::{canonicalize_tagged, resolve_workspace_path, validate_project_path};
use ignore::WalkBuilder;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Explicit bounds keep a large or generated repository from blocking the
/// Tauri command or exhausting the worker's memory.  Tests use the injectable
/// [`InventoryLimits`] below to exercise each limit without creating thousands
/// of files.
pub(crate) const MAX_SOURCE_FILES: usize = 10_000;
pub(crate) const MAX_SOURCE_FILE_BYTES: u64 = 1_024 * 1_024;
pub(crate) const MAX_SOURCE_TOTAL_BYTES: u64 = 32 * 1_024 * 1_024;
pub(crate) const MAX_SOURCE_DIAGNOSTICS: usize = 128;
pub(crate) const MAX_BATCH_FILES: usize = 256;
pub(crate) const MAX_BATCH_TOTAL_BYTES: u64 = 32 * 1_024 * 1_024;
/// Count every directory/file entry, not just source files, so a repository
/// full of ignored or non-source entries cannot make the walk unbounded.
pub(crate) const MAX_SOURCE_WALK_ENTRIES: usize = 100_000;

const IGNORED_DIRECTORIES: &[&str] = &[
    ".astro",
    ".cache",
    ".git",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".svelte-kit",
    ".turbo",
    ".vercel",
    ".vite",
    ".shipstudio",
    "build",
    "coverage",
    "dist",
    "generated",
    "node_modules",
    "out",
    "output",
    "target",
    "vendor",
];

#[derive(Debug, Clone, Copy)]
pub(crate) struct InventoryLimits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_diagnostics: usize,
}

impl Default for InventoryLimits {
    fn default() -> Self {
        Self {
            max_files: MAX_SOURCE_FILES,
            max_file_bytes: MAX_SOURCE_FILE_BYTES,
            max_total_bytes: MAX_SOURCE_TOTAL_BYTES,
            max_diagnostics: MAX_SOURCE_DIAGNOSTICS,
        }
    }
}

#[derive(Debug)]
struct InventoryResult {
    files: Vec<SourceFileSnapshot>,
    partial: bool,
    diagnostics: Vec<ComponentSourceDiagnostic>,
}

fn warning(
    code: impl Into<String>,
    message: impl Into<String>,
    file: Option<String>,
) -> ComponentSourceDiagnostic {
    ComponentSourceDiagnostic::warning(code, message, file)
}

fn validation(field: impl Into<String>, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.into(),
        reason: reason.into(),
    }
}

/// Tauri entry point helper.  Validation happens before workspace resolution so
/// a caller can never use this command to scan an arbitrary directory.
pub(crate) fn snapshot_for_project(
    project_path: &str,
) -> Result<ComponentSourceSnapshot, CommandError> {
    let project_root = validate_project_path(project_path)?;
    snapshot_for_root(&project_root)
}

/// Build a snapshot for an already validated project root.  Kept separate from
/// the Tauri wrapper so security and limit behavior can be tested in isolation.
pub(crate) fn snapshot_for_root(
    project_root: &Path,
) -> Result<ComponentSourceSnapshot, CommandError> {
    snapshot_for_root_with_limits(project_root, InventoryLimits::default())
}

pub(crate) fn snapshot_for_root_with_limits(
    project_root: &Path,
    limits: InventoryLimits,
) -> Result<ComponentSourceSnapshot, CommandError> {
    let project_root = canonicalize_tagged(project_root, "component_snapshot_project")?;
    let workspace = active_workspace_for_root(&project_root)?;
    let inventory = collect_source_files(&project_root, &workspace, limits)?;
    let revision = revision_for_workspace(
        &workspace,
        inventory
            .files
            .iter()
            .map(|file| (file.file.clone(), file.content_hash.clone())),
    );

    Ok(ComponentSourceSnapshot {
        workspace_root: workspace_relative(&project_root, &workspace),
        revision,
        files: inventory.files,
        partial: inventory.partial,
        diagnostics: inventory.diagnostics,
    })
}

/// Read exactly the requested project-relative source files after checking the
/// caller's snapshot revision.  Requests are limited to files in that immutable
/// active-workspace snapshot; callers cannot use this endpoint to probe ignored
/// files or source outside the indexed workspace.
pub(crate) fn read_batch_for_project(
    project_path: &str,
    relative_paths: &[String],
    expected_revision: &str,
) -> Result<Vec<SourceFileSnapshot>, CommandError> {
    let project_root = validate_project_path(project_path)?;
    read_batch_for_root(&project_root, relative_paths, expected_revision)
}

pub(crate) fn read_batch_for_root(
    project_root: &Path,
    relative_paths: &[String],
    expected_revision: &str,
) -> Result<Vec<SourceFileSnapshot>, CommandError> {
    if expected_revision.is_empty() {
        return Err(validation(
            "expectedRevision",
            "a non-empty source revision is required",
        ));
    }
    if relative_paths.len() > MAX_BATCH_FILES {
        return Err(validation(
            "relativePaths",
            format!("at most {MAX_BATCH_FILES} source files may be requested"),
        ));
    }

    let project_root = canonicalize_tagged(project_root, "component_batch_project")?;
    let current = snapshot_for_root(&project_root)?;
    if current.revision != expected_revision {
        return Err(validation(
            "expectedRevision",
            "the project source changed; refresh the component snapshot and retry",
        ));
    }
    if relative_paths.is_empty() {
        return Ok(Vec::new());
    }

    let tracked_files: std::collections::HashSet<&str> = current
        .files
        .iter()
        .map(|file| file.file.as_str())
        .collect();
    let mut seen = std::collections::HashSet::with_capacity(relative_paths.len());
    let mut result = Vec::with_capacity(relative_paths.len());
    let mut total_bytes = 0_u64;
    for relative in relative_paths {
        validate_relative_source_path(relative)?;
        if !seen.insert(relative.as_str()) {
            return Err(validation(
                "relativePaths",
                format!("duplicate source path '{relative}'"),
            ));
        }
        if !tracked_files.contains(relative.as_str()) {
            return Err(validation(
                "relativePaths",
                format!("source file '{relative}' is not in the active source snapshot"),
            ));
        }
        let file = read_exact_source_file(&project_root, relative, MAX_SOURCE_FILE_BYTES)?;
        total_bytes = total_bytes.saturating_add(file.content.len() as u64);
        if total_bytes > MAX_BATCH_TOTAL_BYTES {
            return Err(validation(
                "relativePaths",
                format!("requested source exceeds the {MAX_BATCH_TOTAL_BYTES}-byte batch limit"),
            ));
        }
        result.push(file);
    }
    let after = snapshot_for_root(&project_root)?;
    if after.revision != expected_revision {
        return Err(validation(
            "expectedRevision",
            "the project source changed while files were being read; refresh and retry",
        ));
    }
    Ok(result)
}

pub(crate) fn active_workspace_for_root(project_root: &Path) -> Result<PathBuf, CommandError> {
    let workspace = resolve_workspace_path(project_root);
    let canonical_workspace = canonicalize_tagged(&workspace, "component_workspace")?;
    if !canonical_workspace.starts_with(project_root) {
        return Err(validation(
            "workspace",
            "the resolved workspace is outside the project root",
        ));
    }
    if !canonical_workspace.is_dir() {
        return Err(validation(
            "workspace",
            "the resolved workspace is not a directory",
        ));
    }
    Ok(canonical_workspace)
}

fn collect_source_files(
    project_root: &Path,
    workspace: &Path,
    limits: InventoryLimits,
) -> Result<InventoryResult, CommandError> {
    let mut files = Vec::new();
    let mut diagnostics = Vec::new();
    let mut partial = false;
    let mut total_bytes = 0_u64;
    let mut entries_seen = 0_usize;
    let mut add_diagnostic = |code: &'static str, message: String, file: Option<String>| {
        partial = true;
        if diagnostics.len() < limits.max_diagnostics {
            diagnostics.push(warning(code, message, file));
        }
    };

    let mut walker = WalkBuilder::new(workspace);
    let workspace_for_filter = workspace.to_path_buf();
    walker
        .standard_filters(true)
        .follow_links(false)
        .filter_entry(move |entry| !is_ignored_directory(entry.path(), &workspace_for_filter));

    for result in walker.build() {
        if entries_seen >= MAX_SOURCE_WALK_ENTRIES {
            add_diagnostic(
                "source_entry_limit",
                format!("source walk entry limit reached ({MAX_SOURCE_WALK_ENTRIES})"),
                None,
            );
            break;
        }
        entries_seen += 1;
        if files.len() >= limits.max_files {
            add_diagnostic(
                "source_file_limit",
                format!("source file limit reached ({})", limits.max_files),
                None,
            );
            break;
        }

        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                add_diagnostic(
                    "source_walk_error",
                    format!("source walk skipped an entry: {}", sanitize_error(&error)),
                    None,
                );
                continue;
            }
        };
        let path = entry.path();
        if path == workspace || !is_source_file(path) {
            continue;
        }

        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                add_diagnostic(
                    "source_file_inspection",
                    format!(
                        "source file could not be inspected: {}",
                        sanitize_error(&error)
                    ),
                    Some(relative_posix(project_root, path)),
                );
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            report_symlink(&mut add_diagnostic, project_root, path);
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if relative_path_has_unsupported_component(project_root, path) {
            add_diagnostic(
                "source_path_unsupported",
                "source path cannot be represented safely in the POSIX wire format".to_string(),
                Some(relative_posix(project_root, path)),
            );
            continue;
        }

        let canonical = match dunce::canonicalize(path) {
            Ok(canonical) => canonical,
            Err(error) => {
                add_diagnostic(
                    "source_file_resolution",
                    format!(
                        "source file could not be resolved: {}",
                        sanitize_error(&error)
                    ),
                    Some(relative_posix(project_root, path)),
                );
                continue;
            }
        };
        if !canonical.starts_with(project_root) {
            add_diagnostic(
                "source_symlink_escape",
                "source file escaped the project root and was skipped".to_string(),
                Some(relative_posix(project_root, path)),
            );
            continue;
        }
        if metadata.len() > limits.max_file_bytes {
            add_diagnostic(
                "source_file_too_large",
                format!(
                    "source file exceeds the {}-byte per-file limit",
                    limits.max_file_bytes
                ),
                Some(relative_posix(project_root, path)),
            );
            continue;
        }
        if total_bytes.saturating_add(metadata.len()) > limits.max_total_bytes {
            add_diagnostic(
                "source_snapshot_too_large",
                format!(
                    "source snapshot total limit reached ({} bytes)",
                    limits.max_total_bytes
                ),
                None,
            );
            break;
        }

        let relative = relative_posix(project_root, path);
        match read_source_file(path, metadata.len(), &relative) {
            Ok(file) => {
                total_bytes = total_bytes.saturating_add(file.content.len() as u64);
                files.push(file);
            }
            Err(error) => add_diagnostic(
                if error.contains("UTF-8") {
                    "source_file_invalid_utf8"
                } else if error.contains("changed") {
                    "source_file_changed"
                } else {
                    "source_file_read"
                },
                error,
                Some(relative),
            ),
        }
    }

    files.sort_by(|left, right| left.file.cmp(&right.file));
    Ok(InventoryResult {
        files,
        partial,
        diagnostics,
    })
}

fn read_exact_source_file(
    project_root: &Path,
    relative: &str,
    max_bytes: u64,
) -> Result<SourceFileSnapshot, CommandError> {
    let path = validated_existing_path(project_root, relative)?;
    let metadata = std::fs::metadata(&path).map_err(|error| CommandError::Io {
        message: format!("could not inspect source file '{relative}': {error}"),
    })?;
    if metadata.len() > max_bytes {
        return Err(validation(
            "relativePaths",
            format!("source file '{relative}' exceeds the {max_bytes}-byte limit"),
        ));
    }
    read_source_file(&path, metadata.len(), relative).map_err(|message| CommandError::Io {
        message: format!("could not read source file '{relative}': {message}"),
    })
}

fn read_source_file(
    path: &Path,
    expected_bytes: u64,
    relative: &str,
) -> Result<SourceFileSnapshot, String> {
    let mut bytes = Vec::with_capacity(expected_bytes.min(usize::MAX as u64) as usize);
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(expected_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != expected_bytes {
        return Err("source changed while it was being read".to_string());
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| "source is not valid UTF-8 and was skipped".to_string())?;
    Ok(SourceFileSnapshot {
        file: relative.to_string(),
        content_hash: content_hash(&bytes),
        content,
    })
}

pub(crate) fn validated_existing_path(
    project_root: &Path,
    relative: &str,
) -> Result<PathBuf, CommandError> {
    validate_relative_source_path(relative)?;
    let candidate = project_root.join(relative);
    let canonical = dunce::canonicalize(&candidate).map_err(|error| CommandError::Io {
        message: format!("could not resolve source file '{relative}': {error}"),
    })?;
    if !canonical.starts_with(project_root) {
        return Err(validation(
            "relativePaths",
            format!("source file '{relative}' is outside the project root"),
        ));
    }
    if path_contains_symlink(project_root, &candidate) {
        return Err(validation(
            "relativePaths",
            format!("source file '{relative}' is reached through a symlink"),
        ));
    }
    let metadata = std::fs::symlink_metadata(&candidate).map_err(|error| CommandError::Io {
        message: format!("could not inspect source file '{relative}': {error}"),
    })?;
    if metadata.file_type().is_symlink() {
        return Err(validation(
            "relativePaths",
            format!("source file '{relative}' is a symlink"),
        ));
    }
    if !metadata.is_file() {
        return Err(validation(
            "relativePaths",
            format!("source path '{relative}' is not a regular file"),
        ));
    }
    Ok(canonical)
}

pub(crate) fn validate_relative_source_path(relative: &str) -> Result<(), CommandError> {
    if relative.is_empty() || relative.contains('\0') {
        return Err(validation(
            "relativePaths",
            "source paths must be non-empty",
        ));
    }
    // The wire format is POSIX-relative even on Windows.  Rejecting backslash
    // avoids two spellings of the same path and prevents platform-specific
    // traversal behavior.
    if relative.contains('\\') {
        return Err(validation(
            "relativePaths",
            "source paths must use POSIX separators",
        ));
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || relative
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(validation(
            "relativePaths",
            format!("source path '{relative}' must be a normalized relative path"),
        ));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::Normal(part)
                if part.to_str().map(is_ignored_directory_name).unwrap_or(false)
        )
    }) {
        return Err(validation(
            "relativePaths",
            format!("source path '{relative}' is inside an ignored or generated directory"),
        ));
    }
    if !is_source_file(path) {
        return Err(validation(
            "relativePaths",
            format!("source path '{relative}' is not a supported source extension"),
        ));
    }
    Ok(())
}

fn is_source_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name.ends_with(".d.ts")
        || file_name.ends_with(".d.mts")
        || file_name.ends_with(".d.cts")
    {
        return false;
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs"
            )
        })
        .unwrap_or(false)
}

fn is_ignored_directory(path: &Path, workspace: &Path) -> bool {
    if path == workspace {
        return false;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .map(is_ignored_directory_name)
        .unwrap_or(false)
}

fn is_ignored_directory_name(name: &str) -> bool {
    IGNORED_DIRECTORIES.contains(&name.to_ascii_lowercase().as_str())
}

fn relative_path_has_unsupported_component(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    relative.components().any(|component| {
        let Component::Normal(part) = component else {
            return true;
        };
        let Some(part) = part.to_str() else {
            return true;
        };
        #[cfg(not(windows))]
        {
            part.contains('\\')
        }
        #[cfg(windows)]
        {
            let _ = part;
            false
        }
    })
}

fn path_contains_symlink(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return true;
        };
        current.push(part);
        if std::fs::symlink_metadata(&current)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
        {
            return true;
        }
    }
    false
}

fn report_symlink<F>(add_diagnostic: &mut F, project_root: &Path, path: &Path)
where
    F: FnMut(&'static str, String, Option<String>),
{
    let escaped = dunce::canonicalize(path)
        .map(|canonical| !canonical.starts_with(project_root))
        .unwrap_or(true);
    if escaped {
        add_diagnostic(
            "source_symlink_escape",
            "symlink source escaped the project root and was skipped".to_string(),
            Some(relative_posix(project_root, path)),
        );
    } else {
        add_diagnostic(
            "source_symlink",
            "symlink source was skipped".to_string(),
            Some(relative_posix(project_root, path)),
        );
    }
}

fn relative_posix(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
    #[cfg(windows)]
    {
        relative.replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        relative.into_owned()
    }
}

fn workspace_relative(root: &Path, workspace: &Path) -> String {
    let relative = relative_posix(root, workspace);
    if relative.is_empty() {
        ".".to_string()
    } else {
        relative
    }
}

fn sanitize_error(error: &impl std::fmt::Display) -> String {
    // Walk errors can include absolute paths.  Keep diagnostics useful without
    // exposing a user's home directory over the IPC boundary.
    let message = error
        .to_string()
        .lines()
        .next()
        .unwrap_or("unknown filesystem error")
        .replace('\n', " ");
    if message.contains('/') || message.contains('\\') {
        "filesystem error".to_string()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn limits() -> InventoryLimits {
        InventoryLimits {
            max_files: 10,
            max_file_bytes: MAX_SOURCE_FILE_BYTES,
            max_total_bytes: MAX_SOURCE_TOTAL_BYTES,
            max_diagnostics: MAX_SOURCE_DIAGNOSTICS,
        }
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn inventories_sorted_utf8_sources_and_hashes() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/z.tsx", "const café = 1;\n");
        write(temp.path(), "src/a.ts", "export const A = true;\n");
        write(
            temp.path(),
            "src/module.mjs",
            "export const module = true;\n",
        );
        write(
            temp.path(),
            "src/types.d.ts",
            "declare const hidden: true;\n",
        );
        write(temp.path(), "src/no.css", "body {}\n");

        let snapshot = snapshot_for_root_with_limits(temp.path(), limits()).unwrap();
        assert_eq!(
            snapshot
                .files
                .iter()
                .map(|file| file.file.as_str())
                .collect::<Vec<_>>(),
            vec!["src/a.ts", "src/module.mjs", "src/z.tsx"]
        );
        assert_eq!(
            snapshot.files[0].content_hash,
            content_hash(snapshot.files[0].content.as_bytes())
        );
        assert!(!snapshot.partial);
        assert!(snapshot.diagnostics.is_empty());
    }

    #[test]
    fn skips_ignored_and_generated_directories() {
        let temp = TempDir::new().unwrap();
        for directory in ["node_modules/pkg", "dist", ".next", ".git", ".shipstudio"] {
            write(
                temp.path(),
                &format!("{directory}/ignored.ts"),
                "export const Bad = 1;",
            );
        }
        write(temp.path(), "src/kept.ts", "export const Good = 1;");

        let snapshot = snapshot_for_root_with_limits(temp.path(), limits()).unwrap();
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].file, "src/kept.ts");
    }

    #[test]
    fn marks_oversized_file_as_partial_without_reading_it() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/large.ts", "123456789");
        let snapshot = snapshot_for_root_with_limits(
            temp.path(),
            InventoryLimits {
                max_file_bytes: 4,
                ..limits()
            },
        )
        .unwrap();
        assert!(snapshot.partial);
        assert!(snapshot.files.is_empty());
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|d| d.message.contains("per-file")));
    }

    #[test]
    fn caps_total_snapshot_and_reports_partial() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/a.ts", "12345");
        write(temp.path(), "src/b.ts", "67890");
        let snapshot = snapshot_for_root_with_limits(
            temp.path(),
            InventoryLimits {
                max_total_bytes: 6,
                ..limits()
            },
        )
        .unwrap();
        assert!(snapshot.partial);
        assert!(snapshot.files.len() <= 1);
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|d| d.message.contains("total")));
    }

    #[test]
    fn rejects_traversal_and_non_source_batch_paths() {
        assert!(validate_relative_source_path("../outside.ts").is_err());
        assert!(validate_relative_source_path("src/./file.ts").is_err());
        assert!(validate_relative_source_path("src/file.css").is_err());
        assert!(validate_relative_source_path("/tmp/file.ts").is_err());
        assert!(validate_relative_source_path("src\\file.ts").is_err());
    }

    #[test]
    fn batch_reads_exact_files_and_rejects_stale_revision() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/a.ts", "export const A = 1;");
        write(temp.path(), "src/b.ts", "export const B = 2;");
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let paths = vec!["src/b.ts".to_string()];
        let files = read_batch_for_root(temp.path(), &paths, &snapshot.revision).unwrap();
        assert_eq!(files[0].file, "src/b.ts");
        assert_eq!(files[0].content, "export const B = 2;");

        write(temp.path(), "src/a.ts", "export const A = 3;");
        assert!(read_batch_for_root(temp.path(), &paths, &snapshot.revision).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_batch_files_even_when_target_is_inside_root() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/real.ts", "export const A = 1;");
        symlink(
            temp.path().join("src/real.ts"),
            temp.path().join("src/link.ts"),
        )
        .unwrap();
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        assert!(!snapshot.files.iter().any(|file| file.file == "src/link.ts"));
        let error = read_batch_for_root(
            temp.path(),
            &["src/link.ts".to_string()],
            &snapshot.revision,
        )
        .unwrap_err();
        assert!(error.to_string().contains("symlink"));
    }
}
