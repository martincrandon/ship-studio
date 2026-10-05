//! Resolving the commit a hosting provider could plausibly have deployed.
//!
//! The question the UI answers is "did my push go live?", so the subject is
//! whatever the configured upstream has, not local `HEAD`. A provider can only
//! build what it was able to fetch, and showing a status against an unpushed
//! local commit would be confidently wrong. A successful Push result can also
//! pin a lookup to the exact SHA and branch returned by that operation.

use super::model::CommitRef;
use crate::errors::CommandError;
use crate::external_command::spawn_with_pressure_retry;
use crate::utils::git_command_in;
use std::path::Path;

/// Run a git command in the project and return trimmed stdout, or `None` if it
/// failed for any reason. Callers treat absence as "unknown", never as an error
/// — a missing upstream is a normal state, not a fault.
fn git_output(project: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = git_command_in(project).ok()?;
    cmd.args(args);
    let output =
        spawn_with_pressure_retry(&format!("git {}", args.join(" ")), || cmd.output()).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The current branch name, or `None` in detached HEAD — where "the branch I
/// pushed" has no meaning and the UI should say nothing rather than guess.
fn current_branch(project: &Path) -> Option<String> {
    git_output(project, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
}

/// Resolve the commit to ask providers about. A supplied `(sha, branch)` pair
/// comes from a successful Push operation and remains pinned through polling.
/// Without one, use the configured upstream's tracking ref. A branch without
/// an upstream falls back to local HEAD only to show the known commit identity;
/// `has_upstream` remains false so the UI does not imply a deployment exists.
pub fn pushed_commit(
    project: &Path,
    requested_sha: Option<&str>,
    requested_branch: Option<&str>,
) -> Result<CommitRef, CommandError> {
    let (branch, sha, has_upstream) = match (requested_sha, requested_branch) {
        (Some(sha), Some(branch)) => {
            if !valid_full_sha(sha) {
                return Err(CommandError::expected(
                    "The commit selected for hosting status is invalid. Refresh the Push menu and try again.",
                ));
            }
            if git_output(project, &["check-ref-format", "--branch", branch]).is_none() {
                return Err(CommandError::expected(
                    "The branch selected for hosting status is invalid. Refresh the Push menu and try again.",
                ));
            }
            let rev = format!("{sha}^{{commit}}");
            let resolved = git_output(project, &["rev-parse", "--verify", "--end-of-options", &rev])
                .ok_or_else(|| CommandError::expected(
                    "The pushed commit is no longer available in this project. Refresh the Push menu and try again.",
                ))?;
            if resolved != sha {
                return Err(CommandError::expected(
                    "Git resolved the pushed commit to a different revision. Refresh the Push menu and try again.",
                ));
            }
            (branch.to_string(), sha.to_string(), true)
        }
        (None, None) => {
            let branch = current_branch(project).ok_or_else(|| {
                CommandError::expected(
                    "This project isn't on a branch, so there's nothing to check.",
                )
            })?;
            let upstream = git_output(
                project,
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            );
            match upstream {
                Some(upstream) => {
                    let sha = git_output(project, &["rev-parse", &upstream]).ok_or_else(|| {
                        CommandError::expected("The current upstream commit is unavailable.")
                    })?;
                    (branch, sha, true)
                }
                None => {
                    let sha = git_output(project, &["rev-parse", "HEAD"]).ok_or_else(|| {
                        CommandError::expected("This project has no commits yet.")
                    })?;
                    (branch, sha, false)
                }
            }
        }
        _ => {
            return Err(CommandError::expected(
                "Hosting status needs both a pushed commit and its branch. Refresh the Push menu and try again.",
            ));
        }
    };

    let short_sha = sha.chars().take(7).collect::<String>();

    // One call for both fields; `%x00` keeps a subject containing newlines from
    // being mistaken for the timestamp line.
    let meta = git_output(project, &["log", "-1", "--format=%s%x00%ct", &sha]);
    let (subject, committed_at) = match meta {
        Some(raw) => {
            let mut parts = raw.split('\0');
            let subject = parts
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let committed_at = parts
                .next()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|secs| secs * 1000);
            (subject, committed_at)
        }
        None => (None, None),
    };

    Ok(CommitRef {
        sha,
        short_sha,
        subject,
        committed_at,
        branch,
        has_upstream,
    })
}

fn valid_full_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Build a throwaway repo with one commit. Returns None when git isn't
    /// usable in the test environment, so the suite degrades rather than fails.
    fn repo_with_one_commit() -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().ok()?;
        let path = dir.path();
        let run = |args: &[&str]| -> bool {
            Command::new("git")
                .args(args)
                .current_dir(path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) {
            return None;
        }
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(path.join("file.txt"), b"hello").ok()?;
        run(&["add", "."]);
        if !run(&["commit", "-q", "-m", "Add the first thing"]) {
            return None;
        }
        Some(dir)
    }

    #[test]
    fn a_never_pushed_branch_reports_no_upstream_and_still_resolves_head() {
        let Some(dir) = repo_with_one_commit() else {
            return;
        };
        let commit = pushed_commit(dir.path(), None, None).expect("resolves against HEAD");

        assert!(
            !commit.has_upstream,
            "a fresh repo has no origin, so nothing has been pushed"
        );
        assert_eq!(commit.sha.len(), 40);
        assert_eq!(commit.short_sha.len(), 7);
        assert!(commit.sha.starts_with(&commit.short_sha));
        assert_eq!(commit.subject.as_deref(), Some("Add the first thing"));
        assert!(commit.committed_at.unwrap_or(0) > 1_000_000_000_000);
    }

    #[test]
    fn a_repo_with_no_commits_is_an_expected_state_not_a_crash() {
        let Ok(dir) = tempfile::tempdir() else {
            return;
        };
        let ok = Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return;
        }

        let err = pushed_commit(dir.path(), None, None).unwrap_err();
        assert!(
            matches!(err, CommandError::Expected { .. }),
            "an empty repo is a normal state and must not be reported to telemetry"
        );
    }

    #[test]
    fn a_push_lookup_stays_pinned_to_the_returned_sha_after_head_moves() {
        let Some(dir) = repo_with_one_commit() else {
            return;
        };
        let path = dir.path();
        let branch = current_branch(path).unwrap();
        let first = git_output(path, &["rev-parse", "HEAD"]).unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(path)
                .output()
                .expect("git should start")
        };
        std::fs::write(path.join("next.txt"), "later commit\n").unwrap();
        assert!(run(&["add", "next.txt"]).status.success());
        assert!(run(&["commit", "-q", "-m", "Later commit"])
            .status
            .success());

        let pinned = pushed_commit(path, Some(&first), Some(&branch))
            .expect("the previously pushed SHA remains available");
        assert_eq!(pinned.sha, first);
        assert_eq!(pinned.subject.as_deref(), Some("Add the first thing"));
        assert!(pinned.has_upstream);
    }
}
