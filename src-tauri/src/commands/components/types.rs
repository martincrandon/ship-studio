//! Wire types shared by the component source commands.
//!
//! The component index itself lives in the frontend worker.  Rust only owns
//! the bounded source snapshot and the guarded source mutation protocol, so
//! these types deliberately contain no parser-specific data.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// One UTF-8 source file returned to the component index worker.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileSnapshot {
    /// Project-relative POSIX path (never an absolute path).
    pub file: String,
    pub content: String,
    /// Lowercase SHA-256 of the exact UTF-8 bytes in `content`.
    pub content_hash: String,
}

/// The immutable, bounded source view from which the worker builds an index.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSourceSnapshot {
    /// Project-relative workspace path. `"."` means the project root.
    pub workspace_root: String,
    /// Lowercase SHA-256 of the canonical active workspace identity and sorted
    /// `file` + `contentHash` pairs.
    pub revision: String,
    pub files: Vec<SourceFileSnapshot>,
    pub partial: bool,
    /// Structured, non-sensitive reasons why the snapshot is partial or a file
    /// could not be included. Diagnostics never contain source contents.
    pub diagnostics: Vec<ComponentSourceDiagnostic>,
}

/// A recoverable inventory problem.  The worker can continue indexing other
/// files while the UI presents this diagnostic beside the partial snapshot.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSourceDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

impl ComponentSourceDiagnostic {
    pub(crate) fn warning(
        code: impl Into<String>,
        message: impl Into<String>,
        file: Option<String>,
    ) -> Self {
        Self {
            code: code.into(),
            severity: "warning".to_string(),
            message: message.into(),
            file,
        }
    }
}

/// A byte-range replacement against the UTF-8 bytes of one source file.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentTextEdit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// All edits for one source file, guarded by both its current and expected
/// post-edit content hashes.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentFileMutation {
    /// Project-relative POSIX path.
    pub file: String,
    pub expected_hash: String,
    pub expected_result_hash: String,
    pub edits: Vec<ComponentTextEdit>,
}

/// A multi-file source mutation. Every file is validated and staged before the
/// first target is replaced.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentMutationPlan {
    pub files: Vec<ComponentFileMutation>,
    pub expected_revision: String,
}

/// Relative paths changed by a committed mutation, in deterministic order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentMutationResult {
    pub changed_files: Vec<String>,
}

/// Hash exact bytes using the same representation as the frontend protocol.
pub(crate) fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// Build a deterministic revision from sorted path/hash pairs without a
/// workspace scope.  Kept for callers that only need a content-set digest;
/// snapshots and mutation plans must use [`revision_for_workspace`].
#[allow(dead_code)]
pub(crate) fn revision_for<I>(pairs: I) -> String
where
    I: IntoIterator<Item = (String, String)>,
{
    revision_for_scope(None, pairs)
}

/// Build a deterministic revision for one canonical active workspace and its
/// sorted source path/hash pairs.  The workspace identity is part of the hash
/// rather than a separate wire field so a plan cannot be replayed after the
/// active monorepo subdirectory changes to another workspace with identical
/// source contents.
pub(crate) fn revision_for_workspace<I>(workspace: &Path, pairs: I) -> String
where
    I: IntoIterator<Item = (String, String)>,
{
    revision_for_scope(Some(workspace), pairs)
}

fn revision_for_scope<I>(workspace: Option<&Path>, pairs: I) -> String
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut pairs: Vec<(String, String)> = pairs.into_iter().collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));

    let mut hasher = Sha256::new();
    hasher.update(b"shipstudio-component-revision-v2");
    if let Some(workspace) = workspace {
        let workspace = workspace.to_string_lossy();
        hasher.update((workspace.len() as u64).to_be_bytes());
        hasher.update(workspace.as_bytes());
    } else {
        hasher.update(0_u64.to_be_bytes());
    }
    for (file, hash) in pairs {
        // Length prefixes avoid collisions such as `ab` + `c` vs `a` + `bc`.
        hasher.update((file.len() as u64).to_be_bytes());
        hasher.update(file.as_bytes());
        hasher.update((hash.len() as u64).to_be_bytes());
        hasher.update(hash.as_bytes());
    }
    hex::encode(hasher.finalize())
}
