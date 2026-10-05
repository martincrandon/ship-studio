/** The workspace source-control menu. Commits stay local until the user pushes. */

import { useState, useRef, useCallback, useEffect, useId, type ReactNode } from 'react';
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  ErrorIcon,
  FolderOpenIcon,
  GitBranchHorizontalIcon,
  PushIcon,
  SuccessIcon,
} from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  asCommandError,
  classifyGitPushError,
  formatCommandError,
  isRecognizedGitFailure,
} from '../../lib/errors';
import { logger } from '../../lib/logger';
import { trackError, trackEvent } from '../../lib/analytics';
import { remoteLabel, type ProjectGitHubStatus } from '../../lib/github';
import {
  discardChanges,
  pushCurrentBranch,
  switchBranch,
  type BranchInfo,
  type PushResult,
} from '../../lib/branches';
import {
  commitChanges,
  type ChangedFile,
  type ChangedFileSummary,
  type GitSyncStatus,
} from '../../lib/git';
import { Button } from '../primitives/Button';
import { MenuButton } from '../primitives/MenuButton';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { ChangedFilesSection, DiscardAllTextButton } from './ChangedFilesSection';
import { HostingSection } from '../hosting/HostingSection';

interface LastPush {
  result: PushResult;
  pushedAt: number;
}

interface PushRequest {
  branch: string;
  remote?: string;
}

function OutgoingCommitDisclosure({
  commits,
  count,
  label,
}: {
  commits: NonNullable<GitSyncStatus['outgoingCommits']>;
  count: number;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const summary = label ?? `${count} ${count === 1 ? 'commit' : 'commits'} to push`;

  return (
    <div className="publish-outgoing-commits">
      <button
        type="button"
        className="publish-outgoing-disclosure"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronIcon size={14} className="publish-outgoing-disclosure-icon" />
        <span>{summary}</span>
      </button>
      <ol id={listId} className="publish-outgoing-list" hidden={!expanded}>
        {commits.map((commit) => (
          <li className="publish-outgoing-commit" key={commit.sha}>
            <code>{commit.shortSha}</code>
            {commit.subject && <span>{commit.subject}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface PublishBranchDropdownProps {
  currentBranch: string | null;
  projectGithubStatus: ProjectGitHubStatus | null;
  projectPath: string;
  /** Kept optional for existing callers; sync state below is the source of truth. */
  hasChangesToSync?: boolean;
  onStatusChange: (destinationRemote?: string) => void;
  branches?: BranchInfo[];
  onBranchSwitch?: (branch: string) => void | Promise<void>;
  isBranchSwitching?: boolean;
  onModalClose?: () => void;
  isPublishing: boolean;
  setIsPublishing: (publishing: boolean) => void;
  onPublishError?: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  onCreatePR?: () => void;
  forceOpen?: boolean;
  onForceOpenHandled?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  grouped?: boolean;
  changedFiles?: ChangedFile[] | null;
  changedFileSummary?: ChangedFileSummary | null;
  changedFilesLoading?: boolean;
  syncStatus?: GitSyncStatus | null;
  /** Distinguishes a first check from a completed check that failed. */
  statusLoaded?: boolean;
  onDiscardChanges?: () => void;
  onPushComplete?: (result: PushResult) => void;
  lastPush?: LastPush | null;
  hideHosting?: boolean;
  gitSetupAction?: ReactNode;
  excludeClickOutsideSelector?: string;
}

let lastPushAt: number | null = null;

export function PublishBranchDropdown({
  currentBranch,
  projectGithubStatus,
  projectPath,
  onStatusChange,
  branches = [],
  onBranchSwitch,
  isBranchSwitching = false,
  onModalClose,
  isPublishing,
  setIsPublishing,
  onPublishError,
  onCreatePR,
  forceOpen,
  onForceOpenHandled,
  open: controlledOpen,
  onOpenChange,
  grouped = false,
  changedFiles = null,
  changedFileSummary = null,
  changedFilesLoading = false,
  syncStatus = null,
  statusLoaded = false,
  onDiscardChanges,
  onPushComplete,
  lastPush = null,
  hideHosting = false,
  gitSetupAction,
  excludeClickOutsideSelector,
}: PublishBranchDropdownProps) {
  const { showToast } = useOptionalToast();
  const [internalOpen, setInternalOpen] = useState(false);
  const [remoteChoice, setRemoteChoice] = useState<{ path: string; remote: string } | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [committedForPush, setCommittedForPush] = useState<{ path: string; branch: string } | null>(
    null
  );
  const [discardConfirmUntil, setDiscardConfirmUntil] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const configuredRemotes = syncStatus?.remotes ?? [];
  const chosenRemote = remoteChoice?.path === projectPath ? remoteChoice.remote : '';
  const selectedRemote = configuredRemotes.includes(chosenRemote)
    ? chosenRemote
    : configuredRemotes.length === 1
      ? configuredRemotes[0]
      : '';
  const targetLabel = syncStatus?.upstream ?? 'the remote';
  const projectLocation = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
  const gitService = remoteLabel(projectGithubStatus);
  const isOpen = controlledOpen ?? internalOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const pushAction = useAsyncState(
    async ({ branch, remote }: PushRequest) => pushCurrentBranch(projectPath, remote, branch),
    {
      onError: (error) => {
        const { message, errorType } = classifyGitPushError(error);
        const expectedFailure =
          errorType === 'push_rejected' ||
          errorType === 'merge_conflict' ||
          isRecognizedGitFailure(error, { branch: currentBranch ?? undefined });
        if (expectedFailure) {
          logger.warn('Push refused for a recognized Git state', {
            branch: currentBranch,
            errorType,
            message,
          });
          showToast(`Push failed: ${message}`, 'info');
        } else {
          logger.error('Push failed', { branch: currentBranch, errorType, message });
          trackError('git_push', error, 'Workspace');
          showToast(`Push failed: ${message}`, 'error');
        }
        onPublishError?.(message, errorType);
      },
    }
  );

  const commitAction = useAsyncState(
    async ({ message, branch }: { message: string; branch: string }) =>
      commitChanges(projectPath, message, { expectedBranch: branch }),
    {
      onError: (error) =>
        showToast(`Commit failed: ${formatCommandError(asCommandError(error))}`, 'error'),
    }
  );
  const discardAction = useAsyncState(() => discardChanges(projectPath), {
    onError: (error) =>
      showToast(`Failed to discard changes: ${formatCommandError(asCommandError(error))}`, 'error'),
  });
  const branchSwitchAction = useAsyncState(
    async (targetBranch: string) => {
      const result = await switchBranch(projectPath, targetBranch, false, true);
      if (!result.success) throw new Error(result.error ?? 'Couldn’t switch branches.');
      pushAction.reset();
      setCommittedForPush(null);
      await onBranchSwitch?.(targetBranch);
      onStatusChange();
      return result;
    },
    {
      onError: (error) => showToast(`Couldn’t change the commit branch: ${error.message}`, 'info'),
    }
  );

  const branch = syncStatus ? syncStatus.branch : currentBranch;
  const filesKnown = changedFiles !== null;
  const hasUncommittedFiles = filesKnown && (changedFiles?.length ?? 0) > 0;
  const canCommit =
    hasUncommittedFiles &&
    branch !== null &&
    branch === currentBranch &&
    !changedFilesLoading &&
    syncStatus?.status !== 'not-repository' &&
    syncStatus?.status !== 'detached';
  const canSelectRemote = syncStatus?.status === 'no-upstream' || syncStatus?.status === 'unborn';
  const selectedTarget = canSelectRemote ? selectedRemote || undefined : undefined;
  const hasConfiguredUpstream = Boolean(syncStatus?.upstream);
  const comparisonAllowsPush =
    (syncStatus?.status === 'ready' && syncStatus.behind === 0) ||
    syncStatus?.status === 'no-upstream';
  const canCommitAndPush =
    canCommit &&
    comparisonAllowsPush &&
    (hasConfiguredUpstream ||
      (syncStatus?.status === 'no-upstream' && selectedTarget !== undefined));
  const hasPushDestination = hasConfiguredUpstream || (canSelectRemote && !!selectedTarget);
  const hasKnownCommitsAhead = syncStatus?.status === 'ready' && (syncStatus.ahead ?? 0) > 0;
  const readyComparisonKnown =
    syncStatus?.status === 'ready' && syncStatus.ahead !== null && syncStatus.behind !== null;
  const canPush =
    branch !== null &&
    hasPushDestination &&
    comparisonAllowsPush &&
    (hasKnownCommitsAhead || (syncStatus?.status === 'no-upstream' && !!selectedTarget));
  const canRetryCommittedPush =
    branch !== null &&
    committedForPush !== null &&
    committedForPush.path === projectPath &&
    committedForPush.branch === branch &&
    hasPushDestination &&
    comparisonAllowsPush;
  const footerPushUsesRemoteAction = canRetryCommittedPush || (!hasUncommittedFiles && canPush);
  const isBusy =
    isPublishing ||
    isBranchSwitching ||
    branchSwitchAction.isLoading ||
    pushAction.isLoading ||
    commitAction.isLoading ||
    discardAction.isLoading;
  const isMainBranch = branch === 'main' || branch === 'master';
  const isGitHubRepo = projectGithubStatus?.status === 'connected';

  // Trigger mode briefly sets true then resets it; controlled mode stays in
  // sync with the header's exclusive-menu state.
  const prevForceOpenRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const previous = prevForceOpenRef.current;
    prevForceOpenRef.current = forceOpen;
    if (forceOpen) {
      // A command-palette request must open the header's controlled menu.
      // This effect is the bridge from that external request into its owner.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(true);
      onForceOpenHandled?.();
      prevForceOpenRef.current = false;
    } else if (previous === true && forceOpen === false) {
      setOpen(false);
    }
  }, [forceOpen, onForceOpenHandled, setOpen]);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    onModalClose?.();
  }, [onModalClose, setOpen]);
  const exclusions = excludeClickOutsideSelector
    ? `${excludeClickOutsideSelector}, .modal-frame-overlay, .cf-modal-overlay`
    : '.modal-frame-overlay, .cf-modal-overlay';
  useClickOutside(dropdownRef, closeDropdown, isOpen, exclusions);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        (event.target as HTMLElement).closest('.publish-remote-options, .publish-commit-branches')
      )
        return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setOpen]);

  useEffect(() => {
    if (!isOpen && pushAction.data) pushAction.reset();
  }, [isOpen, pushAction.data, pushAction.reset]);

  const handlePush = async () => {
    if (!branch || !hasPushDestination || (!canPush && !canRetryCommittedPush)) return;
    pushAction.reset();
    setIsPublishing(true);
    const result = await pushAction.execute({ branch, remote: selectedTarget });
    setIsPublishing(false);
    if (!result) {
      onStatusChange(selectedTarget);
      return;
    }
    setCommittedForPush(null);

    const now = Date.now();
    void trackEvent('branch_published', {
      is_main: isMainBranch,
      time_since_last_publish_seconds:
        lastPushAt !== null ? Math.round((now - lastPushAt) / 1000) : null,
      $screen_name: 'Workspace',
    });
    lastPushAt = now;
    showToast('Pushed existing commits', 'success');
    onPushComplete?.(result);
    onStatusChange(selectedTarget);
  };

  const handleInlineCommit = async () => {
    if (!branch || !canCommit || !commitMessage.trim() || isBusy) return;
    const committed = await commitAction.execute({ message: commitMessage.trim(), branch });
    if (committed === null) return;
    if (!committed) {
      showToast('There are no uncommitted changes to commit', 'info');
      onStatusChange();
      return;
    }
    setCommitMessage('');
    showToast('Committed locally', 'success');
    const refreshRemote =
      selectedRemote ||
      (syncStatus?.status === 'no-upstream' && syncStatus.remotes.length === 1
        ? syncStatus.remotes[0]
        : undefined);
    onStatusChange(refreshRemote);
  };

  const handleCommitAndPush = async () => {
    if (canRetryCommittedPush) {
      await handlePush();
      return;
    }
    if (!hasUncommittedFiles) {
      if (canPush && !isBusy) await handlePush();
      return;
    }
    if (!branch || !canCommitAndPush || isBusy) return;
    if (!commitMessage.trim()) return;

    const committed = await commitAction.execute({ message: commitMessage.trim(), branch });
    if (committed === null || committed === undefined) return;
    if (!committed) {
      showToast('There are no uncommitted changes to commit', 'info');
      return;
    }
    setCommitMessage('');
    setCommittedForPush({ path: projectPath, branch });
    onStatusChange(selectedTarget);
    if (!branch || !hasPushDestination) return;
    setIsPublishing(true);
    pushAction.reset();
    const result = await pushAction.execute({ branch, remote: selectedTarget });
    setIsPublishing(false);
    if (!result) {
      showToast('Committed locally; push failed. Retry Push to send the commit.', 'info');
      onStatusChange(selectedTarget);
      return;
    }
    setCommittedForPush(null);
    const now = Date.now();
    void trackEvent('branch_published', {
      is_main: isMainBranch,
      time_since_last_publish_seconds:
        lastPushAt !== null ? Math.round((now - lastPushAt) / 1000) : null,
      $screen_name: 'Workspace',
    });
    lastPushAt = now;
    showToast('Committed locally and pushed', 'success');
    onPushComplete?.(result);
    onStatusChange(selectedTarget);
  };

  const handleDiscardAll = async () => {
    if (discardAction.isLoading) return;
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      if (discardConfirmUntil) clearTimeout(discardConfirmUntil);
      setDiscardConfirmUntil(setTimeout(() => setConfirmDiscard(false), 3000));
      return;
    }
    if (discardConfirmUntil) clearTimeout(discardConfirmUntil);
    setConfirmDiscard(false);
    const result = await discardAction.execute();
    if (result !== null) {
      showToast('All changes discarded', 'success');
      onDiscardChanges?.();
      setCommitMessage('');
      onStatusChange();
    }
  };

  useEffect(
    () => () => {
      if (discardConfirmUntil) clearTimeout(discardConfirmUntil);
    },
    [discardConfirmUntil]
  );

  const getSyncDescription = () => {
    if (!statusLoaded) return 'Checking the Git remote…';
    if (!syncStatus) return 'Couldn’t check the Git remote status.';

    switch (syncStatus.status) {
      case 'not-repository':
        return 'This folder is not a Git repository.';
      case 'detached':
        return 'HEAD is detached. Switch to a branch before pushing.';
      case 'unborn':
        return 'This branch has no commits yet. Commit locally before pushing.';
      case 'no-remote':
        return 'No Git remote is configured. Connect one before pushing commits.';
      case 'no-upstream':
        return 'This branch has no upstream. Choose a remote to push it to.';
      case 'unknown':
        return syncStatus.upstream
          ? `Couldn’t compare commits with ${syncStatus.upstream}. You can still push existing commits.`
          : 'Couldn’t check whether there are commits to push.';
      case 'ready':
        if (syncStatus.ahead === null || syncStatus.behind === null) {
          return 'Couldn’t verify whether there are commits to push.';
        }
        if (syncStatus.ahead === 0 && syncStatus.behind === 0) {
          return hasUncommittedFiles
            ? 'No commits waiting to push. Commit your local changes first.'
            : 'No commits waiting to push.';
        }
        if (syncStatus.behind > 0) {
          return `${syncStatus.behind} ${syncStatus.behind === 1 ? 'commit' : 'commits'} behind ${targetLabel}. Pull and resolve before pushing.`;
        }
        if (syncStatus.ahead > 0) {
          return `${syncStatus.ahead} ${syncStatus.ahead === 1 ? 'commit' : 'commits'} waiting to push.`;
        }
        return (
          [
            syncStatus.ahead > 0
              ? `${syncStatus.ahead} ${syncStatus.ahead === 1 ? 'commit' : 'commits'} to push`
              : null,
            syncStatus.behind > 0
              ? `${syncStatus.behind} ${syncStatus.behind === 1 ? 'commit' : 'commits'} behind`
              : null,
          ]
            .filter(Boolean)
            .join(`; `) + ` ${targetLabel}.`
        );
    }
  };

  const triggerBusy = isBusy;
  const retryingCommittedPush = canRetryCommittedPush;
  const newBranchPushHelp = selectedTarget ? (
    <>
      Publishes this branch and its commits to the remote repository{' '}
      <span className="publish-remote-name">“{selectedTarget}”</span>. Future pushes use this
      destination.
    </>
  ) : (
    'Choose a remote repository before publishing this branch.'
  );
  const footerSummary = retryingCommittedPush
    ? 'Retries the push for the commit saved locally.'
    : hasUncommittedFiles
      ? 'Commits locally, then pushes.'
      : syncStatus?.status === 'no-upstream'
        ? newBranchPushHelp
        : 'Pushes existing commits.';
  const footerLabel = triggerBusy
    ? 'Pushing…'
    : retryingCommittedPush
      ? 'Retry Push'
      : hasUncommittedFiles
        ? 'Commit & Push'
        : 'Push';
  const footerDisabled =
    isBusy ||
    Boolean(pushAction.data) ||
    (retryingCommittedPush
      ? !canRetryCommittedPush
      : hasUncommittedFiles
        ? !canCommitAndPush || !commitMessage.trim()
        : !canPush);
  const footerTitle = footerDisabled
    ? hasUncommittedFiles && !commitMessage.trim()
      ? 'Enter a commit message first'
      : canSelectRemote && !selectedTarget
        ? 'Choose a remote before sending this branch'
        : syncStatus?.status === 'unborn'
          ? 'Commit locally before publishing the first commit'
          : syncStatus?.status === 'no-remote'
            ? 'Connect a Git remote before pushing'
            : syncStatus?.status === 'ready' && syncStatus.behind !== 0
              ? 'Pull and resolve remote changes before pushing'
              : syncStatus?.status === 'ready' && syncStatus.ahead === 0
                ? 'No commits waiting to push'
                : !readyComparisonKnown && syncStatus?.status !== 'no-upstream'
                  ? 'Couldn’t verify whether there are commits to push'
                  : undefined
    : undefined;
  const remotePushLabel = canRetryCommittedPush ? 'Retry Push' : 'Push';
  const remotePushDisabled =
    isBusy || Boolean(pushAction.data) || (!canRetryCommittedPush && !canPush);
  const hasFirstPushPreview =
    syncStatus?.status === 'no-upstream' &&
    syncStatus.outgoingComparison === 'remote-known-branches' &&
    syncStatus.outgoingCount !== null &&
    Boolean(syncStatus.outgoingComparisonLabel);
  const remoteOutgoingCount =
    syncStatus?.status === 'ready' && syncStatus.ahead !== null && syncStatus.behind !== null
      ? syncStatus.ahead
      : hasFirstPushPreview
        ? (syncStatus?.outgoingCount ?? null)
        : null;
  const remotePushTitle = canRetryCommittedPush
    ? 'Retry pushing the commit that was already created'
    : syncStatus?.status === 'ready' && syncStatus.ahead === 0
      ? syncStatus.behind === null
        ? 'Couldn’t verify whether there are commits to push'
        : syncStatus.behind > 0
          ? 'Pull and resolve remote changes before pushing'
          : hasUncommittedFiles
            ? 'Commit your local changes first'
            : 'No commits waiting to push'
      : syncStatus?.status === 'unknown' || syncStatus?.status === 'ready'
        ? 'Couldn’t verify whether there are commits to push'
        : syncStatus?.status === 'unborn'
          ? 'Commit locally before publishing the first commit'
          : syncStatus?.status === 'no-upstream' && !selectedTarget
            ? 'Choose a remote before sending this branch'
            : undefined;
  const remoteActionHelpId = useId();
  const remoteCountCopy = (() => {
    if (!statusLoaded) return 'Checking commits to push…';
    if (!syncStatus) return 'Couldn’t check commits to push.';
    if (syncStatus.status === 'ready') {
      if (syncStatus.ahead === null || syncStatus.behind === null) {
        return 'Couldn’t check commits to push.';
      }
      return `${syncStatus.ahead} ${syncStatus.ahead === 1 ? 'commit' : 'commits'} to push`;
    }
    if (
      syncStatus.status === 'no-upstream' &&
      syncStatus.outgoingComparison === 'remote-known-branches' &&
      syncStatus.outgoingCount !== null &&
      syncStatus.outgoingComparisonLabel
    ) {
      const count = syncStatus.outgoingCount;
      return `${count} ${count === 1 ? 'commit' : 'commits'} not on ${syncStatus.outgoingComparisonLabel}`;
    }
    if (syncStatus.status === 'unborn') return 'No commits to push yet.';
    if (syncStatus.status === 'no-upstream') return 'Commit count unavailable without an upstream.';
    if (syncStatus.status === 'no-remote') return 'Commit count unavailable without a Git remote.';
    if (syncStatus.status === 'detached') return 'Commit count unavailable in detached HEAD.';
    if (syncStatus.status === 'not-repository') {
      return 'Commit count unavailable outside a Git repository.';
    }
    return 'Couldn’t check commits to push.';
  })();
  const remoteActionHelp = canRetryCommittedPush
    ? `Send the locally saved commit to ${selectedTarget ?? targetLabel}.`
    : syncStatus?.status === 'no-upstream'
      ? newBranchPushHelp
      : syncStatus?.status === 'ready' && syncStatus.behind !== null && syncStatus.behind > 0
        ? 'Pull and resolve remote changes before pushing.'
        : syncStatus?.status === 'ready' &&
            (syncStatus.ahead === null || syncStatus.behind === null)
          ? 'Couldn’t verify that this branch can be pushed.'
          : syncStatus?.status === 'unknown'
            ? 'Couldn’t verify that this branch can be pushed.'
            : syncStatus?.status === 'ready' && syncStatus.ahead === 0
              ? 'The remote already has this branch.'
              : syncStatus?.status === 'ready' && syncStatus.ahead !== null && syncStatus.upstream
                ? `Send committed changes to ${syncStatus.upstream}.`
                : getSyncDescription();
  const remoteCount = !pushAction.data ? (
    <div className="publish-remote-count" aria-live="polite">
      {remoteOutgoingCount !== null && remoteOutgoingCount > 0 ? (
        syncStatus?.outgoingCommits && syncStatus.outgoingCommits.length > 0 ? (
          <OutgoingCommitDisclosure
            key={`${projectPath}:${syncStatus?.branch ?? ''}:${syncStatus?.outgoingComparison ?? ''}:${syncStatus?.outgoingComparisonLabel ?? ''}:${syncStatus?.comparedUpstream ?? ''}:${syncStatus?.headSha ?? ''}:${syncStatus?.comparedUpstreamSha ?? ''}`}
            commits={syncStatus.outgoingCommits}
            count={remoteOutgoingCount}
            label={remoteCountCopy}
          />
        ) : (
          <span>{remoteCountCopy}. Commit details unavailable.</span>
        )
      ) : (
        <span>{remoteCountCopy}</span>
      )}
    </div>
  ) : null;

  return (
    <div
      className={`publish-dropdown${grouped ? ' publish-dropdown--grouped' : ''}`}
      ref={dropdownRef}
    >
      <MenuButton
        ref={triggerRef}
        expanded={isOpen}
        variant="default"
        className={`${triggerBusy ? 'publishing ' : ''}source-control-push-button`}
        data-education-id="publish-button"
        onClick={() => setOpen(!isOpen)}
      >
        <span className="source-control-push-content">
          <PushIcon size={16} />
          <span>{triggerBusy ? 'Pushing…' : 'Push'}</span>
        </span>
        <ChevronIcon size={16} />
      </MenuButton>

      <div
        className="publish-dropdown-menu"
        role="dialog"
        aria-label="Source control"
        hidden={!isOpen}
      >
        <div className="publish-dropdown-content">
          <header className="publish-dropdown-heading">
            <div>
              <h2>Commit and Push</h2>
            </div>
          </header>
          <section className="publish-local-section" aria-labelledby="publish-local-heading">
            <div
              className="publish-section-heading"
              id="publish-local-heading"
              aria-label={`Local project ${projectPath}`}
            >
              <FolderOpenIcon size={14} />
              <span>Local</span>
              <strong title={projectPath}>{projectLocation}</strong>
            </div>
            <div className="publish-commit-destination">
              <span>Commit to</span>
              <Dropdown
                align="left"
                menuClassName="publish-commit-branches"
                trigger={(props) => (
                  <Button
                    {...props}
                    variant="ghost"
                    size="compact"
                    disabled={isBusy || !onBranchSwitch}
                    aria-label={`Commit to ${branch ?? 'a branch'}`}
                  >
                    <span>{branch ?? 'Choose a branch…'}</span>
                    <ChevronIcon size={12} />
                  </Button>
                )}
              >
                {Array.from(
                  new Set([...(branch ? [branch] : []), ...branches.map((item) => item.name)])
                ).map((name) => (
                  <DropdownItem
                    key={name}
                    active={name === branch}
                    icon={name === branch ? <CheckIcon size={12} /> : <BranchIcon size={12} />}
                    onSelect={() => {
                      if (name !== branch && !isBusy) void branchSwitchAction.execute(name);
                    }}
                  >
                    {name}
                  </DropdownItem>
                ))}
              </Dropdown>
            </div>
            <ChangedFilesSection
              key={`${projectPath}:${branch ?? ''}`}
              changedFiles={changedFiles}
              summary={changedFileSummary}
              loading={changedFilesLoading}
              projectPath={projectPath}
            />
            {changedFiles === null && !changedFilesLoading && (
              <TextButton onClick={() => onStatusChange()}>Retry file check</TextButton>
            )}
            {hasUncommittedFiles && (
              <div className="publish-local-commit">
                <div className="publish-commit-composer">
                  <TextField
                    className="publish-commit-message"
                    aria-label="Commit message"
                    placeholder="Write a commit message…"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    disabled={!canCommit || isBusy}
                  />
                  <Button
                    variant="default"
                    onClick={() => void handleInlineCommit()}
                    disabled={!canCommit || !commitMessage.trim() || isBusy}
                    title={
                      !canCommit ? 'Wait for the local Git status to finish checking' : undefined
                    }
                  >
                    Commit
                  </Button>
                </div>
                <div className="publish-commit-meta">
                  <p className="publish-commit-helper">Save these changes as a local commit.</p>
                  <DiscardAllTextButton
                    confirming={confirmDiscard}
                    isDiscarding={discardAction.isLoading}
                    onClick={() => void handleDiscardAll()}
                  />
                </div>
              </div>
            )}
          </section>

          <section className="publish-remote-section" aria-labelledby="publish-remote-heading">
            <div className="publish-section-heading" id="publish-remote-heading">
              <GitBranchHorizontalIcon size={14} />
              <span>Remote</span>
              {gitService && <strong>{gitService}</strong>}
            </div>

            <div className="publish-remote-summary">
              {syncStatus?.upstream && (
                <div className="publish-destination-context">
                  <span>Push to</span>
                  <strong>{syncStatus.upstream}</strong>
                </div>
              )}

              {footerPushUsesRemoteAction && remoteCount}

              {canSelectRemote && syncStatus && (
                <div className="publish-remote-destination">
                  <div className="publish-remote-select-label" id="publish-remote-select-label">
                    Push this branch to
                  </div>
                  <div className="publish-remote-select-row">
                    <Dropdown
                      align="left"
                      menuClassName="publish-remote-options publish-remote-picker"
                      trigger={(props) => (
                        <Button
                          {...props}
                          variant="default"
                          className="publish-remote-select-trigger"
                          aria-label={`Push this branch to ${selectedRemote || 'a remote'}`}
                        >
                          <BranchIcon size={12} />
                          <span className="publish-remote-select-value">
                            {selectedRemote || 'Choose a remote…'}
                          </span>
                          <ChevronIcon size={12} className="publish-remote-select-chevron" />
                        </Button>
                      )}
                    >
                      {syncStatus.remotes.map((remote) => (
                        <DropdownItem
                          key={remote}
                          active={selectedRemote === remote}
                          icon={selectedRemote === remote ? <CheckIcon size={12} /> : undefined}
                          onSelect={() => {
                            setRemoteChoice({ path: projectPath, remote });
                            onStatusChange(remote);
                          }}
                        >
                          {remote}
                        </DropdownItem>
                      ))}
                    </Dropdown>
                  </div>
                </div>
              )}

              {!footerPushUsesRemoteAction && (
                <div className="publish-remote-status-row">
                  <div className="publish-remote-status-copy" id={remoteActionHelpId}>
                    {remoteCount}
                    {pushAction.isLoading ? (
                      <div className="publish-in-progress-header">
                        <Spinner />
                        <span>Sending commits to {selectedTarget ?? targetLabel}…</span>
                      </div>
                    ) : pushAction.data ? (
                      <div className="publish-success">
                        <SuccessIcon />
                        <span>
                          Pushed {pushAction.data.commitSha.slice(0, 7)} to{' '}
                          {pushAction.data.upstream ??
                            `${pushAction.data.remote}/${pushAction.data.branch}`}
                          .
                        </span>
                      </div>
                    ) : pushAction.error ? (
                      <div className="publish-error" role="alert">
                        <div className="publish-error-header">
                          <ErrorIcon />
                          <span>Push failed</span>
                        </div>
                        <div className="publish-error-message">{pushAction.error.message}</div>
                        {classifyGitPushError(pushAction.error).errorType === 'push_rejected' && (
                          <div className="publish-error-guidance">
                            The remote has changes you don’t have. Pull and resolve them before
                            retrying.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="publish-branch-description">{remoteActionHelp}</div>
                    )}
                  </div>
                  <Button
                    variant="default"
                    className="publish-remote-status-action"
                    onClick={() => void handlePush()}
                    disabled={remotePushDisabled}
                    title={remotePushTitle}
                    aria-describedby={remoteActionHelpId}
                  >
                    {remotePushLabel}
                  </Button>
                </div>
              )}

              {statusLoaded && !syncStatus && (
                <TextButton onClick={() => onStatusChange()}>Retry Git status</TextButton>
              )}

              {syncStatus?.status === 'no-remote' && gitSetupAction && (
                <div className="publish-git-setup-action">{gitSetupAction}</div>
              )}
              {syncStatus?.status === 'no-remote' && !gitSetupAction && (
                <div className="publish-git-setup-copy">
                  {projectGithubStatus === null
                    ? 'Checking the Git connection…'
                    : 'Connect a remote to share commits. Local commits remain available without one.'}
                </div>
              )}
            </div>
            {pushAction.data && (
              <div className="publish-remote-actions">
                {!isMainBranch && isGitHubRepo && onCreatePR && (
                  <TextButton variant="primary" onClick={onCreatePR}>
                    Create a pull request…
                  </TextButton>
                )}
                <Button variant="secondary" onClick={() => pushAction.reset()}>
                  Done
                </Button>
              </div>
            )}
          </section>

          {!hideHosting && (
            <HostingSection
              projectPath={projectPath}
              open={isOpen}
              pushedAt={lastPush?.pushedAt}
              pushedCommitSha={lastPush?.result.commitSha}
              pushedBranch={lastPush?.result.branch}
            />
          )}
        </div>
        <footer className="publish-dropdown-footer">
          <span className="publish-footer-summary">{footerSummary}</span>
          <Button
            variant={footerLabel === 'Commit & Push' ? 'primary' : 'default'}
            onClick={() => void handleCommitAndPush()}
            disabled={footerDisabled}
            title={footerTitle}
          >
            {footerPushUsesRemoteAction ? (
              <span className="source-control-push-content">
                <PushIcon size={16} />
                <span>{footerLabel}</span>
              </span>
            ) : (
              footerLabel
            )}
          </Button>
        </footer>
      </div>
    </div>
  );
}
