//! Hash-checked, byte-preserving source mutations for native components.
//!
//! The parser worker is responsible for producing safe ranges and expected
//! result hashes.  Rust is the final filesystem guard: it validates every path,
//! hash, UTF-8 boundary, and edit ordering before staging sibling temporary
//! files.  All files are staged before the first rename, and already-replaced
//! files are restored from sibling backups if a later replacement fails.

use super::graph_guard;
use super::inventory::{
    active_workspace_for_root, snapshot_for_root, validate_relative_source_path,
    validated_existing_path, validated_new_path,
};
use super::types::{
    content_hash, ComponentFileMutation, ComponentFileOperation, ComponentMutationPlan,
    ComponentMutationResult, ComponentSourceSnapshot, ComponentTextEdit, SourceFileSnapshot,
};
use crate::errors::CommandError;
use crate::utils::{canonicalize_tagged, validate_project_path};
#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_MUTATION_FILES: usize = 64;
const MAX_MUTATION_EDITS_PER_FILE: usize = 4_096;
const MAX_MUTATION_INSERTED_BYTES: usize = 8 * 1024 * 1024;
const MAX_MUTATION_SOURCE_FILE_BYTES: u64 = 1_024 * 1_024;
const MAX_MUTATION_SOURCE_TOTAL_BYTES: u64 = 32 * 1_024 * 1_024;

static COMPONENT_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug)]
struct PreparedFile {
    relative: String,
    path: PathBuf,
    original: Vec<u8>,
    updated: Vec<u8>,
    permissions: Permissions,
}

#[derive(Debug)]
struct StagedFile {
    prepared: PreparedFile,
    staged_path: PathBuf,
    backup_path: PathBuf,
}

#[derive(Debug)]
struct PreparedLifecycleTarget {
    relative: String,
    path: PathBuf,
    original: Option<Vec<u8>>,
    updated: Option<Vec<u8>>,
    permissions: Permissions,
}

#[derive(Debug)]
struct StagedLifecycleTarget {
    prepared: PreparedLifecycleTarget,
    staged_path: PathBuf,
    backup_path: PathBuf,
}

#[derive(Debug)]
struct RollbackFailure {
    relative: String,
    retained_backup: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy)]
enum RollbackTargetState {
    Original,
    Updated,
    Missing,
    Changed,
}

#[derive(Debug, Clone, Copy)]
enum LifecycleTargetState {
    Original,
    Updated,
    Missing,
    Changed,
}

fn validation(field: impl Into<String>, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.into(),
        reason: reason.into(),
    }
}

/// Tauri entry point helper.  `plan` is skipped from tracing because it can
/// contain user-authored replacement text.
pub(crate) fn apply_for_project(
    project_path: &str,
    plan: ComponentMutationPlan,
) -> Result<ComponentMutationResult, CommandError> {
    let project_root = validate_project_path(project_path)?;
    apply_for_root(&project_root, &plan)
}

/// Apply a validated component mutation against an already validated root.
/// This helper is intentionally synchronous: every filesystem operation is
/// bounded by the finite plan and the caller runs it in Tauri's command task.
pub(crate) fn apply_for_root(
    project_root: &Path,
    plan: &ComponentMutationPlan,
) -> Result<ComponentMutationResult, CommandError> {
    let has_lifecycle_operations = plan
        .operations
        .as_ref()
        .is_some_and(|operations| !operations.is_empty());
    if plan.files.is_empty() && !has_lifecycle_operations {
        return Err(validation(
            "files",
            "a component mutation must contain at least one file",
        ));
    }
    if plan.files.len() > MAX_MUTATION_FILES {
        return Err(validation(
            "files",
            format!("at most {MAX_MUTATION_FILES} files may be mutated at once"),
        ));
    }
    if plan
        .operations
        .as_ref()
        .is_some_and(|operations| operations.len() > MAX_MUTATION_FILES)
    {
        return Err(validation(
            "operations",
            format!("at most {MAX_MUTATION_FILES} lifecycle operations may be applied at once"),
        ));
    }

    // Component mutation commands are serialized within this app process so
    // two windows cannot both pass the same source hash and overwrite each
    // other. External tools are covered by the hash re-check immediately
    // before each rename below.
    let mutation_lock = COMPONENT_MUTATION_LOCK.get_or_init(|| Mutex::new(()));
    let _mutation_guard = mutation_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let project_root = canonicalize_tagged(project_root, "component_mutation_project")?;
    if plan.expected_revision.is_empty() {
        return Err(validation(
            "expectedRevision",
            "a component mutation source revision is required",
        ));
    }
    let current_snapshot = snapshot_for_root(&project_root)?;
    if current_snapshot.revision != plan.expected_revision {
        return Err(validation(
            "expectedRevision",
            "the project source graph changed; refresh the component catalog and retry",
        ));
    }
    let expected_graph_delta = graph_guard::validate_plan_protocol(plan)?;
    if expected_graph_delta.is_some() && current_snapshot.partial {
        return Err(validation(
            "expectedGraphDelta",
            "a partial source snapshot cannot safely validate a component graph change",
        ));
    }
    let workspace = active_workspace_for_root(&project_root)?;
    if has_lifecycle_operations {
        if !plan.files.is_empty() {
            return Err(validation(
                "operations",
                "lifecycle operations cannot be mixed with legacy edit files",
            ));
        }
        return apply_lifecycle_operations(
            &project_root,
            &workspace,
            &current_snapshot,
            plan,
            expected_graph_delta,
        );
    }
    let prepared = prepare_files(
        &project_root,
        &workspace,
        &current_snapshot.files,
        &plan.files,
    )?;
    if let Some(delta) = expected_graph_delta {
        let after_files = snapshot_after_prepared(&current_snapshot.files, &prepared)?;
        graph_guard::validate_expected_graph_delta(&current_snapshot.files, &after_files, delta)?;
    }
    let mut staged = stage_files(&project_root, &prepared)?;

    if let Err(error) = create_backups(&project_root, &mut staged) {
        cleanup_staged(&staged);
        return Err(error);
    }

    // The initial reads happen before any temp file is created. Re-read each
    // target after all staging and backup I/O as a last pre-commit guard.
    if let Err(error) = verify_unchanged(&project_root, &staged) {
        cleanup_staged(&staged);
        return Err(error);
    }
    let before_commit_revision = match snapshot_for_root(&project_root) {
        Ok(snapshot) => snapshot.revision,
        Err(error) => {
            cleanup_staged(&staged);
            return Err(error);
        }
    };
    if before_commit_revision != plan.expected_revision {
        cleanup_staged(&staged);
        return Err(validation(
            "expectedRevision",
            "the project source graph changed before commit; refresh and retry",
        ));
    }

    let mut replaced = 0_usize;
    while replaced < staged.len() {
        if let Err(error) = verify_entry_unchanged(&project_root, &staged[replaced]) {
            return Err(fail_commit(&project_root, &mut staged, replaced, error));
        }
        if let Err(error) = replace_staged(
            &project_root,
            &staged[replaced].prepared.relative,
            &staged[replaced].staged_path,
            staged[replaced].path(),
        ) {
            // Include the current index for platforms whose replace fallback
            // removes the target before discovering a second rename error.
            let primary = CommandError::Io {
                message: format!("could not commit component source mutation: {error}"),
            };
            return Err(fail_commit(
                &project_root,
                &mut staged,
                replaced.saturating_add(1),
                primary,
            ));
        }
        replaced += 1;
    }

    for entry in &staged {
        if let Err(error) = unlink_in_parent(&entry.backup_path) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!(
                    file = %entry.prepared.relative,
                    error = %error,
                    "component mutation committed but backup cleanup failed"
                );
            }
        }
    }
    cleanup_staged(&staged);

    let mut changed_files: Vec<String> = staged
        .into_iter()
        .map(|entry| entry.prepared.relative)
        .collect();
    changed_files.sort();
    Ok(ComponentMutationResult { changed_files })
}

fn apply_lifecycle_operations(
    project_root: &Path,
    workspace: &Path,
    current_snapshot: &ComponentSourceSnapshot,
    plan: &ComponentMutationPlan,
    expected_graph_delta: Option<&super::types::ComponentGraphDelta>,
) -> Result<ComponentMutationResult, CommandError> {
    let operations = plan.operations.as_deref().ok_or_else(|| {
        validation(
            "operations",
            "a lifecycle mutation must include at least one operation",
        )
    })?;
    let prepared =
        prepare_lifecycle_operations(project_root, workspace, &current_snapshot.files, operations)?;
    if let Some(delta) = expected_graph_delta {
        let after_files = snapshot_after_lifecycle_operations(&current_snapshot.files, &prepared)?;
        graph_guard::validate_expected_graph_delta(&current_snapshot.files, &after_files, delta)?;
    }
    let mut staged = stage_lifecycle_targets(project_root, &prepared)?;
    if let Err(error) = create_lifecycle_backups(project_root, &mut staged) {
        cleanup_lifecycle_staged(&staged);
        return Err(error);
    }

    if let Err(error) = verify_lifecycle_unchanged(project_root, &staged) {
        cleanup_lifecycle_staged(&staged);
        return Err(error);
    }
    let before_commit_revision = match snapshot_for_root(project_root) {
        Ok(snapshot) => snapshot.revision,
        Err(error) => {
            cleanup_lifecycle_staged(&staged);
            return Err(error);
        }
    };
    if before_commit_revision != plan.expected_revision {
        cleanup_lifecycle_staged(&staged);
        return Err(validation(
            "expectedRevision",
            "the project source graph changed before the lifecycle mutation could commit; refresh and retry",
        ));
    }

    let mut committed = 0_usize;
    while committed < staged.len() {
        if let Err(error) = verify_lifecycle_entry_unchanged(project_root, &staged[committed]) {
            return Err(fail_lifecycle_commit(
                project_root,
                &mut staged,
                committed,
                error,
            ));
        }
        if let Err(error) = apply_lifecycle_target(project_root, &staged[committed]) {
            let primary = CommandError::Io {
                message: format!("could not commit component lifecycle mutation: {error}"),
            };
            return Err(fail_lifecycle_commit(
                project_root,
                &mut staged,
                committed.saturating_add(1),
                primary,
            ));
        }
        committed += 1;
    }

    for entry in &staged {
        if !entry.backup_path.as_os_str().is_empty() {
            if let Err(error) = unlink_in_parent(&entry.backup_path) {
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(
                        file = %entry.prepared.relative,
                        error = %error,
                        "component lifecycle mutation committed but backup cleanup failed"
                    );
                }
            }
        }
    }
    let mut changed_files: Vec<String> = staged
        .iter()
        .map(|entry| entry.prepared.relative.clone())
        .collect();
    cleanup_lifecycle_staged(&staged);
    changed_files.sort();
    Ok(ComponentMutationResult { changed_files })
}

fn prepare_lifecycle_operations(
    project_root: &Path,
    workspace: &Path,
    tracked_files: &[SourceFileSnapshot],
    operations: &[ComponentFileOperation],
) -> Result<Vec<PreparedLifecycleTarget>, CommandError> {
    let mut prepared = Vec::with_capacity(operations.len());
    let mut seen = std::collections::HashSet::with_capacity(operations.len());
    let mut total_inserted = 0_u64;
    let mut total_source_bytes = 0_u64;
    let mut total_result_bytes = 0_u64;

    for operation in operations {
        match operation {
            ComponentFileOperation::Edit { mutation } => {
                reserve_lifecycle_path(&mut seen, &mutation.file)?;
                if mutation.expected_hash.is_empty() || mutation.expected_result_hash.is_empty() {
                    return Err(validation(
                        "operations",
                        format!("mutation hashes are required for '{}'", mutation.file),
                    ));
                }
                if mutation.edits.is_empty() {
                    return Err(validation(
                        "edits",
                        format!("mutation '{}' has no edits", mutation.file),
                    ));
                }
                if mutation.edits.len() > MAX_MUTATION_EDITS_PER_FILE {
                    return Err(validation(
                        "edits",
                        format!(
                            "mutation '{}' has too many edits (maximum {})",
                            mutation.file, MAX_MUTATION_EDITS_PER_FILE
                        ),
                    ));
                }
                let (path, original, permissions) = read_lifecycle_source(
                    project_root,
                    workspace,
                    tracked_files,
                    &mutation.file,
                    &mutation.expected_hash,
                )?;
                add_lifecycle_bytes(
                    &mut total_source_bytes,
                    original.len(),
                    MAX_MUTATION_SOURCE_TOTAL_BYTES,
                    "operations",
                    format!(
                        "lifecycle source files exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                    ),
                )?;
                let source = String::from_utf8(original.clone()).map_err(|_| {
                    validation(
                        "file",
                        format!("source file '{}' is not valid UTF-8", mutation.file),
                    )
                })?;
                let inserted_bytes = mutation
                    .edits
                    .iter()
                    .map(|edit| edit.text.len())
                    .try_fold(0_usize, |total, length| total.checked_add(length))
                    .ok_or_else(|| validation("edits", "replacement text size overflowed"))?;
                add_lifecycle_bytes(
                    &mut total_inserted,
                    inserted_bytes,
                    MAX_MUTATION_INSERTED_BYTES as u64,
                    "edits",
                    format!(
                        "replacement text exceeds the {MAX_MUTATION_INSERTED_BYTES}-byte limit"
                    ),
                )?;
                let updated = apply_text_edits(&source, &mutation.edits)?.into_bytes();
                if content_hash(&updated) != mutation.expected_result_hash {
                    return Err(validation(
                        "expectedResultHash",
                        format!(
                            "planned result hash does not match mutation file '{}'",
                            mutation.file
                        ),
                    ));
                }
                if updated.len() as u64 > MAX_MUTATION_SOURCE_FILE_BYTES {
                    return Err(validation(
                        "edits",
                        format!(
                            "mutation result for '{}' exceeds the {MAX_MUTATION_SOURCE_FILE_BYTES}-byte source limit",
                            mutation.file
                        ),
                    ));
                }
                add_lifecycle_bytes(
                    &mut total_result_bytes,
                    updated.len(),
                    MAX_MUTATION_SOURCE_TOTAL_BYTES,
                    "operations",
                    format!(
                        "lifecycle mutation results exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                    ),
                )?;
                prepared.push(PreparedLifecycleTarget {
                    relative: mutation.file.clone(),
                    path,
                    original: Some(original),
                    updated: Some(updated),
                    permissions,
                });
            }
            ComponentFileOperation::Create {
                file,
                expected_absent,
                contents,
                expected_result_hash,
            } => {
                reserve_lifecycle_path(&mut seen, file)?;
                if !expected_absent {
                    return Err(validation(
                        "expectedAbsent",
                        format!("create operation for '{file}' must require an absent destination"),
                    ));
                }
                if tracked_files
                    .iter()
                    .any(|candidate| candidate.file == *file)
                {
                    return Err(validation(
                        "file",
                        format!("create destination '{file}' is already in the source snapshot"),
                    ));
                }
                let (path, permissions) =
                    prepare_lifecycle_destination(project_root, workspace, file)?;
                if contents.len() as u64 > MAX_MUTATION_SOURCE_FILE_BYTES {
                    return Err(validation(
                        "contents",
                        format!("create contents for '{file}' exceed the source file limit"),
                    ));
                }
                let updated = contents.as_bytes().to_vec();
                let actual_hash = content_hash(&updated);
                if let Some(expected_hash) = expected_result_hash {
                    if expected_hash.is_empty() || expected_hash != &actual_hash {
                        return Err(validation(
                            "expectedResultHash",
                            format!("planned create hash does not match '{file}'"),
                        ));
                    }
                }
                add_lifecycle_bytes(
                    &mut total_result_bytes,
                    updated.len(),
                    MAX_MUTATION_SOURCE_TOTAL_BYTES,
                    "operations",
                    format!(
                        "lifecycle mutation results exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                    ),
                )?;
                prepared.push(PreparedLifecycleTarget {
                    relative: file.clone(),
                    path,
                    original: None,
                    updated: Some(updated),
                    permissions,
                });
            }
            ComponentFileOperation::Move {
                from,
                to,
                expected_hash,
                expected_absent,
                expected_result_hash,
            } => {
                if from == to {
                    return Err(validation(
                        "operations",
                        format!("move operation for '{from}' must have different source and destination paths"),
                    ));
                }
                reserve_lifecycle_path(&mut seen, from)?;
                reserve_lifecycle_path(&mut seen, to)?;
                if !expected_absent {
                    return Err(validation(
                        "expectedAbsent",
                        format!("move destination '{to}' must require an absent destination"),
                    ));
                }
                let (from_path, original, source_permissions) = read_lifecycle_source(
                    project_root,
                    workspace,
                    tracked_files,
                    from,
                    expected_hash,
                )?;
                if tracked_files.iter().any(|candidate| candidate.file == *to) {
                    return Err(validation(
                        "file",
                        format!("move destination '{to}' is already in the source snapshot"),
                    ));
                }
                let (to_path, _) = prepare_lifecycle_destination(project_root, workspace, to)?;
                let actual_hash = content_hash(&original);
                if let Some(expected_result_hash) = expected_result_hash {
                    if expected_result_hash.is_empty() || expected_result_hash != &actual_hash {
                        return Err(validation(
                            "expectedResultHash",
                            format!("planned move hash does not match '{to}'"),
                        ));
                    }
                }
                add_lifecycle_bytes(
                    &mut total_source_bytes,
                    original.len(),
                    MAX_MUTATION_SOURCE_TOTAL_BYTES,
                    "operations",
                    format!(
                        "lifecycle source files exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                    ),
                )?;
                add_lifecycle_bytes(
                    &mut total_result_bytes,
                    original.len(),
                    MAX_MUTATION_SOURCE_TOTAL_BYTES,
                    "operations",
                    format!(
                        "lifecycle mutation results exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                    ),
                )?;
                prepared.push(PreparedLifecycleTarget {
                    relative: from.clone(),
                    path: from_path,
                    original: Some(original.clone()),
                    updated: None,
                    permissions: source_permissions.clone(),
                });
                prepared.push(PreparedLifecycleTarget {
                    relative: to.clone(),
                    path: to_path,
                    original: None,
                    updated: Some(original),
                    permissions: source_permissions,
                });
            }
            ComponentFileOperation::Delete {
                file,
                expected_hash,
            } => {
                reserve_lifecycle_path(&mut seen, file)?;
                let (path, original, permissions) = read_lifecycle_source(
                    project_root,
                    workspace,
                    tracked_files,
                    file,
                    expected_hash,
                )?;
                add_lifecycle_bytes(
                    &mut total_source_bytes,
                    original.len(),
                    MAX_MUTATION_SOURCE_TOTAL_BYTES,
                    "operations",
                    format!(
                        "lifecycle source files exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                    ),
                )?;
                prepared.push(PreparedLifecycleTarget {
                    relative: file.clone(),
                    path,
                    original: Some(original),
                    updated: None,
                    permissions,
                });
            }
        }
    }

    if prepared.len() > MAX_MUTATION_FILES.saturating_mul(2) {
        return Err(validation(
            "operations",
            format!(
                "lifecycle operations may address at most {} source paths",
                MAX_MUTATION_FILES.saturating_mul(2)
            ),
        ));
    }
    prepared.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(prepared)
}

fn reserve_lifecycle_path(
    seen: &mut std::collections::HashSet<String>,
    relative: &str,
) -> Result<(), CommandError> {
    validate_relative_source_path(relative)
        .map_err(|error| validation("file", format!("{relative}: {error}")))?;
    if !seen.insert(relative.to_ascii_lowercase()) {
        return Err(validation(
            "operations",
            format!("duplicate lifecycle path '{relative}'"),
        ));
    }
    Ok(())
}

fn read_lifecycle_source(
    project_root: &Path,
    workspace: &Path,
    tracked_files: &[SourceFileSnapshot],
    relative: &str,
    expected_hash: &str,
) -> Result<(PathBuf, Vec<u8>, Permissions), CommandError> {
    if expected_hash.is_empty() {
        return Err(validation(
            "expectedHash",
            format!("a source hash is required for '{relative}'"),
        ));
    }
    if !tracked_files.iter().any(|file| file.file == relative) {
        return Err(validation(
            "file",
            format!("source file '{relative}' is not in the active source snapshot"),
        ));
    }
    let path = validated_existing_path(project_root, relative)?;
    if !path.starts_with(workspace) {
        return Err(validation(
            "file",
            format!("source file '{relative}' is outside the active workspace"),
        ));
    }
    let metadata =
        fs::metadata(&path).map_err(|error| error_for_file("inspect", relative, error))?;
    if metadata.len() > MAX_MUTATION_SOURCE_FILE_BYTES {
        return Err(validation(
            "file",
            format!(
                "source file '{relative}' exceeds the {MAX_MUTATION_SOURCE_FILE_BYTES}-byte source limit"
            ),
        ));
    }
    let original = read_bounded(&path, MAX_MUTATION_SOURCE_FILE_BYTES)
        .map_err(|error| error_for_file("read", relative, error))?;
    if content_hash(&original) != expected_hash {
        return Err(validation(
            "expectedHash",
            format!("source file '{relative}' changed; refresh and retry"),
        ));
    }
    Ok((path, original, metadata.permissions()))
}

fn prepare_lifecycle_destination(
    project_root: &Path,
    workspace: &Path,
    relative: &str,
) -> Result<(PathBuf, Permissions), CommandError> {
    let path = validated_new_path(project_root, relative)?;
    let parent = path.parent().ok_or_else(|| {
        validation(
            "file",
            format!("lifecycle destination '{relative}' has no parent directory"),
        )
    })?;
    let canonical_parent = canonicalize_tagged(parent, "component_lifecycle_parent")?;
    if !canonical_parent.starts_with(workspace) {
        return Err(validation(
            "file",
            format!("lifecycle destination '{relative}' is outside the active workspace"),
        ));
    }
    let metadata =
        fs::metadata(parent).map_err(|error| error_for_file("inspect", relative, error))?;
    if !metadata.is_dir() {
        return Err(validation(
            "file",
            format!("lifecycle destination parent for '{relative}' is not a directory"),
        ));
    }
    Ok((path, metadata.permissions()))
}

fn add_lifecycle_bytes(
    total: &mut u64,
    amount: usize,
    limit: u64,
    field: &str,
    limit_reason: String,
) -> Result<(), CommandError> {
    *total = total
        .checked_add(amount as u64)
        .ok_or_else(|| validation(field, format!("{field} size overflowed")))?;
    if *total > limit {
        return Err(validation(field, limit_reason));
    }
    Ok(())
}

fn snapshot_after_lifecycle_operations(
    files: &[SourceFileSnapshot],
    prepared: &[PreparedLifecycleTarget],
) -> Result<Vec<SourceFileSnapshot>, CommandError> {
    let mut after = files.to_vec();
    for entry in prepared {
        match &entry.updated {
            Some(updated) => {
                let content = String::from_utf8(updated.clone()).map_err(|_| {
                    validation(
                        "expectedGraphDelta",
                        format!(
                            "lifecycle result for '{}' is not valid UTF-8",
                            entry.relative
                        ),
                    )
                })?;
                if let Some(file) = after.iter_mut().find(|file| file.file == entry.relative) {
                    file.content = content;
                    file.content_hash = content_hash(updated);
                } else {
                    after.push(SourceFileSnapshot {
                        file: entry.relative.clone(),
                        content,
                        content_hash: content_hash(updated),
                    });
                }
            }
            None => {
                let index = after
                    .iter()
                    .position(|file| file.file == entry.relative)
                    .ok_or_else(|| {
                        validation(
                            "expectedGraphDelta",
                            format!(
                                "lifecycle delete path '{}' disappeared from the source snapshot",
                                entry.relative
                            ),
                        )
                    })?;
                after.remove(index);
            }
        }
    }
    after.sort_by(|left, right| left.file.cmp(&right.file));
    Ok(after)
}

fn stage_lifecycle_targets(
    project_root: &Path,
    prepared: &[PreparedLifecycleTarget],
) -> Result<Vec<StagedLifecycleTarget>, CommandError> {
    let mut staged = Vec::with_capacity(prepared.len());
    for file in prepared {
        let staged_path = match &file.updated {
            Some(updated) => {
                match write_sibling_temp(
                    project_root,
                    &file.path,
                    "component-staged",
                    updated,
                    &file.permissions,
                ) {
                    Ok(path) => path,
                    Err(error) => {
                        cleanup_lifecycle_staged(&staged);
                        return Err(error_for_file("stage", &file.relative, error));
                    }
                }
            }
            None => PathBuf::new(),
        };
        staged.push(StagedLifecycleTarget {
            prepared: PreparedLifecycleTarget {
                relative: file.relative.clone(),
                path: file.path.clone(),
                original: file.original.clone(),
                updated: file.updated.clone(),
                permissions: file.permissions.clone(),
            },
            staged_path,
            backup_path: PathBuf::new(),
        });
    }
    Ok(staged)
}

fn create_lifecycle_backups(
    project_root: &Path,
    staged: &mut [StagedLifecycleTarget],
) -> Result<(), CommandError> {
    for entry in staged.iter_mut() {
        let Some(original) = &entry.prepared.original else {
            continue;
        };
        match write_sibling_temp(
            project_root,
            &entry.prepared.path,
            "component-backup",
            original,
            &entry.prepared.permissions,
        ) {
            Ok(path) => entry.backup_path = path,
            Err(error) => return Err(error_for_file("backup", &entry.prepared.relative, error)),
        }
    }
    Ok(())
}

fn verify_lifecycle_unchanged(
    project_root: &Path,
    staged: &[StagedLifecycleTarget],
) -> Result<(), CommandError> {
    for entry in staged {
        verify_lifecycle_entry_unchanged(project_root, entry)?;
    }
    Ok(())
}

fn verify_lifecycle_entry_unchanged(
    project_root: &Path,
    entry: &StagedLifecycleTarget,
) -> Result<(), CommandError> {
    match &entry.prepared.original {
        Some(original) => {
            let path = validated_existing_path(project_root, &entry.prepared.relative)?;
            let current = read_bounded(&path, MAX_MUTATION_SOURCE_FILE_BYTES)
                .map_err(|error| error_for_file("re-read", &entry.prepared.relative, error))?;
            if content_hash(&current) != content_hash(original) {
                return Err(validation(
                    "expectedHash",
                    format!(
                        "source file '{}' changed before commit; refresh and retry",
                        entry.prepared.relative
                    ),
                ));
            }
        }
        None => {
            validated_new_path(project_root, &entry.prepared.relative)?;
        }
    }
    Ok(())
}

fn apply_lifecycle_target(
    project_root: &Path,
    entry: &StagedLifecycleTarget,
) -> Result<(), io::Error> {
    match (&entry.prepared.original, &entry.prepared.updated) {
        (Some(_), Some(_)) => replace_staged(
            project_root,
            &entry.prepared.relative,
            &entry.staged_path,
            &entry.prepared.path,
        ),
        (None, Some(_)) => {
            // hard_link gives a create target an atomic no-overwrite commit;
            // the sibling temp remains available for rollback until the link
            // has been made successfully.
            ensure_safe_commit_target(
                project_root,
                &entry.prepared.relative,
                &entry.prepared.path,
                CommitTargetExpectation::Absent,
            )?;
            link_sibling_nofollow(&entry.staged_path, &entry.prepared.path)
        }
        (Some(_), None) => {
            remove_lifecycle_target(project_root, &entry.prepared.relative, &entry.prepared.path)
        }
        (None, None) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a lifecycle target must have an original or updated value",
        )),
    }
}

fn remove_lifecycle_target(
    project_root: &Path,
    relative: &str,
    target: &Path,
) -> Result<(), io::Error> {
    ensure_safe_commit_target(
        project_root,
        relative,
        target,
        CommitTargetExpectation::Existing,
    )?;
    #[cfg(windows)]
    {
        let mut permissions = fs::metadata(target)?.permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(target, permissions);
    }
    remove_target_nofollow(target)
}

fn lifecycle_target_state(
    entry: &StagedLifecycleTarget,
) -> Result<LifecycleTargetState, io::Error> {
    let current = match read_bounded(&entry.prepared.path, MAX_MUTATION_SOURCE_FILE_BYTES) {
        Ok(current) => current,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LifecycleTargetState::Missing);
        }
        Err(error) => return Err(error),
    };
    let current_hash = content_hash(&current);
    if entry
        .prepared
        .original
        .as_ref()
        .is_some_and(|original| current_hash == content_hash(original))
    {
        Ok(LifecycleTargetState::Original)
    } else if entry
        .prepared
        .updated
        .as_ref()
        .is_some_and(|updated| current_hash == content_hash(updated))
    {
        Ok(LifecycleTargetState::Updated)
    } else {
        Ok(LifecycleTargetState::Changed)
    }
}

fn rollback_lifecycle(
    project_root: &Path,
    staged: &mut [StagedLifecycleTarget],
    attempted: usize,
) -> Vec<RollbackFailure> {
    let mut failures = Vec::new();
    for entry in staged.iter_mut().take(attempted).rev() {
        let state = match lifecycle_target_state(entry) {
            Ok(state) => state,
            Err(error) => {
                tracing::error!(
                    file = %entry.prepared.relative,
                    error = %error,
                    "component lifecycle rollback could not verify the target"
                );
                failures.push(RollbackFailure {
                    relative: entry.prepared.relative.clone(),
                    retained_backup: (!entry.backup_path.as_os_str().is_empty())
                        .then(|| entry.backup_path.clone()),
                });
                continue;
            }
        };

        match entry.prepared.original.as_ref() {
            Some(_) => match state {
                LifecycleTargetState::Original => continue,
                LifecycleTargetState::Changed => {
                    tracing::error!(
                        file = %entry.prepared.relative,
                        "component lifecycle rollback skipped because the target changed after commit"
                    );
                    failures.push(RollbackFailure {
                        relative: entry.prepared.relative.clone(),
                        retained_backup: (!entry.backup_path.as_os_str().is_empty())
                            .then(|| entry.backup_path.clone()),
                    });
                    continue;
                }
                LifecycleTargetState::Updated | LifecycleTargetState::Missing => {
                    if entry.backup_path.as_os_str().is_empty() || !entry.backup_path.exists() {
                        failures.push(RollbackFailure {
                            relative: entry.prepared.relative.clone(),
                            retained_backup: None,
                        });
                        continue;
                    }
                    if let Err(error) = restore_backup(
                        project_root,
                        &entry.prepared.relative,
                        &entry.backup_path,
                        &entry.prepared.path,
                    ) {
                        tracing::error!(
                            file = %entry.prepared.relative,
                            error = %error,
                            "component lifecycle rollback failed"
                        );
                        failures.push(RollbackFailure {
                            relative: entry.prepared.relative.clone(),
                            retained_backup: Some(entry.backup_path.clone()),
                        });
                    }
                }
            },
            None => match state {
                LifecycleTargetState::Missing => continue,
                LifecycleTargetState::Updated => {
                    if let Err(error) = remove_lifecycle_target(
                        project_root,
                        &entry.prepared.relative,
                        &entry.prepared.path,
                    ) {
                        tracing::error!(
                            file = %entry.prepared.relative,
                            error = %error,
                            "component lifecycle rollback could not remove a created target"
                        );
                        failures.push(RollbackFailure {
                            relative: entry.prepared.relative.clone(),
                            retained_backup: None,
                        });
                    }
                }
                LifecycleTargetState::Original | LifecycleTargetState::Changed => {
                    tracing::error!(
                        file = %entry.prepared.relative,
                        "component lifecycle rollback skipped because a created target changed after commit"
                    );
                    failures.push(RollbackFailure {
                        relative: entry.prepared.relative.clone(),
                        retained_backup: None,
                    });
                }
            },
        }
    }
    failures
}

fn fail_lifecycle_commit(
    project_root: &Path,
    staged: &mut [StagedLifecycleTarget],
    attempted: usize,
    primary: CommandError,
) -> CommandError {
    let failures = rollback_lifecycle(project_root, staged, attempted);
    cleanup_lifecycle_staged_preserving_backups(staged, &failures);
    if failures.is_empty() {
        return primary;
    }
    let files = failures
        .iter()
        .map(|failure| failure.relative.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let retained = failures
        .iter()
        .any(|failure| failure.retained_backup.is_some());
    CommandError::Io {
        message: format!(
            "{primary}; rollback was incomplete for {files}.{}",
            if retained {
                " Recovery backups were retained beside the affected source files."
            } else {
                " No recovery backup remained for at least one affected file."
            }
        ),
    }
}

fn cleanup_lifecycle_staged_preserving_backups(
    staged: &[StagedLifecycleTarget],
    failures: &[RollbackFailure],
) {
    let retained: std::collections::HashSet<&Path> = failures
        .iter()
        .filter_map(|failure| failure.retained_backup.as_deref())
        .collect();
    for entry in staged {
        if !entry.staged_path.as_os_str().is_empty() {
            let _ = unlink_in_parent(&entry.staged_path);
        }
        if !entry.backup_path.as_os_str().is_empty()
            && !retained.contains(entry.backup_path.as_path())
        {
            let _ = unlink_in_parent(&entry.backup_path);
        }
    }
}

fn cleanup_lifecycle_staged(staged: &[StagedLifecycleTarget]) {
    for entry in staged {
        for path in [&entry.staged_path, &entry.backup_path] {
            if path.as_os_str().is_empty() {
                continue;
            }
            let _ = unlink_in_parent(path);
        }
    }
}

impl StagedFile {
    fn path(&self) -> &Path {
        &self.prepared.path
    }
}

fn snapshot_after_prepared(
    files: &[SourceFileSnapshot],
    prepared: &[PreparedFile],
) -> Result<Vec<SourceFileSnapshot>, CommandError> {
    let mut after = files.to_vec();
    for entry in prepared {
        let file = after
            .iter_mut()
            .find(|file| file.file == entry.relative)
            .ok_or_else(|| {
                validation(
                    "expectedGraphDelta",
                    format!(
                        "mutation file '{}' disappeared from the source snapshot",
                        entry.relative
                    ),
                )
            })?;
        file.content = String::from_utf8(entry.updated.clone()).map_err(|_| {
            validation(
                "expectedGraphDelta",
                format!(
                    "mutation result for '{}' is not valid UTF-8",
                    entry.relative
                ),
            )
        })?;
        file.content_hash = content_hash(&entry.updated);
    }
    Ok(after)
}

fn prepare_files(
    project_root: &Path,
    workspace: &Path,
    tracked_files: &[SourceFileSnapshot],
    mutations: &[ComponentFileMutation],
) -> Result<Vec<PreparedFile>, CommandError> {
    let mut prepared = Vec::with_capacity(mutations.len());
    let mut seen = std::collections::HashSet::with_capacity(mutations.len());
    let mut total_inserted = 0_usize;
    let mut total_source_bytes = 0_u64;
    let mut total_result_bytes = 0_u64;

    for mutation in mutations {
        validate_relative_source_path(&mutation.file)
            .map_err(|error| validation("file", format!("{}: {error}", mutation.file)))?;
        if !seen.insert(mutation.file.as_str()) {
            return Err(validation(
                "files",
                format!("duplicate mutation path '{}'", mutation.file),
            ));
        }
        if mutation.expected_hash.is_empty() || mutation.expected_result_hash.is_empty() {
            return Err(validation(
                "files",
                format!("mutation hashes are required for '{}'", mutation.file),
            ));
        }
        if mutation.edits.is_empty() {
            return Err(validation(
                "edits",
                format!("mutation '{}' has no edits", mutation.file),
            ));
        }
        if mutation.edits.len() > MAX_MUTATION_EDITS_PER_FILE {
            return Err(validation(
                "edits",
                format!(
                    "mutation '{}' has too many edits (maximum {})",
                    mutation.file, MAX_MUTATION_EDITS_PER_FILE
                ),
            ));
        }
        let path = validated_existing_path(project_root, &mutation.file)?;
        let canonical = canonicalize_tagged(&path, "component_mutation_file")?;
        if !canonical.starts_with(workspace) {
            return Err(validation(
                "file",
                format!(
                    "mutation file '{}' is outside the active workspace",
                    mutation.file
                ),
            ));
        }
        if !tracked_files.iter().any(|file| file.file == mutation.file) {
            return Err(validation(
                "file",
                format!(
                    "mutation file '{}' is not in the active source snapshot",
                    mutation.file
                ),
            ));
        }
        let metadata = fs::metadata(&path).map_err(|error| CommandError::Io {
            message: format!(
                "could not inspect mutation file '{}': {error}",
                mutation.file
            ),
        })?;
        if metadata.len() > MAX_MUTATION_SOURCE_FILE_BYTES {
            return Err(validation(
                "file",
                format!(
                    "mutation file '{}' exceeds the {MAX_MUTATION_SOURCE_FILE_BYTES}-byte source limit",
                    mutation.file
                ),
            ));
        }
        let original = read_bounded(&path, MAX_MUTATION_SOURCE_FILE_BYTES).map_err(|error| {
            CommandError::Io {
                message: format!("could not read mutation file '{}': {error}", mutation.file),
            }
        })?;
        total_source_bytes = total_source_bytes
            .checked_add(original.len() as u64)
            .ok_or_else(|| validation("files", "mutation source size overflowed"))?;
        if total_source_bytes > MAX_MUTATION_SOURCE_TOTAL_BYTES {
            return Err(validation(
                "files",
                format!(
                    "mutation sources exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                ),
            ));
        }
        let actual_hash = content_hash(&original);
        if actual_hash != mutation.expected_hash {
            return Err(validation(
                "expectedHash",
                format!("source file '{}' changed; refresh and retry", mutation.file),
            ));
        }
        let source = String::from_utf8(original.clone()).map_err(|_| {
            validation(
                "file",
                format!("source file '{}' is not valid UTF-8", mutation.file),
            )
        })?;
        let inserted_bytes = mutation
            .edits
            .iter()
            .map(|edit| edit.text.len())
            .try_fold(0_usize, |total, length| total.checked_add(length))
            .ok_or_else(|| validation("edits", "replacement text size overflowed"))?;
        total_inserted = total_inserted
            .checked_add(inserted_bytes)
            .ok_or_else(|| validation("edits", "replacement text size overflowed"))?;
        if total_inserted > MAX_MUTATION_INSERTED_BYTES {
            return Err(validation(
                "edits",
                format!("replacement text exceeds the {MAX_MUTATION_INSERTED_BYTES}-byte limit"),
            ));
        }
        let updated = apply_text_edits(&source, &mutation.edits)?;
        let result_hash = content_hash(updated.as_bytes());
        if result_hash != mutation.expected_result_hash {
            return Err(validation(
                "expectedResultHash",
                format!(
                    "planned result hash does not match mutation file '{}'",
                    mutation.file
                ),
            ));
        }
        if updated.len() as u64 > MAX_MUTATION_SOURCE_FILE_BYTES {
            return Err(validation(
                "edits",
                format!(
                    "mutation result for '{}' exceeds the {MAX_MUTATION_SOURCE_FILE_BYTES}-byte source limit",
                    mutation.file
                ),
            ));
        }
        total_result_bytes = total_result_bytes
            .checked_add(updated.len() as u64)
            .ok_or_else(|| validation("files", "mutation result size overflowed"))?;
        if total_result_bytes > MAX_MUTATION_SOURCE_TOTAL_BYTES {
            return Err(validation(
                "files",
                format!(
                    "mutation results exceed the {MAX_MUTATION_SOURCE_TOTAL_BYTES}-byte total limit"
                ),
            ));
        }

        prepared.push(PreparedFile {
            relative: mutation.file.clone(),
            path,
            original,
            updated: updated.into_bytes(),
            permissions: metadata.permissions(),
        });
    }

    prepared.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(prepared)
}

fn apply_text_edits(source: &str, edits: &[ComponentTextEdit]) -> Result<String, CommandError> {
    let mut previous_start = None;
    let mut previous_end = 0_usize;
    for (index, edit) in edits.iter().enumerate() {
        if edit.start > edit.end || edit.end > source.len() {
            return Err(validation(
                "edits",
                format!("edit {index} is outside the source byte range"),
            ));
        }
        if !source.is_char_boundary(edit.start) || !source.is_char_boundary(edit.end) {
            return Err(validation(
                "edits",
                format!("edit {index} does not align to UTF-8 character boundaries"),
            ));
        }
        if let Some(start) = previous_start {
            if edit.start < start || edit.start < previous_end {
                return Err(validation(
                    "edits",
                    format!("edit {index} overlaps or is out of order"),
                ));
            }
            // Two insertions at one byte offset have no canonical ordering and
            // are rejected even though their zero-width ranges do not overlap.
            if edit.start == start {
                return Err(validation(
                    "edits",
                    format!("edit {index} shares a start offset with another edit"),
                ));
            }
        }
        previous_start = Some(edit.start);
        previous_end = edit.end;
    }

    let mut updated = source.to_string();
    for edit in edits.iter().rev() {
        updated.replace_range(edit.start..edit.end, &edit.text);
    }
    Ok(updated)
}

fn stage_files(
    project_root: &Path,
    prepared: &[PreparedFile],
) -> Result<Vec<StagedFile>, CommandError> {
    let mut staged = Vec::with_capacity(prepared.len());
    for file in prepared {
        let staged_path = match write_sibling_temp(
            project_root,
            &file.path,
            "component-staged",
            &file.updated,
            &file.permissions,
        ) {
            Ok(path) => path,
            Err(error) => {
                cleanup_staged(&staged);
                return Err(error_for_file("stage", &file.relative, error));
            }
        };
        staged.push(StagedFile {
            prepared: PreparedFile {
                relative: file.relative.clone(),
                path: file.path.clone(),
                original: file.original.clone(),
                updated: file.updated.clone(),
                permissions: file.permissions.clone(),
            },
            staged_path,
            backup_path: PathBuf::new(),
        });
    }
    Ok(staged)
}

fn create_backups(project_root: &Path, staged: &mut [StagedFile]) -> Result<(), CommandError> {
    for entry in staged.iter_mut() {
        match write_sibling_temp(
            project_root,
            &entry.prepared.path,
            "component-backup",
            &entry.prepared.original,
            &entry.prepared.permissions,
        ) {
            Ok(path) => entry.backup_path = path,
            Err(error) => return Err(error_for_file("backup", &entry.prepared.relative, error)),
        }
    }
    Ok(())
}

fn verify_unchanged(project_root: &Path, staged: &[StagedFile]) -> Result<(), CommandError> {
    for entry in staged {
        verify_entry_unchanged(project_root, entry)?;
    }
    Ok(())
}

fn verify_entry_unchanged(project_root: &Path, entry: &StagedFile) -> Result<(), CommandError> {
    ensure_safe_commit_target(
        project_root,
        &entry.prepared.relative,
        &entry.prepared.path,
        CommitTargetExpectation::Existing,
    )
    .map_err(|error| CommandError::Io {
        message: format!(
            "could not revalidate mutation file '{}': {error}",
            entry.prepared.relative
        ),
    })?;
    let current =
        read_bounded(&entry.prepared.path, MAX_MUTATION_SOURCE_FILE_BYTES).map_err(|error| {
            CommandError::Io {
                message: format!(
                    "could not re-read mutation file '{}': {error}",
                    entry.prepared.relative
                ),
            }
        })?;
    if content_hash(&current) != content_hash(&entry.prepared.original) {
        return Err(validation(
            "expectedHash",
            format!(
                "source file '{}' changed before commit; refresh and retry",
                entry.prepared.relative
            ),
        ));
    }
    Ok(())
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, io::Error> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024) as usize);
    open_read_nofollow(path)?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source exceeds the {max_bytes}-byte limit"),
        ));
    }
    Ok(bytes)
}

fn open_read_nofollow(path: &Path) -> Result<fs::File, io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        fs::File::open(path)
    }
}

#[derive(Debug, Clone, Copy)]
enum CommitTargetExpectation {
    Existing,
    Absent,
    Either,
}

fn ensure_safe_parent(project_root: &Path, parent: &Path) -> Result<(), io::Error> {
    let canonical_root = dunce::canonicalize(project_root)?;
    let canonical_parent = dunce::canonicalize(parent)?;
    if !canonical_parent.starts_with(&canonical_root)
        || super::inventory::path_contains_symlink(&canonical_root, parent)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "component mutation parent is outside the project or reached through a symlink",
        ));
    }
    Ok(())
}

fn ensure_safe_commit_target(
    project_root: &Path,
    relative: &str,
    target: &Path,
    expectation: CommitTargetExpectation,
) -> Result<(), io::Error> {
    validate_relative_source_path(relative).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid component mutation path '{relative}': {error}"),
        )
    })?;
    let candidate = project_root.join(relative);
    let parent = candidate
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    ensure_safe_parent(project_root, parent)?;

    match fs::symlink_metadata(&candidate) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("component mutation target '{relative}' is a symlink"),
        )),
        Ok(metadata) if !metadata.is_file() => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("component mutation target '{relative}' is not a regular file"),
        )),
        Ok(_) => {
            match expectation {
                CommitTargetExpectation::Absent => Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("component mutation target '{relative}' already exists"),
                )),
                CommitTargetExpectation::Existing | CommitTargetExpectation::Either => {
                    let canonical = dunce::canonicalize(&candidate)?;
                    if canonical != target {
                        return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!("component mutation target '{relative}' moved during the transaction"),
                    ));
                    }
                    Ok(())
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if matches!(expectation, CommitTargetExpectation::Existing) {
                Err(error)
            } else {
                Ok(())
            }
        }
        Err(error) => Err(error),
    }
}

fn ensure_regular_temp(path: &Path) -> Result<(), io::Error> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "component mutation temporary file is not a regular file",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn open_directory_nofollow(path: &Path) -> Result<fs::File, io::Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let flags = libc::O_NOFOLLOW | libc::O_CLOEXEC;
    #[cfg(target_os = "linux")]
    let flags = flags | libc::O_DIRECTORY;
    OpenOptions::new().read(true).custom_flags(flags).open(path)
}

#[cfg(unix)]
fn path_name(path: &Path) -> Result<CString, io::Error> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

#[cfg(unix)]
fn unlink_in_parent(path: &Path) -> Result<(), io::Error> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let directory = open_directory_nofollow(parent)?;
    let name = path_name(path)?;
    let result = unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn rename_in_parent(staged: &Path, target: &Path) -> Result<(), io::Error> {
    let staged_parent = staged
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "staged path has no parent"))?;
    let target_parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    if staged_parent != target_parent {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "component mutation files must be siblings",
        ));
    }
    let directory = open_directory_nofollow(target_parent)?;
    let staged_name = path_name(staged)?;
    let target_name = path_name(target)?;
    let result = unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            staged_name.as_ptr(),
            directory.as_raw_fd(),
            target_name.as_ptr(),
        )
    };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn link_in_parent(staged: &Path, target: &Path) -> Result<(), io::Error> {
    let staged_parent = staged
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "staged path has no parent"))?;
    let target_parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    if staged_parent != target_parent {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "component mutation files must be siblings",
        ));
    }
    let directory = open_directory_nofollow(target_parent)?;
    let staged_name = path_name(staged)?;
    let target_name = path_name(target)?;
    let result = unsafe {
        libc::linkat(
            directory.as_raw_fd(),
            staged_name.as_ptr(),
            directory.as_raw_fd(),
            target_name.as_ptr(),
            0,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { libc::unlinkat(directory.as_raw_fd(), staged_name.as_ptr(), 0) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn unlink_in_parent(path: &Path) -> Result<(), io::Error> {
    fs::remove_file(path)
}

#[cfg(not(unix))]
fn rename_in_parent(staged: &Path, target: &Path) -> Result<(), io::Error> {
    fs::rename(staged, target)
}

#[cfg(not(unix))]
fn link_in_parent(staged: &Path, target: &Path) -> Result<(), io::Error> {
    fs::hard_link(staged, target)?;
    fs::remove_file(staged)
}

fn remove_target_nofollow(target: &Path) -> Result<(), io::Error> {
    unlink_in_parent(target)
}

fn write_sibling_temp(
    project_root: &Path,
    target: &Path,
    purpose: &str,
    bytes: &[u8],
    permissions: &Permissions,
) -> Result<PathBuf, io::Error> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source");
    for _ in 0..8 {
        ensure_safe_parent(project_root, parent)?;
        let candidate = parent.join(format!(
            ".{name}.shipstudio-{purpose}-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let mut file = match open_sibling_temp(parent, &candidate) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.flush()) {
            let _ = unlink_in_parent(&candidate);
            return Err(error);
        }
        if let Err(error) = file.sync_all() {
            let _ = unlink_in_parent(&candidate);
            return Err(error);
        }
        if let Err(error) = file.set_permissions(permissions.clone()) {
            drop(file);
            let _ = unlink_in_parent(&candidate);
            return Err(error);
        }
        drop(file);
        return Ok(candidate);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique sibling temporary file",
    ))
}

fn replace_staged(
    project_root: &Path,
    relative: &str,
    staged: &Path,
    target: &Path,
) -> Result<(), io::Error> {
    ensure_safe_commit_target(
        project_root,
        relative,
        target,
        CommitTargetExpectation::Existing,
    )?;
    ensure_regular_temp(staged)?;
    rename_in_parent(staged, target)
}

fn link_sibling_nofollow(staged: &Path, target: &Path) -> Result<(), io::Error> {
    ensure_regular_temp(staged)?;
    link_in_parent(staged, target)
}

fn restore_backup(
    project_root: &Path,
    relative: &str,
    backup: &Path,
    target: &Path,
) -> Result<(), io::Error> {
    ensure_safe_commit_target(
        project_root,
        relative,
        target,
        CommitTargetExpectation::Either,
    )?;
    ensure_regular_temp(backup)?;
    rename_in_parent(backup, target)
}

#[cfg(unix)]
fn open_sibling_temp(parent: &Path, candidate: &Path) -> Result<fs::File, io::Error> {
    let directory = open_directory_nofollow(parent)?;
    let name = path_name(candidate)?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}

#[cfg(not(unix))]
fn open_sibling_temp(_parent: &Path, candidate: &Path) -> Result<fs::File, io::Error> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(candidate)
}

fn rollback_target_state(entry: &StagedFile) -> Result<RollbackTargetState, io::Error> {
    let current = match read_bounded(&entry.prepared.path, MAX_MUTATION_SOURCE_FILE_BYTES) {
        Ok(current) => current,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RollbackTargetState::Missing);
        }
        Err(error) => return Err(error),
    };
    let current_hash = content_hash(&current);
    if current_hash == content_hash(&entry.prepared.original) {
        Ok(RollbackTargetState::Original)
    } else if current_hash == content_hash(&entry.prepared.updated) {
        Ok(RollbackTargetState::Updated)
    } else {
        Ok(RollbackTargetState::Changed)
    }
}

fn rollback(
    project_root: &Path,
    staged: &mut [StagedFile],
    attempted: usize,
) -> Vec<RollbackFailure> {
    let mut failures = Vec::new();
    for entry in staged.iter_mut().take(attempted).rev() {
        if entry.backup_path.as_os_str().is_empty() || !entry.backup_path.exists() {
            failures.push(RollbackFailure {
                relative: entry.prepared.relative.clone(),
                retained_backup: None,
            });
            continue;
        }
        match rollback_target_state(entry) {
            Ok(RollbackTargetState::Original) => continue,
            Ok(RollbackTargetState::Changed) => {
                tracing::error!(
                    file = %entry.prepared.relative,
                    "component mutation rollback skipped because the target changed after commit"
                );
                failures.push(RollbackFailure {
                    relative: entry.prepared.relative.clone(),
                    retained_backup: Some(entry.backup_path.clone()),
                });
                continue;
            }
            Ok(RollbackTargetState::Updated | RollbackTargetState::Missing) => {}
            Err(error) => {
                tracing::error!(
                    file = %entry.prepared.relative,
                    error = %error,
                    "component mutation rollback could not verify the target"
                );
                failures.push(RollbackFailure {
                    relative: entry.prepared.relative.clone(),
                    retained_backup: Some(entry.backup_path.clone()),
                });
                continue;
            }
        }
        if let Err(error) = restore_backup(
            project_root,
            &entry.prepared.relative,
            &entry.backup_path,
            entry.path(),
        ) {
            tracing::error!(
                file = %entry.prepared.relative,
                error = %error,
                "component mutation rollback failed"
            );
            failures.push(RollbackFailure {
                relative: entry.prepared.relative.clone(),
                retained_backup: Some(entry.backup_path.clone()),
            });
        }
    }
    failures
}

fn fail_commit(
    project_root: &Path,
    staged: &mut [StagedFile],
    attempted: usize,
    primary: CommandError,
) -> CommandError {
    let failures = rollback(project_root, staged, attempted);
    cleanup_staged_preserving_backups(staged, &failures);
    if failures.is_empty() {
        return primary;
    }
    let files = failures
        .iter()
        .map(|failure| failure.relative.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let retained = failures
        .iter()
        .any(|failure| failure.retained_backup.is_some());
    CommandError::Io {
        message: format!(
            "{primary}; rollback was incomplete for {files}.{}",
            if retained {
                " Recovery backups were retained beside the affected source files."
            } else {
                " No recovery backup remained for at least one affected file."
            }
        ),
    }
}

fn cleanup_staged_preserving_backups(staged: &[StagedFile], failures: &[RollbackFailure]) {
    let retained: std::collections::HashSet<&Path> = failures
        .iter()
        .filter_map(|failure| failure.retained_backup.as_deref())
        .collect();
    for entry in staged {
        if !entry.staged_path.as_os_str().is_empty() {
            let _ = unlink_in_parent(&entry.staged_path);
        }
        if !entry.backup_path.as_os_str().is_empty()
            && !retained.contains(entry.backup_path.as_path())
        {
            let _ = unlink_in_parent(&entry.backup_path);
        }
    }
}

fn cleanup_staged(staged: &[StagedFile]) {
    for entry in staged {
        for path in [&entry.staged_path, &entry.backup_path] {
            if path.as_os_str().is_empty() {
                continue;
            }
            let _ = unlink_in_parent(path);
        }
    }
}

fn error_for_file(purpose: &str, file: &str, error: io::Error) -> CommandError {
    CommandError::Io {
        message: format!("could not {purpose} component source file '{file}': {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::components::types::ComponentGraphDelta;
    use std::fs;
    use tempfile::TempDir;

    fn write(root: &Path, relative: &str, content: &str) -> PathBuf {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    fn mutation(
        root: &Path,
        relative: &str,
        edits: Vec<ComponentTextEdit>,
    ) -> ComponentFileMutation {
        let path = root.join(relative);
        let original = fs::read(&path).unwrap();
        let source = String::from_utf8(original.clone()).unwrap();
        let updated = apply_text_edits(&source, &edits).unwrap();
        ComponentFileMutation {
            file: relative.to_string(),
            expected_hash: content_hash(&original),
            expected_result_hash: content_hash(updated.as_bytes()),
            edits,
        }
    }

    fn plan(root: &Path, files: Vec<ComponentFileMutation>) -> ComponentMutationPlan {
        ComponentMutationPlan {
            files,
            expected_revision: snapshot_for_root(root).unwrap().revision,
            dialect: None,
            parser_token: None,
            expected_graph_delta: None,
            operations: None,
        }
    }

    #[test]
    fn applies_sorted_byte_edits_without_reformatting_unicode_or_crlf() {
        let temp = TempDir::new().unwrap();
        let path = write(
            temp.path(),
            "src/Button.tsx",
            "const café = 'old';\r\nexport default café;\r\n",
        );
        let source = fs::read_to_string(&path).unwrap();
        let first_start = source.find("old").unwrap();
        let second_start = source.rfind("café").unwrap();
        let edits = vec![
            ComponentTextEdit {
                start: first_start,
                end: first_start + "old".len(),
                text: "new".to_string(),
            },
            ComponentTextEdit {
                start: second_start + "café".len(),
                end: second_start + "café".len(),
                text: " /* keep */".to_string(),
            },
        ];
        let plan = plan(
            temp.path(),
            vec![mutation(temp.path(), "src/Button.tsx", edits)],
        );
        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/Button.tsx"]);
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "const café = 'new';\r\nexport default café /* keep */;\r\n"
        );
    }

    #[test]
    fn refuses_non_boundary_and_overlapping_edits_without_writing() {
        let temp = TempDir::new().unwrap();
        let path = write(temp.path(), "src/A.tsx", "café");
        let source = fs::read_to_string(&path).unwrap();
        let invalid = ComponentFileMutation {
            file: "src/A.tsx".to_string(),
            expected_hash: content_hash(source.as_bytes()),
            expected_result_hash: "never-used".to_string(),
            edits: vec![ComponentTextEdit {
                start: 3,
                end: 4,
                text: "x".to_string(),
            }],
        };
        let error = apply_for_root(temp.path(), &plan(temp.path(), vec![invalid])).unwrap_err();
        assert!(error.to_string().contains("UTF-8"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "café");

        let overlap = ComponentFileMutation {
            file: "src/A.tsx".to_string(),
            expected_hash: content_hash("café".as_bytes()),
            expected_result_hash: content_hash("xy".as_bytes()),
            edits: vec![
                ComponentTextEdit {
                    start: 0,
                    end: 3,
                    text: "x".to_string(),
                },
                ComponentTextEdit {
                    start: 2,
                    end: 4,
                    text: "y".to_string(),
                },
            ],
        };
        assert!(apply_for_root(temp.path(), &plan(temp.path(), vec![overlap])).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "café");
    }

    #[test]
    fn refuses_stale_and_wrong_result_hashes_before_any_write() {
        let temp = TempDir::new().unwrap();
        let path = write(temp.path(), "src/A.tsx", "old");
        let mut stale = mutation(
            temp.path(),
            "src/A.tsx",
            vec![ComponentTextEdit {
                start: 0,
                end: 3,
                text: "new".to_string(),
            }],
        );
        fs::write(&path, "changed").unwrap();
        let error =
            apply_for_root(temp.path(), &plan(temp.path(), vec![stale.clone()])).unwrap_err();
        assert!(error.to_string().contains("changed"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "changed");

        fs::write(&path, "old").unwrap();
        stale.expected_result_hash =
            "0000000000000000000000000000000000000000000000000000000000000000".to_string();
        let error = apply_for_root(temp.path(), &plan(temp.path(), vec![stale])).unwrap_err();
        assert!(error.to_string().contains("result hash"));
        assert_eq!(fs::read_to_string(path).unwrap(), "old");
    }

    #[test]
    fn stages_and_commits_multiple_files_deterministically() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/z.ts", "z");
        write(temp.path(), "src/a.ts", "a");
        let plan = plan(
            temp.path(),
            vec![
                mutation(
                    temp.path(),
                    "src/z.ts",
                    vec![ComponentTextEdit {
                        start: 0,
                        end: 1,
                        text: "Z".to_string(),
                    }],
                ),
                mutation(
                    temp.path(),
                    "src/a.ts",
                    vec![ComponentTextEdit {
                        start: 0,
                        end: 1,
                        text: "A".to_string(),
                    }],
                ),
            ],
        );
        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/a.ts", "src/z.ts"]);
        assert_eq!(
            fs::read_to_string(temp.path().join("src/a.ts")).unwrap(),
            "A"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("src/z.ts")).unwrap(),
            "Z"
        );
        assert!(fs::read_dir(temp.path().join("src"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("shipstudio-component")));
    }

    #[test]
    fn validates_parser_and_graph_delta_before_staging() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "src/Button.tsx",
            "export default function Button() { return <button />; }",
        );
        let page = write(
            temp.path(),
            "src/Page.tsx",
            "import Button from './Button'; export function Page() { return <><Button /></>; }",
        );
        let source = fs::read_to_string(&page).unwrap();
        let insertion = source.find("</>").unwrap();
        let updated = format!("{}<Button />{}", &source[..insertion], &source[insertion..]);
        let plan = ComponentMutationPlan {
            files: vec![mutation(
                temp.path(),
                "src/Page.tsx",
                vec![ComponentTextEdit {
                    start: insertion,
                    end: insertion,
                    text: "<Button />".to_string(),
                }],
            )],
            expected_revision: snapshot_for_root(temp.path()).unwrap().revision,
            dialect: Some("react".to_string()),
            parser_token: Some(graph_guard::REACT_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(ComponentGraphDelta {
                component_id: "react:src/Button.tsx#default".to_string(),
                usages_before: 1,
                usages_after: 2,
                delta: 1,
                created_component_id: None,
                removed_component_id: None,
                created_usages: None,
            }),
            operations: None,
        };
        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/Page.tsx"]);
        assert_eq!(fs::read_to_string(page).unwrap(), updated);
    }

    #[test]
    fn validates_and_commits_a_native_astro_graph_delta() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "src/components/Card.astro",
            "---\ninterface Props { label: string }\n---\n<article>{label}</article>",
        );
        let page = write(
            temp.path(),
            "src/pages/index.astro",
            "---\nimport Card from '../components/Card.astro';\n---\n<main><Card label=\"One\" /></main>",
        );
        let source = fs::read_to_string(&page).unwrap();
        let insertion = source.find("</main>").unwrap();
        let updated = format!(
            "{}<Card label=\"Two\" />{}",
            &source[..insertion],
            &source[insertion..]
        );
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let plan = ComponentMutationPlan {
            files: vec![mutation(
                temp.path(),
                "src/pages/index.astro",
                vec![ComponentTextEdit {
                    start: insertion,
                    end: insertion,
                    text: "<Card label=\"Two\" />".to_string(),
                }],
            )],
            expected_revision: snapshot.revision,
            dialect: Some("astro".to_string()),
            parser_token: Some(graph_guard::ASTRO_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(ComponentGraphDelta {
                component_id: "astro:src/components/Card.astro#default".to_string(),
                usages_before: 1,
                usages_after: 2,
                delta: 1,
                created_component_id: None,
                removed_component_id: None,
                created_usages: None,
            }),
            operations: None,
        };

        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/pages/index.astro"]);
        assert_eq!(fs::read_to_string(page).unwrap(), updated);
    }

    #[test]
    fn validates_a_named_export_rename_and_preserves_its_usage_count() {
        let temp = TempDir::new().unwrap();
        let definition = write(
            temp.path(),
            "src/Button.tsx",
            "export function Button() { return <button />; }",
        );
        let page = write(
            temp.path(),
            "src/Page.tsx",
            "import { Button } from './Button'; export function Page() { return <Button />; }",
        );
        let definition_source = fs::read_to_string(&definition).unwrap();
        let page_source = fs::read_to_string(&page).unwrap();
        let definition_name = definition_source.find("Button").unwrap();
        let page_import = page_source.find("Button").unwrap();
        let page_usage = page_source.rfind("Button").unwrap();
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: snapshot.revision,
            dialect: Some("react".to_string()),
            parser_token: Some(graph_guard::REACT_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(ComponentGraphDelta {
                component_id: "react:src/Button.tsx#Button".to_string(),
                usages_before: 1,
                usages_after: 0,
                delta: -1,
                created_component_id: Some("react:src/Button.tsx#ActionButton".to_string()),
                removed_component_id: Some("react:src/Button.tsx#Button".to_string()),
                created_usages: Some(1),
            }),
            operations: Some(vec![
                ComponentFileOperation::Edit {
                    mutation: mutation(
                        temp.path(),
                        "src/Button.tsx",
                        vec![ComponentTextEdit {
                            start: definition_name,
                            end: definition_name + "Button".len(),
                            text: "ActionButton".to_string(),
                        }],
                    ),
                },
                ComponentFileOperation::Edit {
                    mutation: mutation(
                        temp.path(),
                        "src/Page.tsx",
                        vec![
                            ComponentTextEdit {
                                start: page_import,
                                end: page_import + "Button".len(),
                                text: "ActionButton".to_string(),
                            },
                            ComponentTextEdit {
                                start: page_usage,
                                end: page_usage + "Button".len(),
                                text: "ActionButton".to_string(),
                            },
                        ],
                    ),
                },
            ]),
        };

        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/Button.tsx", "src/Page.tsx"]);
        assert!(fs::read_to_string(definition)
            .unwrap()
            .contains("ActionButton"));
        assert!(fs::read_to_string(page).unwrap().contains("ActionButton"));
    }

    #[test]
    fn validates_a_named_export_delete_and_allows_the_removed_identity_to_disappear() {
        let temp = TempDir::new().unwrap();
        let definition = write(
            temp.path(),
            "src/Button.tsx",
            "export function Button() { return <button />; }",
        );
        let page = write(
            temp.path(),
            "src/Page.tsx",
            "import { Button } from './Button'; export function Page() { return <Button />; }",
        );
        let page_source = fs::read_to_string(&page).unwrap();
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: snapshot.revision,
            dialect: Some("react".to_string()),
            parser_token: Some(graph_guard::REACT_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(ComponentGraphDelta {
                component_id: "react:src/Button.tsx#Button".to_string(),
                usages_before: 1,
                usages_after: 0,
                delta: -1,
                created_component_id: None,
                removed_component_id: Some("react:src/Button.tsx#Button".to_string()),
                created_usages: None,
            }),
            operations: Some(vec![
                ComponentFileOperation::Edit {
                    mutation: mutation(
                        temp.path(),
                        "src/Button.tsx",
                        vec![ComponentTextEdit {
                            start: 0,
                            end: fs::read_to_string(&definition).unwrap().len(),
                            text: String::new(),
                        }],
                    ),
                },
                ComponentFileOperation::Edit {
                    mutation: mutation(
                        temp.path(),
                        "src/Page.tsx",
                        vec![ComponentTextEdit {
                            start: 0,
                            end: page_source.len(),
                            text: "export function Page() { return <main />; }".to_string(),
                        }],
                    ),
                },
            ]),
        };

        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/Button.tsx", "src/Page.tsx"]);
        assert_eq!(fs::read_to_string(definition).unwrap(), "");
        assert_eq!(
            fs::read_to_string(page).unwrap(),
            "export function Page() { return <main />; }"
        );
    }

    #[test]
    fn applies_edit_create_move_and_delete_in_one_guarded_transaction() {
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/Edit.ts", "export const before = true;\n");
        write(temp.path(), "src/Move.ts", "export const moved = true;\n");
        write(
            temp.path(),
            "src/Delete.ts",
            "export const deleted = true;\n",
        );
        let edit = mutation(
            temp.path(),
            "src/Edit.ts",
            vec![ComponentTextEdit {
                start: 0,
                end: "export const before = true;\n".len(),
                text: "export const after = true;\n".to_string(),
            }],
        );
        let move_source = fs::read(temp.path().join("src/Move.ts")).unwrap();
        let create_contents = "export const created = true;\n";
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: snapshot.revision,
            dialect: None,
            parser_token: None,
            expected_graph_delta: None,
            operations: Some(vec![
                ComponentFileOperation::Edit { mutation: edit },
                ComponentFileOperation::Create {
                    file: "src/Create.ts".to_string(),
                    expected_absent: true,
                    contents: create_contents.to_string(),
                    expected_result_hash: Some(content_hash(create_contents.as_bytes())),
                },
                ComponentFileOperation::Move {
                    from: "src/Move.ts".to_string(),
                    to: "src/Moved.ts".to_string(),
                    expected_hash: content_hash(&move_source),
                    expected_absent: true,
                    expected_result_hash: Some(content_hash(&move_source)),
                },
                ComponentFileOperation::Delete {
                    file: "src/Delete.ts".to_string(),
                    expected_hash: content_hash(b"export const deleted = true;\n"),
                },
            ]),
        };

        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(
            result.changed_files,
            vec![
                "src/Create.ts",
                "src/Delete.ts",
                "src/Edit.ts",
                "src/Move.ts",
                "src/Moved.ts",
            ]
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("src/Edit.ts")).unwrap(),
            "export const after = true;\n"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("src/Create.ts")).unwrap(),
            create_contents
        );
        assert!(!temp.path().join("src/Move.ts").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("src/Moved.ts")).unwrap(),
            "export const moved = true;\n"
        );
        assert!(!temp.path().join("src/Delete.ts").exists());
    }

    #[test]
    fn creates_a_guarded_duplicate_without_overwriting_existing_source() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "src/Header.tsx",
            "export default function Header() { return <header />; }",
        );
        write(
            temp.path(),
            "src/Page.tsx",
            "import Header from './Header'; export function Page() { return <Header />; }",
        );
        let contents = "export default function NavWrap() { return <header />; }";
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: snapshot.revision,
            dialect: Some("react".to_string()),
            parser_token: Some(graph_guard::REACT_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(ComponentGraphDelta {
                component_id: "react:src/Header.tsx#default".to_string(),
                usages_before: 1,
                usages_after: 1,
                delta: 0,
                created_component_id: Some("react:src/NavWrap.tsx#default".to_string()),
                removed_component_id: None,
                created_usages: Some(0),
            }),
            operations: Some(vec![ComponentFileOperation::Create {
                file: "src/NavWrap.tsx".to_string(),
                expected_absent: true,
                contents: contents.to_string(),
                expected_result_hash: Some(content_hash(contents.as_bytes())),
            }]),
        };

        let result = apply_for_root(temp.path(), &plan).unwrap();
        assert_eq!(result.changed_files, vec!["src/NavWrap.tsx"]);
        assert_eq!(
            fs::read_to_string(temp.path().join("src/NavWrap.tsx")).unwrap(),
            contents
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("src/Header.tsx")).unwrap(),
            "export default function Header() { return <header />; }"
        );
    }

    #[test]
    fn refuses_a_create_collision_before_staging() {
        let temp = TempDir::new().unwrap();
        write(
            temp.path(),
            "src/Header.tsx",
            "export default function Header() { return <header />; }",
        );
        let destination = write(temp.path(), "src/NavWrap.tsx", "existing");
        let snapshot = snapshot_for_root(temp.path()).unwrap();
        let plan = ComponentMutationPlan {
            files: Vec::new(),
            expected_revision: snapshot.revision,
            dialect: Some("react".to_string()),
            parser_token: Some(graph_guard::REACT_COMPONENT_PLAN_PARSER_TOKEN.to_string()),
            expected_graph_delta: Some(ComponentGraphDelta {
                component_id: "react:src/Header.tsx#default".to_string(),
                usages_before: 0,
                usages_after: 0,
                delta: 0,
                created_component_id: Some("react:src/NavWrap.tsx#default".to_string()),
                removed_component_id: None,
                created_usages: Some(0),
            }),
            operations: Some(vec![ComponentFileOperation::Create {
                file: "src/NavWrap.tsx".to_string(),
                expected_absent: true,
                contents: "new".to_string(),
                expected_result_hash: Some(content_hash(b"new")),
            }]),
        };

        let error = apply_for_root(temp.path(), &plan).unwrap_err();
        assert!(error.to_string().contains("already"));
        assert_eq!(fs::read_to_string(destination).unwrap(), "existing");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_mutation_path() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        write(temp.path(), "src/real.ts", "old");
        symlink(
            temp.path().join("src/real.ts"),
            temp.path().join("src/link.ts"),
        )
        .unwrap();
        let error = apply_for_root(
            temp.path(),
            &plan(
                temp.path(),
                vec![ComponentFileMutation {
                    file: "src/link.ts".to_string(),
                    expected_hash: content_hash(b"old"),
                    expected_result_hash: content_hash(b"new"),
                    edits: vec![ComponentTextEdit {
                        start: 0,
                        end: 3,
                        text: "new".to_string(),
                    }],
                }],
            ),
        )
        .unwrap_err();
        assert!(error.to_string().contains("symlink"));
        assert_eq!(
            fs::read_to_string(temp.path().join("src/real.ts")).unwrap(),
            "old"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_parent_before_commit_target_resolution() {
        use std::os::unix::fs::symlink;
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write(outside.path(), "file.ts", "outside");
        symlink(outside.path(), project.path().join("src")).unwrap();

        let target = project.path().join("src/file.ts");
        let error = ensure_safe_commit_target(
            project.path(),
            "src/file.ts",
            &target,
            CommitTargetExpectation::Existing,
        )
        .unwrap_err();

        assert!(error.to_string().contains("symlink"));
        assert_eq!(
            fs::read_to_string(outside.path().join("file.ts")).unwrap(),
            "outside"
        );
    }
}
