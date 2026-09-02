//! Hash-checked, byte-preserving source mutations for native components.
//!
//! The parser worker is responsible for producing safe ranges and expected
//! result hashes.  Rust is the final filesystem guard: it validates every path,
//! hash, UTF-8 boundary, and edit ordering before staging sibling temporary
//! files.  All files are staged before the first rename, and already-replaced
//! files are restored from sibling backups if a later replacement fails.

use super::inventory::{
    active_workspace_for_root, snapshot_for_root, validate_relative_source_path,
    validated_existing_path,
};
use super::types::{
    content_hash, ComponentFileMutation, ComponentMutationPlan, ComponentMutationResult,
    ComponentTextEdit, SourceFileSnapshot,
};
use crate::errors::CommandError;
use crate::utils::{canonicalize_tagged, validate_project_path};
use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, Read, Write};
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
    if plan.files.is_empty() {
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
    let workspace = active_workspace_for_root(&project_root)?;
    let prepared = prepare_files(
        &project_root,
        &workspace,
        &current_snapshot.files,
        &plan.files,
    )?;
    let mut staged = stage_files(&prepared)?;

    if let Err(error) = create_backups(&mut staged) {
        cleanup_staged(&staged);
        return Err(error);
    }

    // The initial reads happen before any temp file is created. Re-read each
    // target after all staging and backup I/O as a last pre-commit guard.
    if let Err(error) = verify_unchanged(&staged) {
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
        if let Err(error) = verify_entry_unchanged(&staged[replaced]) {
            return Err(fail_commit(&mut staged, replaced, error));
        }
        if let Err(error) = replace_staged(&staged[replaced].staged_path, staged[replaced].path()) {
            // Include the current index for platforms whose replace fallback
            // removes the target before discovering a second rename error.
            let primary = CommandError::Io {
                message: format!("could not commit component source mutation: {error}"),
            };
            return Err(fail_commit(
                &mut staged,
                replaced.saturating_add(1),
                primary,
            ));
        }
        replaced += 1;
    }

    for entry in &staged {
        if let Err(error) = fs::remove_file(&entry.backup_path) {
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

impl StagedFile {
    fn path(&self) -> &Path {
        &self.prepared.path
    }
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
        if !tracked_files.iter().any(|file| file.file == mutation.file) {
            return Err(validation(
                "file",
                format!(
                    "mutation file '{}' is not in the active source snapshot",
                    mutation.file
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

fn stage_files(prepared: &[PreparedFile]) -> Result<Vec<StagedFile>, CommandError> {
    let mut staged = Vec::with_capacity(prepared.len());
    for file in prepared {
        let staged_path = match write_sibling_temp(
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

fn create_backups(staged: &mut [StagedFile]) -> Result<(), CommandError> {
    for entry in staged.iter_mut() {
        match write_sibling_temp(
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

fn verify_unchanged(staged: &[StagedFile]) -> Result<(), CommandError> {
    for entry in staged {
        verify_entry_unchanged(entry)?;
    }
    Ok(())
}

fn verify_entry_unchanged(entry: &StagedFile) -> Result<(), CommandError> {
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
    fs::File::open(path)?
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

fn write_sibling_temp(
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
        let candidate = parent.join(format!(
            ".{name}.shipstudio-{purpose}-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.flush()) {
            let _ = fs::remove_file(&candidate);
            return Err(error);
        }
        if let Err(error) = file.sync_all() {
            let _ = fs::remove_file(&candidate);
            return Err(error);
        }
        drop(file);
        if let Err(error) = fs::set_permissions(&candidate, permissions.clone()) {
            let _ = fs::remove_file(&candidate);
            return Err(error);
        }
        return Ok(candidate);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique sibling temporary file",
    ))
}

fn replace_staged(staged: &Path, target: &Path) -> Result<(), io::Error> {
    #[cfg(windows)]
    {
        match fs::rename(staged, target) {
            Ok(()) => Ok(()),
            Err(first) if first.kind() == io::ErrorKind::AlreadyExists => {
                // std::fs::rename cannot replace an existing file on some
                // Windows versions.  Remove only the already validated target
                // and immediately rename the sibling temp into its place; the
                // backup lets the caller restore it if the second step fails.
                let mut permissions = fs::metadata(target)?.permissions();
                permissions.set_readonly(false);
                let _ = fs::set_permissions(target, permissions);
                fs::remove_file(target)?;
                fs::rename(staged, target)
            }
            Err(error) => Err(error),
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(staged, target)
    }
}

fn restore_backup(backup: &Path, target: &Path) -> Result<(), io::Error> {
    #[cfg(windows)]
    {
        if target.exists() {
            let mut permissions = fs::metadata(target)?.permissions();
            permissions.set_readonly(false);
            let _ = fs::set_permissions(target, permissions);
            fs::remove_file(target)?;
        }
    }
    fs::rename(backup, target)
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

fn rollback(staged: &mut [StagedFile], attempted: usize) -> Vec<RollbackFailure> {
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
        if let Err(error) = restore_backup(&entry.backup_path, entry.path()) {
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

fn fail_commit(staged: &mut [StagedFile], attempted: usize, primary: CommandError) -> CommandError {
    let failures = rollback(staged, attempted);
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
            let _ = fs::remove_file(&entry.staged_path);
        }
        if !entry.backup_path.as_os_str().is_empty()
            && !retained.contains(entry.backup_path.as_path())
        {
            let _ = fs::remove_file(&entry.backup_path);
        }
    }
}

fn cleanup_staged(staged: &[StagedFile]) {
    for entry in staged {
        for path in [&entry.staged_path, &entry.backup_path] {
            if path.as_os_str().is_empty() {
                continue;
            }
            let _ = fs::remove_file(path);
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
}
