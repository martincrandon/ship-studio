//! Git status and diff commands — change detection, file diffs, branch status.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::types::{
    BranchStatus, ChangedFile, ChangedFileSummary, GitOutgoingCommit, GitSyncState, GitSyncStatus,
};
use crate::utils::validate_project_path;
use std::hash::{DefaultHasher, Hash, Hasher};
use tracing::warn;

// Network git ops (fetch) go through the workspace-scoped helper in the parent
// module, so they authenticate as the project's workspace GitHub login.
use super::run_git_net;

use super::git_has_uncommitted_changes;

/// Run one local git query with the same transient process-pressure retry as
/// the other frequently-polled status helpers.
async fn status_git_output(
    project: &std::path::Path,
    args: &[&str],
) -> Result<std::process::Output, CommandError> {
    let mut cmd = crate::utils::git_command_in(project)?;
    cmd.args(args);
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        format!("git {}", args.join(" ")),
        10,
    )
    .await
}

async fn status_git_output_with_index(
    project: &std::path::Path,
    args: &[&str],
    index_path: &std::path::Path,
) -> Result<std::process::Output, CommandError> {
    let mut cmd = crate::utils::git_command_in(project)?;
    cmd.args(args).env("GIT_INDEX_FILE", index_path);
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        format!("git {}", args.join(" ")),
        10,
    )
    .await
}

fn git_text(output: &std::process::Output) -> Option<String> {
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
}

fn changed_file_summary_signature(
    project: &std::path::Path,
    status_output: &[u8],
    head_output: &std::process::Output,
    status_entries: &[(String, String, bool, Option<String>)],
) -> u64 {
    let mut hasher = DefaultHasher::new();
    status_output.hash(&mut hasher);
    head_output.status.success().hash(&mut hasher);
    head_output.stdout.hash(&mut hasher);
    head_output.stderr.hash(&mut hasher);

    for (relative_path, status, _, rename_source) in status_entries {
        relative_path.hash(&mut hasher);
        status.hash(&mut hasher);
        rename_source.hash(&mut hasher);
        let relative_path = std::path::Path::new(relative_path);
        if relative_path.is_absolute() {
            false.hash(&mut hasher);
            continue;
        }
        match std::fs::symlink_metadata(project.join(relative_path)) {
            Ok(metadata) => {
                true.hash(&mut hasher);
                metadata.len().hash(&mut hasher);
                metadata.file_type().is_file().hash(&mut hasher);
                metadata.file_type().is_symlink().hash(&mut hasher);
                if let Ok(modified) = metadata.modified() {
                    if let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) {
                        since_epoch.as_secs().hash(&mut hasher);
                        since_epoch.subsec_nanos().hash(&mut hasher);
                    }
                }
            }
            Err(error) => {
                false.hash(&mut hasher);
                error.raw_os_error().hash(&mut hasher);
            }
        }
    }
    hasher.finish()
}

fn write_changed_file_pathspecs(
    temp_dir: &std::path::Path,
    status_entries: &[(String, String, bool, Option<String>)],
) -> Result<std::path::PathBuf, CommandError> {
    let pathspec_file = temp_dir.join("changed-paths");
    let mut contents = Vec::new();
    for (path, _, _, rename_source) in status_entries {
        for path in std::iter::once(path).chain(rename_source.iter()) {
            contents.extend_from_slice(b":(literal)");
            contents.extend_from_slice(path.as_bytes());
            contents.push(0);
        }
    }
    std::fs::write(&pathspec_file, contents)?;
    Ok(pathspec_file)
}

async fn git_config_value(
    project: &std::path::Path,
    key: &str,
) -> Result<Option<String>, CommandError> {
    let output = status_git_output(project, &["config", "--get", key]).await?;
    Ok(git_text(&output))
}

fn parse_ahead_behind(output: &str) -> Option<(u32, u32)> {
    let mut counts = output.split_whitespace();
    let ahead = counts.next()?.parse().ok()?;
    let behind = counts.next()?.parse().ok()?;
    counts.next().is_none().then_some((ahead, behind))
}

fn parse_outgoing_commits(output: &[u8]) -> Option<Vec<GitOutgoingCommit>> {
    output
        .split(|byte| *byte == b'\n')
        .filter(|record| !record.is_empty())
        .map(|record| {
            let separator = record.iter().position(|byte| *byte == 0)?;
            let (sha, remainder) = record.split_at(separator);
            let subject = &remainder[1..];
            let sha = std::str::from_utf8(sha).ok()?;
            if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            Some(GitOutgoingCommit {
                sha: sha.to_string(),
                short_sha: sha.chars().take(7).collect(),
                subject: String::from_utf8_lossy(subject).into_owned(),
            })
        })
        .collect()
}

async fn outgoing_commits_for_known_remote_branches(
    project: &std::path::Path,
    remote: &str,
    head_sha: &str,
) -> Result<Option<Vec<GitOutgoingCommit>>, CommandError> {
    let refs = status_git_output(
        project,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(objecttype)",
            "refs/remotes",
        ],
    )
    .await?;
    if !refs.status.success() {
        return Ok(None);
    }

    let prefix = format!("refs/remotes/{remote}/");
    let mut known_oids = std::collections::BTreeSet::new();
    // Parse the three NUL-separated fields without decoding a path or relying
    // on whitespace, since remote and branch names may contain punctuation.
    for record in refs
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|r| !r.is_empty())
    {
        let mut fields = record.split(|byte| *byte == 0);
        let Some(refname) = fields.next() else {
            continue;
        };
        let Some(oid) = fields.next() else { continue };
        let Some(object_type) = fields.next() else {
            continue;
        };
        if fields.next().is_some() || object_type != b"commit" {
            continue;
        }
        if !refname.starts_with(prefix.as_bytes()) {
            continue;
        }
        let Ok(oid) = std::str::from_utf8(oid) else {
            continue;
        };
        if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            known_oids.insert(oid.to_string());
        }
    }
    if known_oids.is_empty() {
        return Ok(None);
    }

    let mut args = vec![
        "log".to_string(),
        "--format=%H%x00%s".to_string(),
        head_sha.to_string(),
        "--not".to_string(),
    ];
    args.extend(known_oids);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let log = status_git_output(project, &arg_refs).await?;
    Ok(log
        .status
        .success()
        .then(|| parse_outgoing_commits(&log.stdout))
        .flatten())
}

async fn known_remote_outgoing_preview(
    project: &std::path::Path,
    remotes: &[String],
    destination_remote: Option<&str>,
    head_sha: &str,
) -> Result<(Option<Vec<GitOutgoingCommit>>, Option<String>, Option<u32>), CommandError> {
    let remote = match destination_remote {
        Some(remote) if remotes.iter().any(|configured| configured == remote) => remote,
        Some(_) => return Ok((None, None, None)),
        None if remotes.len() == 1 => remotes[0].as_str(),
        None => return Ok((None, None, None)),
    };
    let Some(commits) =
        outgoing_commits_for_known_remote_branches(project, remote, head_sha).await?
    else {
        return Ok((None, None, None));
    };
    let Some(count) = u32::try_from(commits.len()).ok() else {
        return Ok((None, None, None));
    };
    Ok((
        Some(commits),
        Some(format!("{remote} known branches (last fetched)")),
        Some(count),
    ))
}

fn available_upstream_remote(
    configured_remote: Option<&str>,
    upstream: Option<&str>,
    remotes: &[String],
) -> Option<String> {
    configured_remote
        .filter(|remote| *remote != "." && remotes.iter().any(|name| name.as_str() == *remote))
        .map(str::to_string)
        .or_else(|| {
            upstream.and_then(|upstream| {
                remotes
                    .iter()
                    .filter(|remote| upstream.starts_with(&format!("{remote}/")))
                    .max_by_key(|remote| remote.len())
                    .cloned()
            })
        })
}

fn empty_sync_status(status: GitSyncState) -> GitSyncStatus {
    GitSyncStatus {
        status,
        branch: None,
        remote: None,
        upstream: None,
        remotes: Vec::new(),
        ahead: None,
        behind: None,
        head_sha: None,
        compared_upstream: None,
        compared_upstream_sha: None,
        outgoing_commits: None,
        outgoing_comparison: None,
        outgoing_comparison_label: None,
        outgoing_count: None,
    }
}

/// Read local tracking state without fetching. Counts are relative to the
/// remote-tracking ref last fetched by Git; every unavailable comparison is
/// represented by null counts and an explicit state.
#[tauri::command]
#[tracing::instrument(skip(project_path, destination_remote), fields(project = %project_path))]
pub async fn get_git_sync_status(
    project_path: String,
    destination_remote: Option<String>,
) -> Result<GitSyncStatus, CommandError> {
    let project = validate_project_path(&project_path)?;

    let inside = status_git_output(&project, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !inside.status.success() {
        // A missing .git entry identifies ordinary non-repository project
        // folders. If repository metadata exists but Git cannot read it, keep
        // the answer unknown instead of claiming there is no repository.
        return Ok(empty_sync_status(if project.join(".git").exists() {
            GitSyncState::Unknown
        } else {
            GitSyncState::NotRepository
        }));
    }

    let remote_output = status_git_output(&project, &["remote"]).await?;
    if !remote_output.status.success() {
        return Ok(empty_sync_status(GitSyncState::Unknown));
    }
    let remotes = String::from_utf8_lossy(&remote_output.stdout)
        .lines()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if destination_remote
        .as_deref()
        .is_some_and(|selected| !remotes.iter().any(|remote| remote == selected))
    {
        return Err(CommandError::Validation {
            field: "destinationRemote".to_string(),
            reason: "Choose a remote configured for this project.".to_string(),
        });
    }

    let branch_output =
        status_git_output(&project, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    let branch = git_text(&branch_output);
    if branch.is_none() {
        let head = status_git_output(&project, &["rev-parse", "--verify", "HEAD^{commit}"]).await?;
        return Ok(if head.status.success() {
            GitSyncStatus {
                status: GitSyncState::Detached,
                branch: None,
                remote: None,
                upstream: None,
                remotes,
                ahead: None,
                behind: None,
                head_sha: git_text(&head),
                compared_upstream: None,
                compared_upstream_sha: None,
                outgoing_commits: None,
                outgoing_comparison: None,
                outgoing_comparison_label: None,
                outgoing_count: None,
            }
        } else {
            empty_sync_status(GitSyncState::Unknown)
        });
    }
    let branch = branch.expect("checked above");

    let head = status_git_output(&project, &["rev-parse", "--verify", "HEAD^{commit}"]).await?;
    if !head.status.success() {
        // A symbolic branch without a commit is a valid unborn repository,
        // not a remote with zero outstanding commits.
        return Ok(GitSyncStatus {
            status: GitSyncState::Unborn,
            branch: Some(branch),
            remote: None,
            upstream: None,
            remotes,
            ahead: None,
            behind: None,
            head_sha: None,
            compared_upstream: None,
            compared_upstream_sha: None,
            outgoing_commits: None,
            outgoing_comparison: None,
            outgoing_comparison_label: None,
            outgoing_count: None,
        });
    }
    let Some(head_sha) = git_text(&head) else {
        return Ok(empty_sync_status(GitSyncState::Unknown));
    };

    let remote_key = format!("branch.{branch}.remote");
    let merge_key = format!("branch.{branch}.merge");
    let configured_remote = git_config_value(&project, &remote_key).await?;
    let configured_merge = git_config_value(&project, &merge_key).await?;
    let configured_upstream = configured_remote
        .as_deref()
        .zip(configured_merge.as_deref())
        .map(|(remote, merge)| {
            let branch_name = merge.strip_prefix("refs/heads/").unwrap_or(merge);
            if remote == "." {
                branch_name.to_string()
            } else {
                format!("{remote}/{branch_name}")
            }
        });

    let upstream_output = status_git_output(
        &project,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await?;
    let upstream = git_text(&upstream_output).or(configured_upstream);
    let remote =
        available_upstream_remote(configured_remote.as_deref(), upstream.as_deref(), &remotes);

    let Some(upstream) = upstream else {
        let (outgoing_commits, outgoing_comparison_label, outgoing_count) =
            known_remote_outgoing_preview(
                &project,
                &remotes,
                destination_remote.as_deref(),
                &head_sha,
            )
            .await?;
        return Ok(GitSyncStatus {
            status: if remotes.is_empty() {
                GitSyncState::NoRemote
            } else {
                GitSyncState::NoUpstream
            },
            branch: Some(branch),
            remote: None,
            upstream: None,
            remotes,
            ahead: None,
            behind: None,
            head_sha: Some(head_sha.clone()),
            compared_upstream: None,
            compared_upstream_sha: None,
            outgoing_comparison: outgoing_count.map(|_| "remote-known-branches".to_string()),
            outgoing_comparison_label,
            outgoing_count,
            outgoing_commits,
        });
    };

    // A local branch can track another local branch (`remote = "."`) or a
    // remote that was removed from this repository. Those refs may still be
    // comparable locally, but the Push action cannot send to them; report no
    // usable upstream so the user can choose one of the configured remotes.
    let Some(remote) = remote else {
        let (outgoing_commits, outgoing_comparison_label, outgoing_count) =
            known_remote_outgoing_preview(
                &project,
                &remotes,
                destination_remote.as_deref(),
                &head_sha,
            )
            .await?;
        return Ok(GitSyncStatus {
            status: if remotes.is_empty() {
                GitSyncState::NoRemote
            } else {
                GitSyncState::NoUpstream
            },
            branch: Some(branch),
            remote: None,
            upstream: None,
            remotes,
            ahead: None,
            behind: None,
            head_sha: Some(head_sha.clone()),
            compared_upstream: None,
            compared_upstream_sha: None,
            outgoing_comparison: outgoing_count.map(|_| "remote-known-branches".to_string()),
            outgoing_comparison_label,
            outgoing_count,
            outgoing_commits,
        });
    };

    let upstream_oid_output = status_git_output(
        &project,
        &["rev-parse", "--verify", "--end-of-options", "@{u}^{commit}"],
    )
    .await?;
    let Some(upstream_sha) = git_text(&upstream_oid_output) else {
        return Ok(GitSyncStatus {
            status: GitSyncState::Unknown,
            branch: Some(branch),
            remote: Some(remote),
            upstream: Some(upstream),
            remotes,
            ahead: None,
            behind: None,
            head_sha: Some(head_sha),
            compared_upstream: None,
            compared_upstream_sha: None,
            outgoing_commits: None,
            outgoing_comparison: None,
            outgoing_comparison_label: None,
            outgoing_count: None,
        });
    };

    // Resolve both ends once, then use only immutable object IDs below. This
    // keeps the list and ahead/behind counts aligned if refs move mid-query.
    let range = format!("{head_sha}...{upstream_sha}");
    let counts =
        status_git_output(&project, &["rev-list", "--left-right", "--count", &range]).await?;
    let parsed = counts
        .status
        .success()
        .then(|| parse_ahead_behind(&String::from_utf8_lossy(&counts.stdout)))
        .flatten();
    let Some((ahead, behind)) = parsed else {
        return Ok(GitSyncStatus {
            status: GitSyncState::Unknown,
            branch: Some(branch),
            remote: Some(remote),
            upstream: Some(upstream.clone()),
            remotes,
            ahead: None,
            behind: None,
            head_sha: Some(head_sha),
            compared_upstream: Some(upstream),
            compared_upstream_sha: Some(upstream_sha),
            outgoing_commits: None,
            outgoing_comparison: None,
            outgoing_comparison_label: None,
            outgoing_count: None,
        });
    };

    let outgoing_range = format!("{upstream_sha}..{head_sha}");
    let log = status_git_output(&project, &["log", "--format=%H%x00%s", &outgoing_range]).await?;
    let outgoing_commits = log
        .status
        .success()
        .then(|| parse_outgoing_commits(&log.stdout))
        .flatten();
    let Some(outgoing_commits) = outgoing_commits else {
        return Ok(GitSyncStatus {
            status: GitSyncState::Unknown,
            branch: Some(branch),
            remote: Some(remote),
            upstream: Some(upstream.clone()),
            remotes,
            ahead: None,
            behind: None,
            head_sha: Some(head_sha),
            compared_upstream: Some(upstream),
            compared_upstream_sha: Some(upstream_sha),
            outgoing_commits: None,
            outgoing_comparison: None,
            outgoing_comparison_label: None,
            outgoing_count: None,
        });
    };
    let Some(listed_ahead) = u32::try_from(outgoing_commits.len()).ok() else {
        return Ok(empty_sync_status(GitSyncState::Unknown));
    };
    if ahead != listed_ahead {
        return Ok(GitSyncStatus {
            status: GitSyncState::Unknown,
            branch: Some(branch),
            remote: Some(remote),
            upstream: Some(upstream.clone()),
            remotes,
            ahead: None,
            behind: None,
            head_sha: Some(head_sha),
            compared_upstream: Some(upstream),
            compared_upstream_sha: Some(upstream_sha),
            outgoing_commits: None,
            outgoing_comparison: None,
            outgoing_comparison_label: None,
            outgoing_count: None,
        });
    }

    Ok(GitSyncStatus {
        status: GitSyncState::Ready,
        branch: Some(branch),
        remote: Some(remote),
        upstream: Some(upstream.clone()),
        remotes,
        ahead: Some(listed_ahead),
        behind: Some(behind),
        head_sha: Some(head_sha),
        compared_upstream: Some(upstream.clone()),
        compared_upstream_sha: Some(upstream_sha),
        outgoing_commits: Some(outgoing_commits),
        outgoing_comparison: Some("upstream".to_string()),
        outgoing_comparison_label: Some(upstream.clone()),
        outgoing_count: Some(listed_ahead),
    })
}

/// Cap git stderr carried inside an error message so a pathological failure
/// (e.g. a hook dumping its whole log, or `git diff` printing its entire
/// `--no-index` usage text) can't flood the toast/telemetry, while keeping
/// enough text to diagnose the actual cause (issues #547, #912).
///
/// `pub(crate)` rather than `pub(super)`: the conflict commands run git from
/// outside this module and have exactly the same problem.
pub(crate) fn truncate_stderr(stderr: &str) -> String {
    const MAX: usize = 500;
    if stderr.len() <= MAX {
        return stderr.to_string();
    }
    // Cut on a char boundary at or below MAX so multi-byte text can't panic.
    let cut = (0..=MAX)
        .rev()
        .find(|i| stderr.is_char_boundary(*i))
        .unwrap_or(0);
    format!("{}…", &stderr[..cut])
}

/// Failure message for a non-zero `git status` exit. Git can die with a
/// completely silent stderr (killed by the OS, exec-level failure) — the old
/// unconditional `: {stderr}` suffix then produced "Failed to get git
/// status: " with zero diagnostic signal (issue #682). Fall back to the exit
/// code so telemetry always carries *something*.
fn git_status_failure_message(stderr_trimmed: &str, exit_code: Option<i32>) -> String {
    if stderr_trimmed.is_empty() {
        return match exit_code {
            Some(code) => format!("Failed to get git status (exit {code})"),
            None => "Failed to get git status (terminated by signal)".to_string(),
        };
    }
    // Include (truncated) stderr — a bare "Failed to get git status" is
    // undiagnosable and buckets unrelated root causes under one
    // fingerprint (issue #547, same class as #252).
    format!(
        "Failed to get git status: {}",
        truncate_stderr(stderr_trimmed)
    )
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn check_git_has_changes(project_path: String) -> Result<bool, CommandError> {
    // Check cache first
    if let Some(cached) = GIT_CACHE.get_has_changes(&project_path) {
        return Ok(cached);
    }

    let project = validate_project_path(&project_path)?;
    let git_dir = project.join(".git");

    // Not a git repo = no changes to track
    if !git_dir.exists() {
        return Ok(false);
    }

    // Check for uncommitted changes (staged or unstaged tracked files only)
    if git_has_uncommitted_changes(&project)? {
        GIT_CACHE.set_has_changes(&project_path, true);
        return Ok(true);
    }

    // Check for unpushed commits
    let unpushed = crate::utils::git_command_in(&project)?
        .args(["--no-pager", "log", "@{u}..", "--oneline"])
        .output();

    let result = match unpushed {
        Ok(output) => {
            let has_unpushed = !String::from_utf8_lossy(&output.stdout).trim().is_empty();
            Ok(has_unpushed)
        }
        Err(_) => {
            // No upstream set, check if we have commits
            let commits = crate::utils::git_command_in(&project)?
                .args(["--no-pager", "log", "--oneline", "-1"])
                .output()
                .map_err(|e| e.to_string())?;

            Ok(!String::from_utf8_lossy(&commits.stdout).trim().is_empty())
        }
    };

    // Cache the result
    if let Ok(has_changes) = result {
        GIT_CACHE.set_has_changes(&project_path, has_changes);
    }

    result
}

/// Get list of staged, unstaged and untracked files with uncommitted changes.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_changed_files(project_path: String) -> Result<Vec<ChangedFile>, CommandError> {
    // Check cache first
    if let Some(cached) = GIT_CACHE.get_changed_files(&project_path) {
        return Ok(cached);
    }

    let project = validate_project_path(&project_path)?;
    let git_dir = project.join(".git");

    // Not a git repo = no changed files
    if !git_dir.exists() {
        return Ok(vec![]);
    }

    // Run git status --porcelain (include untracked files)
    let output = crate::utils::git_command_in(&project)?
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Environment gaps (unaccepted Xcode license, missing CLT, macOS TCC
        // denial) are expected machine states with a user-side fix, not app
        // malfunctions (issues #603/#546).
        if let Some(gap) = crate::utils::git_environment_gap(&stderr) {
            warn!(error = %stderr.trim(), "git blocked by an environment gap while getting status");
            return Err(gap);
        }
        if stderr.trim().is_empty() {
            if let Some(gap) = crate::utils::git_exit_code_gap(output.status.code()) {
                warn!(exit_code = ?output.status.code(), "git status died silently with a known Windows crash code");
                return Err(gap);
            }
        }
        return Err(git_status_failure_message(stderr.trim(), output.status.code()).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<ChangedFile> = Vec::new();

    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }

        // Git status --porcelain format: XY filename
        // X = status in staging area, Y = status in working tree
        let status_chars = &line[0..2];
        let path = line[3..].trim().to_string();

        // Skip empty paths
        if path.is_empty() {
            continue;
        }

        // Determine the status based on git status codes
        let status = match status_chars.chars().collect::<Vec<char>>().as_slice() {
            ['?', '?'] => "untracked",
            ['D', _] | [_, 'D'] => "deleted",
            ['A', _] | [_, 'A'] => "added",
            ['R', _] | [_, 'R'] => "renamed",
            _ => "modified",
        };

        files.push(ChangedFile {
            path,
            status: status.to_string(),
            additions: None,
            deletions: None,
        });
    }

    // Cache the result
    GIT_CACHE.set_changed_files(&project_path, files.clone());

    Ok(files)
}

/// Gets the changed file list and aggregate line counts for the push dropdown.
/// A temporary index mirrors the final working tree, then one aggregate
/// `git diff --numstat` counts staged, unstaged and untracked changes together.
/// Binary, unreadable or otherwise ambiguous files retain null counts instead
/// of being presented as zero. The user's real index is never modified.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_changed_file_summary(
    project_path: String,
) -> Result<ChangedFileSummary, CommandError> {
    let project = validate_project_path(&project_path)?;
    if !project.join(".git").exists() {
        return Ok(ChangedFileSummary {
            files: Vec::new(),
            additions: Some(0),
            deletions: Some(0),
        });
    }

    let status_output = status_git_output(
        &project,
        &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    )
    .await?;
    if !status_output.status.success() {
        let stderr = String::from_utf8_lossy(&status_output.stderr);
        if let Some(gap) = crate::utils::git_environment_gap(&stderr) {
            warn!(error = %stderr.trim(), "git blocked by an environment gap while getting status summary");
            return Err(gap);
        }
        if stderr.trim().is_empty() {
            if let Some(gap) = crate::utils::git_exit_code_gap(status_output.status.code()) {
                warn!(exit_code = ?status_output.status.code(), "git status summary died silently with a known Windows crash code");
                return Err(gap);
            }
        }
        return Err(git_status_failure_message(stderr.trim(), status_output.status.code()).into());
    }
    let status_entries = parse_porcelain_v1_z(&status_output.stdout)?
        .into_iter()
        .filter(|(path, _, is_untracked, _)| {
            !(*is_untracked && (path == ".shipstudio" || path.starts_with(".shipstudio/")))
        })
        .collect::<Vec<_>>();
    if status_entries.is_empty() {
        return Ok(ChangedFileSummary {
            files: Vec::new(),
            additions: Some(0),
            deletions: Some(0),
        });
    }
    let head = status_git_output(&project, &["rev-parse", "--verify", "HEAD^{commit}"]).await?;
    let has_head = head.status.success();
    if !has_head {
        let symbolic_head =
            status_git_output(&project, &["symbolic-ref", "--quiet", "HEAD"]).await?;
        if !symbolic_head.status.success() {
            return Err(git_status_failure_message(
                String::from_utf8_lossy(&head.stderr).trim(),
                head.status.code(),
            )
            .into());
        }
    }
    let signature =
        changed_file_summary_signature(&project, &status_output.stdout, &head, &status_entries);
    if let Some(cached) = GIT_CACHE.get_changed_file_summary(&project_path, signature) {
        return Ok(cached);
    }
    let temporary_index_dir = tempfile::tempdir()?;
    let index_path = temporary_index_dir.path().join("index");
    let read_tree_args: &[&str] = if has_head {
        &["read-tree", "HEAD"]
    } else {
        &["read-tree", "--empty"]
    };
    let read_tree = status_git_output_with_index(&project, read_tree_args, &index_path).await?;
    if !read_tree.status.success() {
        return Err(git_status_failure_message(
            String::from_utf8_lossy(&read_tree.stderr).trim(),
            read_tree.status.code(),
        )
        .into());
    }
    // Add only status-reported paths to the isolated index. This mirrors
    // commit-all for staged/unstaged/untracked files, avoids traversing private
    // `.shipstudio` metadata, and leaves the user's real index untouched.
    let pathspec_file = write_changed_file_pathspecs(temporary_index_dir.path(), &status_entries)?;
    let pathspec_arg = format!("--pathspec-from-file={}", pathspec_file.display());
    let stage_all = status_git_output_with_index(
        &project,
        &["add", "-A", &pathspec_arg, "--pathspec-file-nul"],
        &index_path,
    )
    .await?;
    if !stage_all.status.success() {
        return Err(CommandError::Process {
            cmd: "git add -A --pathspec-from-file".into(),
            exit_code: stage_all.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&stage_all.stderr)
                .trim()
                .to_string(),
        });
    }
    let numstat_args: &[&str] = if has_head {
        &[
            "diff",
            "--cached",
            "--find-renames",
            "HEAD",
            "--numstat",
            "-z",
        ]
    } else {
        &[
            "diff",
            "--cached",
            "--find-renames",
            "--root",
            "--numstat",
            "-z",
        ]
    };
    let numstat = status_git_output_with_index(&project, numstat_args, &index_path).await?;
    if !numstat.status.success() {
        return Err(CommandError::Process {
            cmd: "git diff --cached --numstat".into(),
            exit_code: numstat.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&numstat.stderr).trim().to_string(),
        });
    }
    let stats_by_path = parse_numstat_z(&numstat.stdout)?;

    let mut files = Vec::with_capacity(status_entries.len());
    for (path, status, _is_untracked, _rename_source) in status_entries {
        let (additions, deletions) = stats_by_path.get(&path).copied().unwrap_or((None, None));
        files.push(ChangedFile {
            path,
            status,
            additions,
            deletions,
        });
    }

    let totals_known = files
        .iter()
        .all(|file| file.additions.is_some() && file.deletions.is_some());
    let (additions, deletions) = if totals_known {
        let additions = files
            .iter()
            .try_fold(0_u64, |total, file| total.checked_add(file.additions?));
        let deletions = files
            .iter()
            .try_fold(0_u64, |total, file| total.checked_add(file.deletions?));
        (additions, deletions)
    } else {
        (None, None)
    };

    let summary = ChangedFileSummary {
        files,
        additions,
        deletions,
    };
    GIT_CACHE.set_changed_file_summary(&project_path, signature, summary.clone());
    Ok(summary)
}

fn parse_porcelain_v1_z(
    output: &[u8],
) -> Result<Vec<(String, String, bool, Option<String>)>, CommandError> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err("Git returned an unreadable status record"
                .to_string()
                .into());
        }
        let status_chars = [record[0] as char, record[1] as char];
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let status = match status_chars {
            ['?', '?'] => "untracked",
            ['D', _] | [_, 'D'] => "deleted",
            ['A', _] | [_, 'A'] => "added",
            ['R', _] | [_, 'R'] | ['C', _] | [_, 'C'] => "renamed",
            _ => "modified",
        };
        let is_untracked = status == "untracked";
        let mut rename_source = None;
        // In `-z` mode a rename/copy record is followed by the source path.
        if status == "renamed" {
            let source_path = records.next().ok_or_else(|| {
                CommandError::from("Git returned an incomplete rename status record")
            })?;
            rename_source = Some(String::from_utf8_lossy(source_path).into_owned());
        }
        files.push((path, status.to_string(), is_untracked, rename_source));
    }
    Ok(files)
}

fn parse_numstat_z(
    output: &[u8],
) -> Result<std::collections::HashMap<String, (Option<u64>, Option<u64>)>, CommandError> {
    let mut records = output.split(|byte| *byte == 0);
    let mut stats = std::collections::HashMap::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let added = fields.next().unwrap_or_default();
        let removed = fields.next().unwrap_or_default();
        let path = fields
            .next()
            .ok_or_else(|| CommandError::from("Git returned an unreadable numstat record"))?;
        let additions = parse_numstat_count(added);
        let deletions = parse_numstat_count(removed);
        if path.is_empty() {
            // Rename/copy records have an empty path field, then old and new
            // paths as separate NUL-delimited records. Use the destination.
            let _old_path = records
                .next()
                .ok_or_else(|| CommandError::from("Git returned an incomplete numstat rename"))?;
            let new_path = records
                .next()
                .ok_or_else(|| CommandError::from("Git returned an incomplete numstat rename"))?;
            stats.insert(
                String::from_utf8_lossy(new_path).into_owned(),
                (additions, deletions),
            );
        } else {
            stats.insert(
                String::from_utf8_lossy(path).into_owned(),
                (additions, deletions),
            );
        }
    }
    Ok(stats)
}

fn parse_numstat_count(value: &[u8]) -> Option<u64> {
    if value == b"-" {
        None
    } else {
        std::str::from_utf8(value).ok()?.parse().ok()
    }
}

/// Get the diff for a single uncommitted file
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_file_diff(
    project_path: String,
    file_path: String,
) -> Result<crate::types::FileDiff, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Run git diff HEAD -- <filepath> to get all uncommitted changes
    let output = crate::utils::git_command_in(&validated_path)?
        .args(["diff", "HEAD", "--", &file_path])
        .output()
        .map_err(|e| e.to_string())?;

    let diff_content = String::from_utf8_lossy(&output.stdout).to_string();

    // If diff is empty, the file might be untracked (new file)
    if diff_content.trim().is_empty() {
        // Check if file is untracked
        let status_output = crate::utils::git_command_in(&validated_path)?
            .args(["status", "--porcelain", "--", &file_path])
            .output()
            .map_err(|e| e.to_string())?;

        let status = String::from_utf8_lossy(&status_output.stdout);

        // If status starts with "??" or "A ", it's a new file
        if status.starts_with("??") || status.starts_with("A ") {
            // Read the file content and return as all additions
            let full_path = validated_path.join(&file_path);
            let content = std::fs::read_to_string(&full_path)
                .map_err(|e| format!("Failed to read file: {e}"))?;

            let line_count = content.lines().count() as u32;

            return Ok(crate::types::FileDiff {
                file_path,
                is_new_file: true,
                is_deleted: false,
                is_binary: false,
                content,
                additions: line_count,
                deletions: 0,
            });
        }
    }

    // Check if file was deleted
    let is_deleted = diff_content.contains("deleted file mode");

    // Check if binary file
    let is_binary = diff_content.contains("Binary files");

    // Count additions and deletions
    let additions = diff_content
        .lines()
        .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
        .count() as u32;
    let deletions = diff_content
        .lines()
        .filter(|l| l.starts_with('-') && !l.starts_with("---"))
        .count() as u32;

    Ok(crate::types::FileDiff {
        file_path,
        is_new_file: false,
        is_deleted,
        is_binary,
        content: diff_content,
        additions,
        deletions,
    })
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_branch_status(project_path: String) -> Result<BranchStatus, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Check for local changes (tracked files only)
    let local_changes = git_has_uncommitted_changes(&validated_path)?;

    // Fetch latest from origin (log errors but don't fail)
    match run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Don't log if it's just a network issue or no remote
            if !stderr.contains("Could not resolve host")
                && !stderr.contains("Could not read from remote")
            {
                warn!(error = %stderr, "git fetch failed");
            }
        }
        Err(e) => {
            warn!(error = %e, "git fetch failed/timed out");
        }
        _ => {}
    }

    // Check if staging branch exists on remote
    let staging_check = crate::utils::git_command_in(&validated_path)?
        .args(["ls-remote", "--heads", "origin", "staging"])
        .output()
        .map_err(|e| e.to_string())?;

    let staging_exists = !String::from_utf8_lossy(&staging_check.stdout)
        .trim()
        .is_empty();

    // Get commits ahead/behind for staging
    let (staging_ahead, staging_behind) = if staging_exists {
        let output = crate::utils::git_command_in(&validated_path)?
            .args([
                "rev-list",
                "--left-right",
                "--count",
                "HEAD...origin/staging",
            ])
            .output()
            .map_err(|e| e.to_string())?;

        let counts = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = counts.trim().split('\t').collect();
        if parts.len() == 2 {
            (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    // Get commits ahead/behind for main
    let output = crate::utils::git_command_in(&validated_path)?
        .args(["rev-list", "--left-right", "--count", "HEAD...origin/main"])
        .output();

    let (main_ahead, main_behind) = if let Ok(output) = output {
        let counts = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = counts.trim().split('\t').collect();
        if parts.len() == 2 {
            (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    Ok(BranchStatus {
        local_changes,
        staging_ahead,
        staging_behind,
        main_ahead,
        main_behind,
        staging_exists,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        available_upstream_remote, git_status_failure_message, parse_ahead_behind, parse_numstat_z,
        parse_outgoing_commits, parse_porcelain_v1_z, truncate_stderr,
    };

    #[test]
    fn only_a_configured_remote_can_be_reported_as_a_push_upstream() {
        let remotes = vec!["origin".to_string(), "team".to_string()];

        assert_eq!(
            available_upstream_remote(Some("origin"), Some("origin/main"), &remotes),
            Some("origin".to_string())
        );
        assert_eq!(
            available_upstream_remote(None, Some("team/feature/ui"), &remotes),
            Some("team".to_string())
        );
        assert_eq!(
            available_upstream_remote(Some("."), Some("main"), &remotes),
            None
        );
        assert_eq!(
            available_upstream_remote(Some("deleted"), Some("deleted/main"), &remotes),
            None
        );
    }

    #[test]
    fn sync_counts_are_known_only_when_git_returns_two_valid_numbers() {
        assert_eq!(parse_ahead_behind("2\t3\n"), Some((2, 3)));
        assert_eq!(parse_ahead_behind("0 0"), Some((0, 0)));
        assert_eq!(parse_ahead_behind(""), None);
        assert_eq!(parse_ahead_behind("fatal: no upstream"), None);
        assert_eq!(parse_ahead_behind("2 unknown"), None);
        assert_eq!(parse_ahead_behind("2 3 trailing"), None);
    }

    #[test]
    fn outgoing_commit_records_preserve_full_ids_and_subjects() {
        let full_sha = "0123456789abcdef0123456789abcdef01234567";
        let output = format!("{full_sha}\0A useful subject\n");
        let commits = parse_outgoing_commits(output.as_bytes()).expect("valid git log records");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].sha, full_sha);
        assert_eq!(commits[0].short_sha, "0123456");
        assert_eq!(commits[0].subject, "A useful subject");
        assert_eq!(parse_outgoing_commits(b""), Some(Vec::new()));
        assert_eq!(parse_outgoing_commits(b"not-a-sha\0subject\n"), None);
    }

    #[test]
    fn changed_file_parsers_keep_spaces_and_unknown_binary_counts() {
        let status = b" M src/a file.ts\0?? public/image.png\0";
        let files = parse_porcelain_v1_z(status).expect("valid porcelain status");
        assert_eq!(
            files[0],
            ("src/a file.ts".into(), "modified".into(), false, None)
        );
        assert_eq!(
            files[1],
            ("public/image.png".into(), "untracked".into(), true, None)
        );

        let numstat = b"4\t2\tsrc/a file.ts\0-\t-\tpublic/image.png\0";
        let stats = parse_numstat_z(numstat).expect("valid numstat output");
        assert_eq!(stats.get("src/a file.ts"), Some(&(Some(4), Some(2))));
        assert_eq!(stats.get("public/image.png"), Some(&(None, None)));
    }

    #[test]
    fn changed_pathspec_file_is_nul_delimited_and_keeps_rename_sources_literal() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        let entries = vec![(
            "src/literal * name.ts".to_string(),
            "renamed".to_string(),
            false,
            Some("old/path.ts".to_string()),
        )];

        let pathspec_file =
            super::write_changed_file_pathspecs(temp_dir.path(), &entries).expect("pathspec file");
        let pathspecs = std::fs::read(pathspec_file).expect("pathspec bytes");
        assert_eq!(
            pathspecs,
            b":(literal)src/literal * name.ts\0:(literal)old/path.ts\0"
        );
    }

    #[test]
    fn truncate_stderr_passes_short_text_through() {
        let msg = "fatal: this repository is corrupt";
        assert_eq!(truncate_stderr(msg), msg);
        assert_eq!(truncate_stderr(""), "");
    }

    #[test]
    fn truncate_stderr_caps_long_text_with_ellipsis() {
        let long = "x".repeat(2000);
        let out = truncate_stderr(&long);
        assert!(out.len() < 600, "must be capped, got {} bytes", out.len());
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_stderr_respects_char_boundaries() {
        // Multi-byte chars straddling the cap must not panic.
        let long = "é".repeat(600);
        let out = truncate_stderr(&long);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn status_failure_keeps_stderr_when_present() {
        assert_eq!(
            git_status_failure_message("fatal: bad object HEAD", Some(128)),
            "Failed to get git status: fatal: bad object HEAD"
        );
    }

    // The #682 shape: non-zero exit with a silent stderr must carry the exit
    // code instead of trailing off after a colon.
    #[test]
    fn status_failure_falls_back_to_exit_code_when_stderr_is_empty() {
        assert_eq!(
            git_status_failure_message("", Some(128)),
            "Failed to get git status (exit 128)"
        );
    }

    #[test]
    fn status_failure_names_signal_death_when_no_exit_code() {
        assert_eq!(
            git_status_failure_message("", None),
            "Failed to get git status (terminated by signal)"
        );
    }
}
