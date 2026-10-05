import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { commitChanges } from '../../lib/git';
import { pushCurrentBranch } from '../../lib/branches';
import { CommitChangesModal, type CommitIntent } from './CommitChangesModal';

vi.mock('../../lib/git', () => ({
  commitChanges: vi.fn(),
  suggestCommitMessage: vi.fn(),
}));

vi.mock('../../lib/branches', () => ({
  pushCurrentBranch: vi.fn(),
}));

const props = {
  projectPath: '/repo',
  expectedBranch: 'main',
  changedFiles: [{ path: 'src/app.ts', status: 'modified' as const }],
  syncStatus: {
    status: 'ready' as const,
    branch: 'main',
    remote: 'origin',
    upstream: 'origin/main',
    remotes: ['origin'],
    ahead: 1,
    behind: 0,
    headSha: 'abcdef0123456789abcdef0123456789abcdef01',
    comparedUpstream: 'origin/main',
    comparedUpstreamSha: '1234567890abcdef1234567890abcdef12345678',
    outgoingCommits: [
      {
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        shortSha: 'abcdef0',
        subject: 'Update project content',
      },
    ],
    outgoingComparison: 'upstream' as const,
    outgoingComparisonLabel: 'origin/main',
    outgoingCount: 1,
  },
  onStatusChange: vi.fn().mockResolvedValue(undefined),
  onPushComplete: vi.fn(),
};

function OpenCommitModal({ intent }: { intent: CommitIntent }) {
  const modal = useModal('commitChanges');
  useEffect(() => modal.open(), [modal.open]);
  return <CommitChangesModal {...props} intent={intent} />;
}

function renderCommitModal(intent: CommitIntent) {
  return render(
    <ModalProvider>
      <OpenCommitModal intent={intent} />
    </ModalProvider>
  );
}

describe('CommitChangesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commitChanges).mockResolvedValue(true);
  });

  it('creates a local commit without pushing', async () => {
    renderCommitModal('local');
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'Add pricing details' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit locally' }));

    await waitFor(() =>
      expect(commitChanges).toHaveBeenCalledWith('/repo', 'Add pricing details', {
        agent: null,
        expectedBranch: 'main',
      })
    );
    expect(pushCurrentBranch).not.toHaveBeenCalled();
    expect(props.onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful local commit and retries only the push after a push failure', async () => {
    const pushed = {
      branch: 'main',
      remote: 'origin',
      upstream: 'origin/main',
      commitSha: '9f3c1ab7d2e40518c6b9a7f0d4e2c8b1a5f60937',
    };
    vi.mocked(pushCurrentBranch)
      .mockRejectedValueOnce(new Error('remote unavailable'))
      .mockResolvedValueOnce(pushed);

    renderCommitModal('commit-and-push');
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'Add pricing details' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit & Push' }));

    expect(await screen.findByText('Committed locally; push failed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry Push' })).toBeEnabled();
    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(pushCurrentBranch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry Push' }));
    await waitFor(() => expect(props.onPushComplete).toHaveBeenCalledWith(pushed));
    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(pushCurrentBranch).toHaveBeenCalledTimes(2);
  });

  it('does not push if a commit hook rejects the local commit', async () => {
    vi.mocked(commitChanges).mockRejectedValueOnce(new Error('pre-commit hook failed'));
    renderCommitModal('commit-and-push');
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'Add pricing details' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit & Push' }));

    expect(await screen.findByText('pre-commit hook failed')).toBeInTheDocument();
    expect(pushCurrentBranch).not.toHaveBeenCalled();
  });
});
