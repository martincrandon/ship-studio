//! # Publishing Commands
//!
//! Pushing existing commits, and the git-push error taxonomy that
//! turns GitHub's stderr into something a user can act on.
//!
//! There used to be `publish_to_staging` and `publish_to_production` here too,
//! pushing `HEAD:staging` and `HEAD:main` and each returning a `PushResult`
//! of `{ url: "", state: "QUEUED" }` — a deploy state nobody had observed,
//! about a URL nobody knew. Nothing called them. Deployment status now comes
//! from asking the provider about the commit (`commands::hosting`).

// Network git ops (pull/push) go through the workspace-scoped helper so a
// publish authenticates as the project's workspace GitHub login, matching the
// gh-based repo-create path.
use crate::commands::git::run_git_net;
use crate::errors::CommandError;
use crate::types::PushResult;
use crate::utils::validate_project_path;
use tracing::{error, info, instrument, warn};

/// GitHub's push-time auth/permission rejections. The phrasing varies by
/// transport and failure mode: SSH's "Permission denied", the credential
/// helper's "could not read Username", HTTPS "Permission to <repo>.git denied
/// to <user>." (words split by the repo name — issue #321), and HTTPS
/// "remote: Write access to repository not granted." with a 403
/// (issue #343). All mean "reconnect GitHub or check your access", so all
/// map to NotAuthenticated instead of an opaque process error.
fn push_auth_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let is_auth = stderr.contains("Permission denied")
        || stderr.contains("could not read Username")
        || (lower.contains("permission to") && lower.contains("denied to"))
        || lower.contains("write access to repository not granted");
    if is_auth {
        return Some(CommandError::NotAuthenticated {
            service: format!("git remote (AUTH_ERROR: {stderr})"),
        });
    }
    None
}

/// GitHub pre-receive rejections that contain the literal word "rejected" but
/// are NOT the benign "someone else pushed first" race: the broad
/// `stderr.contains("rejected")` arms below matched them and told the user to
/// "pull changes first" — advice that can't fix either condition. Both are
/// user-fixable states with one specific remedy, so they get their own
/// message and stay out of telemetry (`Expected`).
///
/// - `GH001` / "exceeds GitHub's file size limit": a file over 100 MB — the
///   fix is removing the file or switching to Git LFS (issue #626).
/// - `GH005` / "refs longer than 255 bytes": the branch name itself is too
///   long for GitHub — the fix is renaming the branch (issue #636; the
///   frontend's `sanitizeBranchName` now caps generated names too).
///
/// Must run BEFORE any generic "rejected"/"non-fast-forward" check.
/// (`pub(crate)`: also used by `create_pull_request`'s auto-push, issue #654.)
pub(crate) fn push_pre_receive_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    if lower.contains("exceeds github's file size limit") || lower.contains("gh001") {
        // Best-effort: name the offending file(s) from lines like
        // "remote: error: File Archiv.zip is 120.17 MB; this exceeds GitHub's
        // file size limit of 100.00 MB".
        let files: Vec<&str> = stderr
            .lines()
            .filter(|l| l.to_lowercase().contains("file size limit"))
            .filter_map(|l| l.split("File ").nth(1))
            .filter_map(|rest| rest.split(" is ").next())
            .filter(|name| !name.is_empty())
            .collect();
        let detail = if files.is_empty() {
            String::new()
        } else {
            format!(" ({})", files.join(", "))
        };
        return Some(CommandError::expected(format!(
            "GitHub rejected this push because a file is larger than its 100 MB limit{detail}. \
             Remove the file from the branch (or use Git LFS for large files) and push again — \
             pulling changes won't help."
        )));
    }
    if lower.contains("gh005")
        || lower.contains("refs longer than")
        || lower.contains("ref too long")
    {
        return Some(CommandError::expected(
            "GitHub rejected this push because the branch name is too long (GitHub limits refs \
             to 255 bytes). Rename the branch to something shorter and push again — pulling \
             changes won't help.",
        ));
    }
    None
}

/// GitHub's transient server-side failure while accepting a push: the remote
/// replies "remote: Internal Server Error" (plus a Request ID / Time pair) and
/// git prints "! [remote rejected] <branch> -> <branch> (Internal Server
/// Error)". That line contains the literal word "rejected", so without this
/// check it fell into the generic "rejected" arms and the user was told
/// "someone else pushed — pull first", advice that can't fix a GitHub 5xx;
/// the actual remedy is simply retrying (issue #678, same class as the
/// GH001/GH005 misclassifications above). A GitHub-side blip, not an app
/// malfunction — Expected keeps it out of telemetry.
///
/// Must run BEFORE any generic "rejected"/"non-fast-forward" check.
/// (`pub(crate)`: also used by `create_pull_request`'s auto-push.)
pub(crate) fn push_transient_server_error(stderr: &str) -> Option<CommandError> {
    stderr
        .to_lowercase()
        .contains("internal server error")
        .then(|| {
            CommandError::expected(
                "The remote host had a temporary problem accepting this push (a server error \
                 on its side). Nothing is wrong with your changes — wait a moment and \
                 try again.",
            )
        })
}

/// Push-time "the remote repo doesn't exist" rejections — the linked repo was
/// deleted, renamed, transferred, or made inaccessible outside the app.
/// Environment, not malfunction: telemetry-flooding this on every publish
/// attempt for a stale remote helps nobody (issue #435).
/// (`pub(crate)`: also reached through `git::classify_git_net_error`, so
/// push_branch/delete_branch/create_pull_request classify it too — issue #825.)
pub(crate) fn push_missing_remote_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let missing = lower.contains("repository not found")
        || (lower.contains("repository") && lower.contains("not found") && lower.contains("fatal"));
    missing.then(|| {
        CommandError::expected(
            "The configured remote repository couldn't be found — it may have been deleted, renamed,              or you may no longer have access. Check the remote URL and credentials, then try again.",
        )
    })
}

/// `git push` failing with "src refspec … cannot be resolved to branch" /
/// "… does not match any": the branch name git was asked to push doesn't
/// resolve — almost always a branch created with different letter-casing on a
/// case-insensitive filesystem, so the ref on disk and the name in use
/// disagree. User-side git state, not a malfunction (issue #854).
pub(crate) fn push_unresolvable_branch_error(stderr: &str, branch: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let unresolvable = lower.contains("cannot be resolved to branch")
        || (lower.contains("src refspec") && lower.contains("does not match any"));
    unresolvable.then(|| {
        CommandError::expected(format!(
            "Git couldn't resolve the branch \"{branch}\" for pushing. This usually means a \
             branch with the same name but different letter-casing already exists. Run \
             `git branch -a` in a terminal, rename or delete the similarly-named branch, then \
             try again."
        ))
    })
}

/// Push the current branch's existing commits to its upstream, or to the
/// explicitly selected remote when the branch has no upstream. This operation
/// never stages files or creates commits.
#[tauri::command]
#[instrument(name = "push_current_branch", skip(project_path), fields(project = %project_path))]
pub async fn push_current_branch(
    project_path: String,
    remote: Option<String>,
    expected_branch: Option<String>,
) -> Result<PushResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let result =
        push_current_branch_inner(&validated_path, remote, expected_branch.as_deref()).await?;
    crate::cache::GIT_CACHE.invalidate_status(&project_path);
    Ok(result)
}

/// Compatibility command for existing callers. Its behavior now matches the
/// Push label: it sends commits that already exist and leaves working-tree
/// changes alone. Commit and push are separate commands in the UI.
#[tauri::command]
#[instrument(name = "publish_branch", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_branch(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PushResult, CommandError> {
    let _ = commit_message;
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let result = push_current_branch_inner(&validated_path, None, None).await?;
    crate::cache::GIT_CACHE.invalidate_status(&project_path);
    Ok(result)
}

fn local_git_output(
    path: &std::path::Path,
    args: &[&str],
) -> Result<std::process::Output, CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args(args);
    crate::external_command::spawn_with_pressure_retry(&format!("git {}", args.join(" ")), || {
        cmd.output()
    })
}

fn output_text(output: &std::process::Output) -> Option<String> {
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
}

fn configured_branch_upstream(path: &std::path::Path, branch: &str) -> Option<(String, String)> {
    let remote_key = format!("branch.{branch}.remote");
    let merge_key = format!("branch.{branch}.merge");
    let remote = output_text(&local_git_output(path, &["config", "--get", &remote_key]).ok()?)?;
    let merge = output_text(&local_git_output(path, &["config", "--get", &merge_key]).ok()?)?;
    let branch = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
    Some((remote, branch.to_string()))
}

fn parse_upstream_remote<'a>(
    upstream: &'a str,
    remotes: &'a [String],
) -> Option<(&'a str, &'a str)> {
    remotes
        .iter()
        .filter_map(|remote| {
            upstream
                .strip_prefix(&format!("{remote}/"))
                .map(|branch| (remote.as_str(), branch))
        })
        .max_by_key(|(remote, _)| remote.len())
}

/// Record the destination that was just accepted by the remote so the next
/// sync-status read can compare against that known commit. If this local
/// metadata write fails, Push still succeeded; callers receive `None` for the
/// upstream and can show the exact destination from the other result fields.
fn record_pushed_upstream(
    project: &std::path::Path,
    branch: &str,
    remote: &str,
    remote_branch: &str,
    commit_sha: &str,
    configure_upstream: bool,
) -> bool {
    if configure_upstream {
        let remote_key = format!("branch.{branch}.remote");
        let merge_key = format!("branch.{branch}.merge");
        let config_remote = local_git_output(
            project,
            &["config", "--local", "--replace-all", &remote_key, remote],
        );
        let config_merge = local_git_output(
            project,
            &[
                "config",
                "--local",
                "--replace-all",
                &merge_key,
                &format!("refs/heads/{remote_branch}"),
            ],
        );
        if !config_remote
            .as_ref()
            .map(|out| out.status.success())
            .unwrap_or(false)
            || !config_merge
                .as_ref()
                .map(|out| out.status.success())
                .unwrap_or(false)
        {
            warn!(
                branch,
                remote, "Push succeeded but Git could not save the upstream configuration"
            );
            return false;
        }
    }

    let tracking_ref = format!("refs/remotes/{remote}/{remote_branch}");
    let update = local_git_output(project, &["update-ref", &tracking_ref, commit_sha]);
    if !update
        .as_ref()
        .map(|out| out.status.success())
        .unwrap_or(false)
    {
        warn!(
            branch,
            remote, "Push succeeded but Git could not update its local tracking ref"
        );
        return false;
    }
    true
}

async fn push_current_branch_inner(
    project: &std::path::Path,
    requested_remote: Option<String>,
    expected_branch: Option<&str>,
) -> Result<PushResult, CommandError> {
    let branch =
        crate::commands::git::ensure_branch_mutation_is_safe(project, expected_branch, "push")?;

    let head = local_git_output(project, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let commit_sha = output_text(&head).ok_or_else(|| {
        CommandError::expected(
            "This branch has no commit yet. Create a local commit before pushing.",
        )
    })?;

    let remote_output = local_git_output(project, &["remote"])?;
    if !remote_output.status.success() {
        return Err(CommandError::expected(
            "Git could not read this project's configured remotes. Check the repository and try again.",
        ));
    }
    let remotes = String::from_utf8_lossy(&remote_output.stdout)
        .lines()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    let (remote, remote_branch, set_upstream) = if let Some(remote) = requested_remote {
        if !remotes.iter().any(|configured| configured == &remote) {
            return Err(CommandError::expected(format!(
                "The remote \"{remote}\" is not configured for this project. Refresh the Push menu and choose an available remote."
            )));
        }
        (remote, branch.clone(), true)
    } else if let Some(upstream) = output_text(&local_git_output(
        project,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?) {
        let Some((remote, remote_branch)) = parse_upstream_remote(&upstream, &remotes) else {
            return Err(CommandError::expected(
                "The current branch's upstream is not a configured remote. Choose a push destination in the Push menu.",
            ));
        };
        (remote.to_string(), remote_branch.to_string(), false)
    } else if let Some((remote, remote_branch)) = configured_branch_upstream(project, &branch) {
        // A configured upstream whose tracking ref has not been fetched (or
        // has been deleted locally) is still a known destination. Preserve its
        // explicit remote/branch instead of falling back to `origin` or main.
        if remote == "." || !remotes.iter().any(|configured| configured == &remote) {
            return Err(CommandError::expected(
                "The current branch's upstream is not an available remote. Choose a push destination in the Push menu.",
            ));
        }
        (remote, remote_branch, false)
    } else {
        return Err(CommandError::expected(if remotes.is_empty() {
            "This project has no Git remote. Add a remote before pushing this commit."
        } else {
            "This branch has no upstream. Choose a configured remote to publish it."
        }));
    };

    let branch_at_push =
        crate::commands::git::ensure_branch_mutation_is_safe(project, Some(&branch), "push")?;
    let head_at_push = output_text(&local_git_output(
        project,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )?);
    if branch_at_push != branch || head_at_push.as_deref() != Some(commit_sha.as_str()) {
        return Err(CommandError::expected(
            "The current branch or commit changed while Push was preparing. Refresh the Push menu and try again.",
        ));
    }

    info!(branch = %branch, remote = %remote, remote_branch = %remote_branch, "Pushing existing commits");
    // Push the SHA captured above, so a concurrent agent commit or branch
    // switch cannot make the returned commitSha describe a different ref.
    let refspec = format!("{commit_sha}:refs/heads/{remote_branch}");
    let push_args = vec!["push".to_string(), remote.clone(), refspec];
    let push_arg_refs = push_args.iter().map(String::as_str).collect::<Vec<_>>();
    let push_output = run_git_net(&push_arg_refs, project, "push").await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Pre-receive declines (GH001 large file, GH005 ref too long) contain
        // the word "rejected" but are NOT the concurrent-push race — check
        // them first or the frontend shows the "someone else pushed, pull
        // first" modal for a problem pulling can't fix (issues #626/#636).
        if let Some(err) = push_pre_receive_error(&stderr) {
            warn!(error = %stderr, branch = %branch, "Push declined by remote pre-receive check");
            return Err(err);
        }
        // GitHub-side 5xx: "! [remote rejected] … (Internal Server Error)"
        // contains "rejected" but isn't the concurrent-push race — must run
        // before that arm or the user gets pull-first advice for a transient
        // GitHub outage (issue #678).
        if let Some(err) = push_transient_server_error(&stderr) {
            warn!(error = %stderr, branch = %branch, "Push failed on a GitHub server error");
            return Err(err);
        }
        // Check for common errors
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            warn!(error = %stderr, branch = %branch, "Push rejected");
            // Someone else pushed first — an anticipated race the frontend
            // already handles via the PUSH_REJECTED sentinel (GitErrorHandler's
            // push_rejected case). Expected serializes identically to Other on
            // the wire, so the substring match keeps working (issue #617).
            return Err(CommandError::expected(format!("PUSH_REJECTED:{stderr}")));
        }
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, branch = %branch, "Push authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
        if let Some(err) = push_unresolvable_branch_error(&stderr, &branch) {
            warn!(error = %stderr, branch = %branch, "Push refspec did not resolve");
            return Err(err);
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, branch = %branch, "Push failed");
            return Err(CommandError::Process {
                cmd: "git push".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    let tracking_recorded = record_pushed_upstream(
        project,
        &branch,
        &remote,
        &remote_branch,
        &commit_sha,
        set_upstream,
    );
    let upstream = if !tracking_recorded {
        None
    } else {
        Some(format!("{remote}/{remote_branch}"))
    };
    info!(branch = %branch, remote = %remote, "Branch pushed successfully");
    Ok(PushResult {
        branch,
        remote,
        upstream,
        commit_sha,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        push_current_branch_inner, push_pre_receive_error, push_transient_server_error,
        push_unresolvable_branch_error,
    };
    use crate::commands::git::run_git_net;
    use crate::errors::CommandError;
    use std::path::Path;

    // The #678 shape: GitHub's edge returning a transient 5xx while accepting
    // the push. Contains "! [remote rejected]" — must classify Expected with
    // retry guidance instead of falling into the pull-first PUSH_REJECTED arm.
    #[test]
    fn transient_server_error_classifies_github_ise() {
        let stderr = "remote: Internal Server Error        \nremote: Request ID 65EF:1EC443:289A4B:2BCFC2:6A7DD5C5        \nremote: Time 2026-08-13T14:33:42Z\nTo https://github.com/o/r.git\n ! [remote rejected] main -> main (Internal Server Error)\nerror: failed to push some refs to 'https://github.com/o/r.git'\n";
        let err = push_transient_server_error(stderr).expect("must classify the GitHub 5xx");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(
            msg.contains("try again"),
            "must suggest retrying, got: {msg}"
        );
        assert!(
            !msg.contains("PUSH_REJECTED") && !msg.to_lowercase().contains("pull"),
            "must not steer toward the pull-first flow, got: {msg}"
        );
        // Not a pre-receive decline — the sibling helper must not claim it.
        assert!(push_pre_receive_error(stderr).is_none());
    }

    // An ordinary non-fast-forward race and the pre-receive declines must NOT
    // match — they keep their existing paths.
    #[test]
    fn transient_server_error_ignores_other_push_failures() {
        assert!(push_transient_server_error(
            " ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/o/r.git'"
        )
        .is_none());
        assert!(push_transient_server_error(
            "remote: error: GH001: Large files detected.\n ! [remote rejected] x -> x (pre-receive hook declined)"
        )
        .is_none());
        assert!(push_transient_server_error("").is_none());
    }

    // The #626 shape: GH001 large-file decline contains "rejected" but is not
    // the concurrent-push race — it must classify Expected with LFS guidance
    // and name the offending file.
    #[test]
    fn pre_receive_error_classifies_gh001_large_file() {
        let stderr = "remote: error: Trace: 3539f6eaf2da6d14bbb65f8b9db2f684f713c6d5732665c678bdc1bb29d18696\nremote: error: See https://gh.io/lfs for more information.\nremote: error: File Archiv.zip is 120.17 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.\n ! [remote rejected] feat/x -> feat/x (pre-receive hook declined)\nerror: failed to push some refs to 'https://github.com/o/r.git'";
        let err = push_pre_receive_error(stderr).expect("must classify GH001");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("100 MB"), "got: {msg}");
        assert!(msg.contains("Archiv.zip"), "must name the file, got: {msg}");
        assert!(msg.contains("LFS"), "must point at Git LFS, got: {msg}");
        assert!(
            !msg.contains("PUSH_REJECTED"),
            "must not trigger the pull-first modal"
        );
    }

    // The #636 shape: GH005 ref-too-long decline — the only fix is renaming
    // the branch, not pulling.
    #[test]
    fn pre_receive_error_classifies_gh005_ref_too_long() {
        let stderr = "remote: error: GH005: Sorry, refs longer than 255 bytes are not allowed.\nremote: ref too long: \"refs/heads/user/some-extremely-long-generated-branch-name\"\n ! [remote rejected] x -> x (pre-receive hook declined)\nerror: failed to push some refs to 'https://github.com/o/r.git'";
        let err = push_pre_receive_error(stderr).expect("must classify GH005");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("branch name is too long"), "got: {msg}");
        assert!(msg.contains("Rename"), "must suggest renaming, got: {msg}");
    }

    // An ordinary non-fast-forward race must NOT classify — it stays on the
    // existing PUSH_REJECTED path with its dedicated pull-first UI.
    #[test]
    fn unresolvable_refspec_is_expected() {
        let stderr = "fatal: Feature/Login cannot be resolved to branch";
        let err = push_unresolvable_branch_error(stderr, "Feature/Login").expect("classified");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(err.to_string().contains("Feature/Login"));
        assert!(err.to_string().contains("letter-casing"));
        assert!(push_unresolvable_branch_error(
            "error: src refspec main does not match any",
            "main"
        )
        .is_some());
        assert!(push_unresolvable_branch_error("fatal: unable to access", "main").is_none());
    }

    #[test]
    fn pre_receive_error_ignores_ordinary_push_race() {
        let stderr = " ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: Updates were rejected because the tip of your current branch is behind";
        assert!(push_pre_receive_error(stderr).is_none());
        assert!(push_pre_receive_error("").is_none());
        // Other pre-receive declines (branch protection etc.) fall through to
        // the existing arms too.
        assert!(push_pre_receive_error(
            "remote: error: GH006: Protected branch update failed for refs/heads/main"
        )
        .is_none());
    }

    #[tokio::test]
    async fn current_branch_pushes_only_the_captured_commit_and_leaves_working_tree_alone() {
        let repo = tempfile::tempdir().expect("temporary repository");
        let remote = tempfile::tempdir().expect("temporary bare remote");
        let run = |cwd: &Path, args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git should start")
        };
        let assert_success = |output: std::process::Output| {
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };

        assert_success(run(repo.path(), &["init", "--initial-branch=main", "-q"]));
        assert_success(run(
            repo.path(),
            &["config", "user.name", "Ship Studio Test"],
        ));
        assert_success(run(
            repo.path(),
            &["config", "user.email", "test@example.com"],
        ));
        std::fs::write(repo.path().join("tracked.txt"), "committed\n").unwrap();
        assert_success(run(repo.path(), &["add", "tracked.txt"]));
        assert_success(run(repo.path(), &["commit", "-m", "Initial commit", "-q"]));
        assert_success(run(remote.path(), &["init", "--bare", "-q"]));
        assert_success(run(
            repo.path(),
            &[
                "remote",
                "add",
                "destination",
                remote.path().to_str().unwrap(),
            ],
        ));

        // These changes are visible in the status menu but are deliberately
        // outside the commit SHA being pushed.
        std::fs::write(repo.path().join("tracked.txt"), "still uncommitted\n").unwrap();
        std::fs::write(repo.path().join("new.txt"), "untracked\n").unwrap();
        let result =
            push_current_branch_inner(repo.path(), Some("destination".into()), Some("main"))
                .await
                .expect("the local bare remote should accept the push");

        assert_eq!(result.branch, "main");
        assert_eq!(result.remote, "destination");
        assert_eq!(result.upstream.as_deref(), Some("destination/main"));
        let remote_head = Command::new("git")
            .args([
                "--git-dir",
                remote.path().to_str().unwrap(),
                "rev-parse",
                "refs/heads/main",
            ])
            .output()
            .unwrap();
        assert!(remote_head.status.success());
        assert_eq!(
            String::from_utf8_lossy(&remote_head.stdout).trim(),
            result.commit_sha
        );

        let status = run(repo.path(), &["status", "--porcelain"]);
        assert_success(status.clone());
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(
            status.contains("tracked.txt"),
            "tracked edit was staged or lost: {status}"
        );
        assert!(
            status.contains("?? new.txt"),
            "untracked file was staged or lost: {status}"
        );
        let count = run(repo.path(), &["rev-list", "--count", "HEAD"]);
        assert_success(count.clone());
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "1");
    }

    /// The network git helper must actually execute git through the timeout path
    /// (the whole point of A8 — replacing blocking `.output()` so a hung remote
    /// can't freeze publishing). `--version` needs no repo or remote, so this is
    /// deterministic and guards the `create_command` + `run_with_timeout` wiring.
    #[tokio::test]
    async fn run_git_net_executes_git_through_timeout() {
        let out = run_git_net(&["--version"], Path::new("."), "--version")
            .await
            .expect("git --version should run within the timeout");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("git version"));
    }
}
