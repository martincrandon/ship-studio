import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import type { ProjectGitHubStatus } from '../../lib/github';
import type { GitSyncStatus } from '../../lib/git';
import {
  pushCurrentBranch,
  switchBranch,
  type PushResult,
  type SwitchResult,
} from '../../lib/branches';

vi.mock('../../lib/branches', () => ({
  pushCurrentBranch: vi.fn(),
  switchBranch: vi.fn(),
}));

vi.mock('../hosting/HostingSection', () => ({
  HostingSection: ({
    pushedCommitSha,
    pushedBranch,
  }: {
    pushedCommitSha?: string;
    pushedBranch?: string;
  }) => (
    <section className="publish-hosting-section" aria-label="Hosting">
      <span>Hosting</span>
      <span data-testid="hosting-push-target">
        {pushedCommitSha && pushedBranch
          ? `${pushedBranch}:${pushedCommitSha}`
          : 'No pushed commit'}
      </span>
    </section>
  ),
}));

const connectedStatus = {
  status: 'connected',
  github_repo: 'user/repo',
} as unknown as ProjectGitHubStatus;

const readyStatus = {
  status: 'ready',
  branch: 'main',
  remote: 'origin',
  upstream: 'origin/main',
  remotes: ['origin'],
  ahead: 2,
  behind: 1,
  headSha: 'abcdef0123456789abcdef0123456789abcdef01',
  comparedUpstream: 'origin/main',
  comparedUpstreamSha: '1234567890abcdef1234567890abcdef12345678',
  outgoingCommits: [
    {
      sha: 'abcdef0123456789abcdef0123456789abcdef01',
      shortSha: 'abcdef0',
      subject: 'Update project content',
    },
    {
      sha: 'fedcba9876543210fedcba9876543210fedcba98',
      shortSha: 'fedcba9',
      subject: 'Adjust page layout',
    },
  ],
  outgoingComparison: 'upstream',
  outgoingComparisonLabel: 'origin/main',
  outgoingCount: 2,
} satisfies GitSyncStatus;

const pushedResult: PushResult = {
  branch: 'main',
  remote: 'origin',
  upstream: 'origin/main',
  commitSha: '9f3c1ab7d2e40518c6b9a7f0d4e2c8b1a5f60937',
};

function makeProps(overrides?: Partial<Parameters<typeof PublishBranchDropdown>[0]>) {
  return {
    currentBranch: 'main',
    projectGithubStatus: connectedStatus,
    projectPath: '/test/path',
    changedFiles: [],
    syncStatus: readyStatus,
    statusLoaded: true,
    onStatusChange: vi.fn(),
    isPublishing: false,
    setIsPublishing: vi.fn(),
    ...overrides,
  };
}

describe('PublishBranchDropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pushCurrentBranch).mockResolvedValue(pushedResult);
  });

  it('switches the working branch safely before enabling a commit to the selected branch', async () => {
    let finishSwitch!: (result: SwitchResult) => void;
    vi.mocked(switchBranch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSwitch = resolve;
        })
    );
    const onBranchSwitch = vi.fn();
    const props = makeProps({
      onBranchSwitch,
      changedFiles: [{ path: 'src/app.tsx', status: 'modified' }],
      branches: [
        {
          name: 'feature/destination',
          isCurrent: false,
          isRemote: false,
          isDefault: false,
          lastCommitDate: 0,
          lastCommitAuthor: 'Developer',
          aheadOfMain: 0,
          behindOfMain: 0,
          pushed: false,
        },
      ],
    });
    const { rerender } = render(<PublishBranchDropdown {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'Save these changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit to main' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'feature/destination' }));
    expect(switchBranch).toHaveBeenCalledWith('/test/path', 'feature/destination', false, true);
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(onBranchSwitch).not.toHaveBeenCalled();
    finishSwitch({
      success: true,
      stashedChanges: false,
      pendingStashFrom: null,
      stashApplied: false,
      error: null,
    });
    await waitFor(() => expect(onBranchSwitch).toHaveBeenCalledWith('feature/destination'));
    rerender(
      <PublishBranchDropdown
        {...props}
        currentBranch="feature/destination"
        syncStatus={{ ...readyStatus, branch: 'feature/destination', behind: 0 }}
      />
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
      'Save these changes'
    );
    expect(
      screen.getByRole('button', { name: 'Commit to feature/destination' })
    ).toBeInTheDocument();
  });

  it('keeps the Push trigger label and reports Git state separately', () => {
    render(<PublishBranchDropdown {...makeProps()} />);

    expect(screen.getByRole('button', { name: /push/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));

    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('2 commits to push')).toBeInTheDocument();
    expect(screen.getByText('Pull and resolve remote changes before pushing.')).toBeInTheDocument();
    expect(screen.getByText('Hosting')).toBeInTheDocument();
    expect(screen.queryByText(/go live|will deploy/i)).not.toBeInTheDocument();
  });

  it('shows changed and untracked files alongside local commit controls', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          changedFiles: [
            { path: 'src/app.tsx', status: 'modified' },
            { path: 'src/NewPanel.tsx', status: 'untracked' },
          ],
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByText('2 uncommitted changes')).toBeInTheDocument();
    expect(screen.getByText('NewPanel.tsx')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Commit message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeInTheDocument();
    expect(pushCurrentBranch).not.toHaveBeenCalled();
  });

  it('pushes existing commits without changing the visible worktree files', async () => {
    const onPushComplete = vi.fn();
    const props = makeProps({
      changedFiles: [{ path: 'src/app.tsx', status: 'modified' }],
      syncStatus: { ...readyStatus, behind: 0 },
      onPushComplete,
    });
    render(<PublishBranchDropdown {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    const pushButtons = screen.getAllByRole('button', { name: 'Push' });
    fireEvent.click(pushButtons[1]);

    await waitFor(() => expect(onPushComplete).toHaveBeenCalledWith(pushedResult));
    expect(pushCurrentBranch).toHaveBeenCalledWith('/test/path', undefined, 'main');
    expect(screen.getByText('app.tsx')).toBeInTheDocument();
    expect(screen.getByText(/Pushed 9f3c1ab to origin\/main/)).toBeInTheDocument();
  });

  it('keeps unknown commit counts unknown', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          syncStatus: {
            ...readyStatus,
            status: 'unknown',
            ahead: null,
            behind: null,
            headSha: 'abcdef0123456789abcdef0123456789abcdef01',
            comparedUpstream: null,
            comparedUpstreamSha: null,
            outgoingCommits: null,
            outgoingComparison: null,
            outgoingComparisonLabel: null,
            outgoingCount: null,
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByText('Couldn’t check commits to push.')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t verify that this branch can be pushed.')).toBeInTheDocument();
    expect(screen.queryByText(/0 commits|Up to date/)).not.toBeInTheDocument();
  });

  it('reports a behind-only branch accurately instead of claiming it is up to date', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          syncStatus: {
            ...readyStatus,
            ahead: 0,
            behind: 3,
            outgoingCommits: [],
            outgoingCount: 0,
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByText(/3 commits behind/)).toBeInTheDocument();
    expect(screen.queryByText(/Up to date/)).not.toBeInTheDocument();
  });

  it('automatically selects the only configured remote for a branch without an upstream', async () => {
    const { container } = render(
      <PublishBranchDropdown
        {...makeProps({
          syncStatus: {
            ...readyStatus,
            status: 'no-upstream',
            remote: null,
            upstream: null,
            ahead: null,
            behind: null,
            remotes: ['origin'],
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByRole('button', { name: 'Push this branch to origin' })).toBeInTheDocument();
    expect(container.querySelector('.publish-remote-status-row')).not.toBeInTheDocument();
    expect(
      container
        .querySelector('.publish-dropdown-footer button')
        ?.querySelector('[data-icon-name="PushIcon"]')
    ).toBeInTheDocument();
    const pushButtons = screen.getAllByRole('button', { name: 'Push' });
    fireEvent.click(pushButtons[1]);

    await waitFor(() =>
      expect(pushCurrentBranch).toHaveBeenCalledWith('/test/path', 'origin', 'main')
    );
  });

  it('keeps the Remote action when the footer also needs to commit local changes', () => {
    const { container } = render(
      <PublishBranchDropdown
        {...makeProps({
          changedFiles: [{ path: 'src/app.tsx', status: 'modified' }],
          syncStatus: {
            ...readyStatus,
            status: 'no-upstream',
            remote: null,
            upstream: null,
            ahead: null,
            behind: null,
            remotes: ['origin'],
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));

    expect(container.querySelector('.publish-remote-status-row')).toBeInTheDocument();
    expect(container.querySelector('.publish-dropdown-footer button')).toHaveTextContent(
      'Commit & Push'
    );
    expect(
      container
        .querySelector('.publish-dropdown-footer button')
        ?.querySelector('[data-icon-name="PushIcon"]')
    ).not.toBeInTheDocument();
  });

  it('requires an explicit configured remote when the branch has no upstream', async () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          syncStatus: {
            status: 'no-upstream',
            branch: 'feature/table',
            remote: null,
            upstream: null,
            remotes: ['origin', 'backup'],
            ahead: null,
            behind: null,
            headSha: 'abcdef0123456789abcdef0123456789abcdef01',
            comparedUpstream: null,
            comparedUpstreamSha: null,
            outgoingCommits: null,
            outgoingComparison: null,
            outgoingComparisonLabel: null,
            outgoingCount: null,
          },
          currentBranch: 'feature/table',
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    const destination = screen.getByLabelText('Push this branch to');
    fireEvent.change(destination, { target: { value: 'backup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Push to backup' }));

    await waitFor(() =>
      expect(pushCurrentBranch).toHaveBeenCalledWith('/test/path', 'backup', 'feature/table')
    );
  });

  it('passes the returned commit SHA and branch into Hosting after a push', async () => {
    const onPushComplete = vi.fn();
    const props = makeProps({ syncStatus: { ...readyStatus, behind: 0 }, onPushComplete });
    const { rerender } = render(<PublishBranchDropdown {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Push' })[1]);
    await waitFor(() => expect(onPushComplete).toHaveBeenCalledWith(pushedResult));

    rerender(
      <PublishBranchDropdown {...props} lastPush={{ result: pushedResult, pushedAt: Date.now() }} />
    );
    expect(screen.getByTestId('hosting-push-target')).toHaveTextContent(
      `main:${pushedResult.commitSha}`
    );
  });

  it('keeps local and Git sections available when there is no configured remote', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          syncStatus: {
            status: 'no-remote',
            branch: 'main',
            remote: null,
            upstream: null,
            remotes: [],
            ahead: null,
            behind: null,
            headSha: null,
            comparedUpstream: null,
            comparedUpstreamSha: null,
            outgoingCommits: null,
            outgoingComparison: null,
            outgoingComparisonLabel: null,
            outgoingCount: null,
          },
          projectGithubStatus: { status: 'no_repo' } as unknown as ProjectGitHubStatus,
          gitSetupAction: <button type="button">Connect Git</button>,
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Git' })).toBeInTheDocument();
    expect(
      screen.getByText('No Git remote is configured. Connect one before pushing commits.')
    ).toBeInTheDocument();
    expect(screen.getByText('Hosting')).toBeInTheDocument();
  });

  it('keeps Hosting out of the compact menu while preserving local and Git state', () => {
    render(<PublishBranchDropdown {...makeProps({ hideHosting: true })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.queryByText('Hosting')).not.toBeInTheDocument();
  });
});
