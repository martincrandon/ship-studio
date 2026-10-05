import { useState } from 'react';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import {
  commitChanges,
  suggestCommitMessage,
  type ChangedFile,
  type GitSyncStatus,
} from '../../lib/git';
import { pushCurrentBranch, type PushResult } from '../../lib/branches';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { TextArea } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';

export type CommitIntent = 'local' | 'commit-and-push';

interface Props {
  projectPath: string;
  /** Captured when the user opened the dialog; the backend rejects a stale branch. */
  expectedBranch: string | null;
  /** `null` means the changed-file query failed or has not completed. */
  changedFiles: ChangedFile[] | null;
  syncStatus: GitSyncStatus | null;
  intent: CommitIntent;
  onStatusChange: () => void | Promise<void>;
  onPushComplete: (result: PushResult) => void;
}

type CommitRequest = {
  intent: CommitIntent;
  message: string;
  agent: string | null;
  branch: string;
  remote?: string;
};

type PushOnlyRequest = {
  intent: 'push-only';
  branch: string;
  remote?: string;
  committed: true;
};

type OperationRequest = CommitRequest | PushOnlyRequest;

type OperationResult =
  | { kind: 'committed' }
  | { kind: 'nothing-to-commit' }
  | { kind: 'pushed'; result: PushResult; committed: boolean }
  | { kind: 'push-failed'; message: string; committed: boolean };

function getErrorMessage(error: unknown): string {
  return formatCommandError(asCommandError(error));
}

export function CommitChangesModal({
  projectPath,
  expectedBranch,
  changedFiles,
  syncStatus,
  intent,
  onStatusChange,
  onPushComplete,
}: Props) {
  const modal = useModal('commitChanges');
  const { showToast } = useOptionalToast();
  const [message, setMessage] = useState('');
  const [messageAgent, setMessageAgent] = useState<string | null>(null);
  const [selectedRemote, setSelectedRemote] = useState('');

  const suggestion = useAsyncState((path: string, branch: string | null) =>
    suggestCommitMessage(path, branch)
  );
  const refreshStatus = async () => {
    try {
      await onStatusChange();
    } catch {
      // Refresh is best-effort; it must never turn a successful Git operation
      // into a failed commit or push result.
    }
  };
  const operation = useAsyncState(async (request: OperationRequest): Promise<OperationResult> => {
    if (request.intent === 'push-only') {
      try {
        const result = await pushCurrentBranch(projectPath, request.remote, request.branch);
        await refreshStatus();
        return { kind: 'pushed', result, committed: request.committed };
      } catch (error) {
        return {
          kind: 'push-failed',
          message: getErrorMessage(error),
          committed: request.committed,
        };
      }
    }

    let committed: boolean;
    try {
      committed = await commitChanges(projectPath, request.message, {
        agent: request.agent,
        expectedBranch: request.branch,
      });
    } catch (error) {
      await refreshStatus();
      throw error;
    }

    if (!committed && request.intent === 'local') {
      return { kind: 'nothing-to-commit' };
    }

    await refreshStatus();
    if (request.intent === 'local') return { kind: 'committed' };

    try {
      const result = await pushCurrentBranch(projectPath, request.remote, request.branch);
      await refreshStatus();
      return { kind: 'pushed', result, committed };
    } catch (error) {
      await refreshStatus();
      return { kind: 'push-failed', message: getErrorMessage(error), committed };
    }
  });

  const filesKnown = changedFiles !== null;
  const changeCount = changedFiles?.length ?? null;
  const isGitRepo = syncStatus?.status !== 'not-repository' && syncStatus?.status !== 'detached';
  const canCommit =
    filesKnown &&
    (changeCount ?? 0) > 0 &&
    isGitRepo &&
    expectedBranch !== null &&
    syncStatus?.branch === expectedBranch;
  const branchIsCurrent = expectedBranch !== null && syncStatus?.branch === expectedBranch;
  const hasConfiguredUpstream = Boolean(syncStatus?.upstream);
  const remotes = syncStatus?.remotes ?? [];
  const maySelectRemote = syncStatus?.status === 'no-upstream' || syncStatus?.status === 'unborn';
  const selectedTarget = maySelectRemote ? selectedRemote || undefined : undefined;
  const canPushAfterCommit =
    branchIsCurrent &&
    (syncStatus?.status !== 'ready' || syncStatus.behind === 0) &&
    (hasConfiguredUpstream || (maySelectRemote && selectedTarget !== undefined));
  const isBehindUpstream = syncStatus?.status === 'ready' && (syncStatus.behind ?? 0) > 0;
  const combinedPushFailed = operation.data?.kind === 'push-failed' && operation.data.committed;
  const pushDestination =
    syncStatus?.upstream ?? selectedTarget ?? (syncStatus?.remote ? syncStatus.remote : null);

  const handleClose = () => {
    if (operation.isLoading) return;
    modal.close();
    setMessage('');
    setMessageAgent(null);
    setSelectedRemote('');
    suggestion.reset();
    operation.reset();
  };

  const handleGenerate = async () => {
    const result = await suggestion.execute(projectPath, expectedBranch);
    if (!result) return;
    setMessage(result.message);
    setMessageAgent(result.agent);
  };

  const finish = (result: OperationResult | null) => {
    if (!result) return;
    switch (result.kind) {
      case 'committed':
        showToast('Committed locally', 'success');
        handleClose();
        return;
      case 'nothing-to-commit':
        showToast('There are no uncommitted changes to commit', 'info');
        handleClose();
        return;
      case 'pushed':
        onPushComplete(result.result);
        showToast(
          result.committed ? 'Committed locally and pushed' : 'Pushed existing commits',
          'success'
        );
        handleClose();
        return;
      case 'push-failed':
        if (result.committed) {
          showToast('Committed locally; push failed', 'info');
        }
        return;
    }
  };

  const handleSubmit = async () => {
    if (!canCommit || !expectedBranch || !message.trim()) return;
    const result = await operation.execute({
      intent,
      message: message.trim(),
      agent: messageAgent,
      branch: expectedBranch,
      remote: selectedTarget,
    });
    finish(result);
  };

  const handleRetryPush = async () => {
    if (!expectedBranch) return;
    const result = await operation.execute({
      intent: 'push-only',
      branch: expectedBranch,
      remote: selectedTarget,
      committed: true,
    });
    finish(result);
  };

  const isBusy = operation.isLoading;
  const currentBranchChanged = syncStatus !== null && syncStatus.branch !== expectedBranch;

  return (
    <ModalFrame
      isOpen={modal.isOpen}
      onClose={handleClose}
      dismissable={!isBusy}
      title={intent === 'commit-and-push' ? 'Commit & Push' : 'Commit locally'}
      className="commit-changes-modal"
    >
      <div className="commit-changes-body">
        <p className="commit-changes-scope">
          {changeCount === null
            ? 'Couldn’t check which files have changed.'
            : changeCount === 1
              ? '1 changed file will be included.'
              : `${changeCount} changed files will be included.`}{' '}
          All current changes will be staged together.
        </p>

        {changedFiles && changedFiles.length > 0 && (
          <ul className="commit-changes-file-list" aria-label="Files included in this commit">
            {changedFiles.map((file) => (
              <li key={`${file.status}:${file.path}`}>
                <span className={`commit-file-status commit-file-status--${file.status}`}>
                  {file.status === 'added' || file.status === 'untracked'
                    ? '+'
                    : file.status === 'deleted'
                      ? '−'
                      : file.status === 'renamed'
                        ? 'R'
                        : 'M'}
                </span>
                <span>{file.path}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="commit-message-label-row">
          <label htmlFor="commit-message">Commit message</label>
          <TextButton
            onClick={() => void handleGenerate()}
            disabled={!filesKnown || !canCommit || suggestion.isLoading || isBusy}
          >
            {suggestion.isLoading ? 'Generating…' : 'Suggest message'}
          </TextButton>
        </div>
        <TextArea
          id="commit-message"
          rows={3}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setMessageAgent(null);
          }}
          placeholder="Describe the changes in this commit"
          disabled={isBusy}
          autoFocus
        />
        {suggestion.error && (
          <p className="commit-changes-note" role="status">
            Couldn’t generate a suggestion. You can still write the message yourself.
          </p>
        )}
        {messageAgent && <p className="commit-changes-note">Suggested by {messageAgent}.</p>}

        {maySelectRemote && intent === 'commit-and-push' && (
          <label className="commit-remote-field">
            Push the new commit to
            <select
              className="commit-remote-select ss-text-field"
              value={selectedRemote}
              onChange={(event) => setSelectedRemote(event.target.value)}
              disabled={isBusy}
            >
              <option value="">Choose a remote…</option>
              {remotes.map((remote) => (
                <option key={remote} value={remote}>
                  {remote}
                </option>
              ))}
            </select>
          </label>
        )}

        {intent === 'local' && (
          <p className="commit-changes-note">
            This records a local Git commit. It does not send changes to a remote or start a
            deployment.
          </p>
        )}
        {intent === 'commit-and-push' && pushDestination && (
          <p className="commit-changes-note">After committing, push to {pushDestination}.</p>
        )}
        {currentBranchChanged && expectedBranch && (
          <p className="commit-changes-error" role="alert">
            The current branch changed. Close this dialog and review the new branch before
            continuing.
          </p>
        )}
        {combinedPushFailed && operation.data?.kind === 'push-failed' && (
          <div className="commit-changes-partial" role="alert">
            <strong>Committed locally; push failed.</strong>
            <span>{operation.data.message}</span>
            <span>
              {isBehindUpstream
                ? `The remote is ahead by ${syncStatus?.behind} ${syncStatus?.behind === 1 ? 'commit' : 'commits'}. Pull and resolve those changes before retrying.`
                : 'Your commit is saved locally. Retry Push to send it when the remote is ready.'}
            </span>
          </div>
        )}
        {operation.error && (
          <p className="commit-changes-error" role="alert">
            {operation.error.message}
          </p>
        )}
      </div>

      <div className="commit-changes-actions">
        <Button variant="secondary" onClick={handleClose} disabled={isBusy}>
          Close
        </Button>
        {combinedPushFailed ? (
          <Button
            variant="primary"
            onClick={() => void handleRetryPush()}
            disabled={isBusy || !canPushAfterCommit}
          >
            {isBusy ? <Spinner size="sm" /> : 'Retry Push'}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={
              isBusy ||
              !canCommit ||
              !expectedBranch ||
              currentBranchChanged ||
              !message.trim() ||
              (intent === 'commit-and-push' && !canPushAfterCommit)
            }
          >
            {isBusy ? (
              <Spinner size="sm" />
            ) : intent === 'commit-and-push' ? (
              'Commit & Push'
            ) : (
              'Commit locally'
            )}
          </Button>
        )}
      </div>
    </ModalFrame>
  );
}
