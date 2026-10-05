/**
 * Git operations wrapper for Tauri backend.
 *
 * Provides TypeScript types and functions for interacting with
 * git status and change detection.
 *
 * @module lib/git
 */

import { invoke } from '@tauri-apps/api/core';

/** Status type for a changed file */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

/** A file with uncommitted changes */
export interface ChangedFile {
  /** Relative file path from project root */
  path: string;
  /** Change type */
  status: ChangeStatus;
  /** Added line count, or null when the file is binary or unreadable. */
  additions?: number | null;
  /** Deleted line count, or null when the file is binary or unreadable. */
  deletions?: number | null;
}

/** Changed files and line totals for the push dropdown. Null totals mean at
 * least one file could not be counted accurately. */
export interface ChangedFileSummary {
  files: ChangedFile[];
  additions: number | null;
  deletions: number | null;
}

/** Diff information for a single file */
export interface FileDiff {
  /** Relative file path from project root */
  filePath: string;
  /** True if this is a newly added/untracked file */
  isNewFile: boolean;
  /** True if the file was deleted */
  isDeleted: boolean;
  /** True if this is a binary file */
  isBinary: boolean;
  /** The raw diff content (or full file content for new files) */
  content: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
}

/**
 * Current branch relationship to its configured Git upstream.
 * `ahead` and `behind` are null unless Git produced a trustworthy comparison.
 */
export interface GitSyncStatus {
  status:
    | 'ready'
    | 'not-repository'
    | 'detached'
    | 'unborn'
    | 'no-remote'
    | 'no-upstream'
    | 'unknown';
  branch: string | null;
  remote: string | null;
  upstream: string | null;
  remotes: string[];
  ahead: number | null;
  behind: number | null;
  headSha: string | null;
  comparedUpstream: string | null;
  comparedUpstreamSha: string | null;
  /** Null means unavailable; [] is a confirmed branch with no outgoing commits. */
  outgoingCommits: GitOutgoingCommit[] | null;
  outgoingComparison: 'upstream' | 'remote-known-branches' | null;
  outgoingComparisonLabel: string | null;
  outgoingCount: number | null;
}

export interface GitOutgoingCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

/** Message generated through the team summary and secret-check path. */
export interface CommitMessageSuggestion {
  message: string;
  /** Agent that wrote the message, if a real agent produced it. */
  agent: string | null;
}

/**
 * Gets list of files with uncommitted changes in a project.
 *
 * Uses porcelain status to get staged, unstaged and untracked files.
 *
 * @param projectPath - Absolute path to the project
 * @returns Array of changed files with their status
 */
export async function getChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>('get_changed_files', { projectPath });
}

/** Get a fresh changed-file list with reliable aggregate line counts. */
export async function getChangedFileSummary(projectPath: string): Promise<ChangedFileSummary> {
  return invoke<ChangedFileSummary>('get_changed_file_summary', { projectPath });
}

/** Read branch/upstream counts without fetching or inferring unavailable data. */
export async function getGitSyncStatus(
  projectPath: string,
  destinationRemote?: string | null
): Promise<GitSyncStatus> {
  return invoke<GitSyncStatus>('get_git_sync_status', {
    projectPath,
    destinationRemote: destinationRemote ?? null,
  });
}

/**
 * Ask the team summary path for an editable commit message. This runs the
 * secret gauntlet and returns an agent name only when an agent wrote it.
 */
export async function suggestCommitMessage(
  projectPath: string,
  expectedBranch?: string | null
): Promise<CommitMessageSuggestion> {
  return invoke<CommitMessageSuggestion>('suggest_commit_message', {
    projectPath,
    expectedBranch: expectedBranch ?? null,
  });
}

/**
 * Gets the diff for a single uncommitted file.
 *
 * @param projectPath - Absolute path to the project
 * @param filePath - Relative path to the file from project root
 * @returns Diff information including raw diff content
 */
export async function getFileDiff(projectPath: string, filePath: string): Promise<FileDiff> {
  return invoke<FileDiff>('get_file_diff', { projectPath, filePath });
}

/**
 * Pull latest changes from remote.
 *
 * @param projectPath - Absolute path to the project
 */
export async function gitPull(projectPath: string): Promise<void> {
  return invoke<void>('git_pull', { projectPath });
}

/**
 * Stage all changes and create a commit.
 *
 * @param projectPath - Absolute path to the project
 * @param message - Commit message
 * @returns true if a commit was made, false if nothing to commit
 */
export async function commitChanges(
  projectPath: string,
  message: string,
  options: { agent?: string | null; expectedBranch?: string | null } = {}
): Promise<boolean> {
  return invoke<boolean>('commit_changes', {
    projectPath,
    message,
    agent: options.agent ?? null,
    expectedBranch: options.expectedBranch ?? null,
  });
}

/**
 * Stash all current changes (tracked + untracked) so the working tree is clean.
 * A plain `git stash` set aside for manual restore (`git stash pop`) — not the
 * metadata-tracked auto-stash that branch switching uses.
 *
 * @param projectPath - Absolute path to the project
 * @returns true if something was stashed, false if the tree was already clean
 */
export async function stashChanges(projectPath: string): Promise<boolean> {
  return invoke<boolean>('stash_changes', { projectPath });
}
