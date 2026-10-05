/**
 * Modal for handling uncommitted changes when switching branches.
 *
 * Shows options to:
 * - Commit and push changes, then switch
 * - Discard changes and switch
 * - Cancel and stay on current branch
 *
 * @module components/UnsavedChangesModal
 */

import { useState } from 'react';
import { WarningIcon } from '@/components/icons';
import { discardChanges, pushBranch, switchBranch } from '../../lib/branches';
import { commitChanges, suggestCommitMessage } from '../../lib/git';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  asCommandError,
  formatCommandError,
  humanizeGitError,
  isRecognizedGitFailure,
} from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { ToastType } from '../../hooks/useToasts';

interface UnsavedChangesModalProps {
  /** Current branch name */
  currentBranch: string;
  /** Target branch to switch to */
  targetBranch: string;
  /** Project path for git operations */
  projectPath: string;
  /** Callback when switch completes successfully */
  onSwitchComplete: (branchName: string) => void;
  /** Callback to close the modal */
  onClose: () => void;
  /** Refresh the branch and source-control state after committing or pushing. */
  onRefresh?: () => void;
}

export function UnsavedChangesModal({
  currentBranch,
  targetBranch,
  projectPath,
  onSwitchComplete,
  onClose,
  onRefresh,
}: UnsavedChangesModalProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: ToastType) => showToast(message, type);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [hasLocalCommit, setHasLocalCommit] = useState(false);
  const [hasPushedCommit, setHasPushedCommit] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Toast a git failure without re-reporting it. Recognized conditions (a
   * push race the remote rejected, auth, network) are already classified
   * Expected on the backend and have nothing to do with an app malfunction —
   * an 'error' toast auto-files a bug report for each one (issue #726).
   */
  const toastGitFailure = (prefix: string, e: unknown) => {
    // git can fail with nothing to say; don't dress up an empty string.
    if (!e) {
      onToast(prefix, 'error');
      return;
    }
    const message = humanizeGitError(e, { branch: currentBranch, base: targetBranch });
    if (isRecognizedGitFailure(e, { branch: currentBranch, base: targetBranch })) {
      logger.warn('[UnsavedChanges] Action refused for a recognized reason', {
        error: formatCommandError(asCommandError(e)),
      });
      onToast(`${prefix}: ${message}`, 'info');
    } else {
      onToast(`${prefix}: ${message}`, 'error');
    }
  };

  // The working tree can pick up new changes between this modal's action and
  // the switch (dev-server config writes, background tooling), in which case
  // the switch fails again with "Uncommitted changes" — a dead end inside the
  // very modal meant to resolve it (issue #273). Retry once with auto-stash so
  // stragglers can't strand the user.
  const switchWithStashRetry = async () => {
    const result = await switchBranch(projectPath, targetBranch, false);
    if (!result.success && result.error?.includes('Uncommitted changes')) {
      return switchBranch(projectPath, targetBranch, true);
    }
    return result;
  };

  const handlePublishAndSwitch = async () => {
    setIsPublishing(true);
    setActionError(null);
    let committedLocally = hasLocalCommit;
    let pushed = hasPushedCommit;
    try {
      if (!committedLocally) {
        const suggestion = await suggestCommitMessage(projectPath, currentBranch);
        await commitChanges(projectPath, suggestion.message, {
          agent: suggestion.agent,
          expectedBranch: currentBranch,
        });
        committedLocally = true;
        setHasLocalCommit(true);
        onRefresh?.();
      }

      if (!pushed) {
        await pushBranch(projectPath, currentBranch);
        pushed = true;
        setHasPushedCommit(true);
        onRefresh?.();
        onToast(`Pushed ${currentBranch}`, 'success');
      }

      const result = await switchWithStashRetry();
      if (result.success) {
        onSwitchComplete(targetBranch);
        onClose();
      } else {
        const message = humanizeGitError(result.error, {
          branch: currentBranch,
          base: targetBranch,
        });
        setActionError(`The commit was pushed, but the branch switch failed: ${message}`);
        toastGitFailure('Failed to switch branch', result.error);
      }
    } catch (e) {
      const message = humanizeGitError(e, { branch: currentBranch, base: targetBranch });
      if (committedLocally && !pushed) {
        setHasLocalCommit(true);
        setActionError(`Committed locally; push failed: ${message} Retry will push that commit.`);
        toastGitFailure('Committed locally; push failed', e);
      } else if (!committedLocally) {
        // Commit hooks can stage or rewrite files before rejecting. Refresh the
        // branch view even though the commit did not complete, so its changed-
        // file list reflects the index/worktree Git left behind.
        onRefresh?.();
        setActionError(`Commit failed: ${message}`);
        toastGitFailure('Failed to commit', e);
      } else {
        setHasPushedCommit(true);
        setActionError(`The commit was pushed, but the branch switch failed: ${message}`);
        toastGitFailure('Failed to switch branch', e);
      }
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDiscardAndSwitch = async () => {
    setIsDiscarding(true);
    try {
      await discardChanges(projectPath);
      const result = await switchWithStashRetry();
      if (result.success) {
        onToast?.(`Switched to ${targetBranch}`, 'success');
        onSwitchComplete(targetBranch);
        onClose();
      } else {
        toastGitFailure('Failed to switch branch', result.error);
      }
    } catch (e) {
      toastGitFailure('Failed to discard changes', e);
    } finally {
      setIsDiscarding(false);
    }
  };

  const isLoading = isPublishing || isDiscarding;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      dismissable={!isLoading}
      className="unsaved-changes-content"
      title={
        <>
          <WarningIcon size={20} />
          <span>Uncommitted Changes</span>
        </>
      }
    >
      <div className="unsaved-changes-body">
        <p>
          You have uncommitted changes on <strong>{currentBranch}</strong>. Commit and push them
          before switching, or discard them.
        </p>
        {actionError && (
          <p className="unsaved-changes-error" role="alert">
            {actionError}
          </p>
        )}
      </div>
      <div className="unsaved-changes-actions">
        <Button variant="secondary" onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => void handleDiscardAndSwitch()}
          disabled={isLoading || hasLocalCommit}
          title={hasLocalCommit ? 'This change is already committed locally' : undefined}
        >
          {isDiscarding ? 'Discarding...' : 'Discard Changes'}
        </Button>
        <Button
          variant="primary"
          onClick={() => void handlePublishAndSwitch()}
          disabled={isLoading}
        >
          {isPublishing
            ? 'Working...'
            : hasPushedCommit
              ? 'Switch Branch'
              : hasLocalCommit
                ? 'Retry Push & Switch'
                : 'Commit & Push, then Switch'}
        </Button>
      </div>
    </ModalFrame>
  );
}
