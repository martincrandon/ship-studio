/**
 * Tests for PublishBranchDropdown.
 *
 * The core contract: the trigger button says "Push" at ALL times (or
 * "Pushing..." while in flight) — never "Sync", "Publish", "Synced", or
 * "Go Live". That label churn was a real UX complaint; these tests pin it.
 */

import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ModalProvider } from '../../contexts/ModalContext';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import type { ProjectGitHubStatus } from '../../lib/github';

vi.mock('../../lib/branches', () => ({
  publishBranch: vi.fn().mockResolvedValue({ state: 'PUSHED', url: null }),
  formatRelativeTime: () => 'just now',
}));

// The hosting section owns its own data now. These tests are about the
// popover's structure, so hold it in a single settled state.
const connectedStatus = {
  status: 'connected',
  github_repo: 'user/repo',
} as unknown as ProjectGitHubStatus;

function makeProps(overrides?: Partial<Parameters<typeof PublishBranchDropdown>[0]>) {
  return {
    currentBranch: 'main',
    projectGithubStatus: connectedStatus,
    projectPath: '/test/path',
    hasChangesToSync: true,
    onStatusChange: vi.fn(),
    isPublishing: false,
    setIsPublishing: vi.fn(),
    ...overrides,
  };
}

const BANNED_LABELS = ['Sync', 'Synced', 'Syncing...', 'Publish', 'Publishing...', 'Go Live'];

/**
 * The hosting section opens the deployments panel through ModalContext, which
 * the app always provides around this component. Rendering bare would test a
 * tree that never exists.
 */
function render(ui: ReactElement) {
  return rtlRender(<ModalProvider>{ui}</ModalProvider>);
}

function expectNoBannedLabels() {
  for (const label of BANNED_LABELS) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
}

function expectPushIcon() {
  expect(
    screen.getByRole('button', { name: /push/i }).querySelector('[data-icon-name="PushIcon"]')
  ).toBeTruthy();
}

describe('PublishBranchDropdown trigger label', () => {
  it('says "Push" on the main branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectPushIcon();
    expectNoBannedLabels();
  });

  it('says "Push" on a feature branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'feature/thing' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Push" even when there is nothing to push', () => {
    render(<PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Pushing..." while a push is in flight', () => {
    render(<PublishBranchDropdown {...makeProps({ isPublishing: true })} />);

    expect(screen.getByText('Pushing...')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('keeps the dropdown trigger enabled when no Git remote exists', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          projectGithubStatus: { status: 'no_repo' } as unknown as ProjectGitHubStatus,
        })}
      />
    );

    const button = screen.getByText('Push').closest('button');
    expect(button).toBeEnabled();
    expectPushIcon();
    expectNoBannedLabels();
  });

  it('keeps the icon visible while GitHub status is loading', () => {
    render(<PublishBranchDropdown {...makeProps({ projectGithubStatus: null })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectPushIcon();
  });
});

describe('PublishBranchDropdown open panel', () => {
  it('keeps Hosting available and disables only the push action when no remote exists', async () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          projectGithubStatus: { status: 'no_repo' } as unknown as ProjectGitHubStatus,
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));

    expect(await screen.findByText('Hosting')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Connect a Git remote to push commits. You can still review changes and manage hosting below.'
      )
    ).toBeInTheDocument();
    const pushButtons = screen.getAllByRole('button', { name: 'Push' });
    expect(pushButtons[0]).toBeEnabled();
    expect(pushButtons[pushButtons.length - 1]).toBeDisabled();
  });

  it('closes on outside click and Escape', () => {
    render(<PublishBranchDropdown {...makeProps()} />);

    const trigger = screen.getByRole('button', { name: 'Push' });
    fireEvent.click(trigger);
    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Push to GitHub')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Push to GitHub')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('uses push terminology throughout the idle panel (feature branch)', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'feature/thing' })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();
    // Trigger + primary action both say Push
    expect(screen.getAllByText('Push').length).toBeGreaterThanOrEqual(2);
    expectNoBannedLabels();
  });

  it('includes changed files and discard in the Push menu', () => {
    render(
      <PublishBranchDropdown
        {...makeProps()}
        changedFiles={[{ path: 'src/app.tsx', status: 'modified' }]}
      />
    );

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('1 Unsaved Change')).toBeInTheDocument();
    expect(screen.getByText('app.tsx')).toBeInTheDocument();
    expect(screen.getByText('Discard All')).toBeInTheDocument();
    const actionRow = screen.getByText('Discard All').closest('.publish-actions');
    const pushButtons = screen.getAllByRole('button', { name: 'Push' });
    expect(actionRow).toContainElement(pushButtons[pushButtons.length - 1]);
  });

  it('renders the hosting section inside the Push menu', async () => {
    render(<PublishBranchDropdown {...makeProps()} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('Hosting')).toBeInTheDocument();
    // And it reaches a real state rather than sitting on the spinner — the
    // default IPC mock reports a project that deploys nowhere.
    expect(await screen.findByText('See if each push went live')).toBeInTheDocument();
  });

  it('keeps the panel actions below the hosting section', () => {
    const { container } = render(<PublishBranchDropdown {...makeProps()} />);

    fireEvent.click(screen.getByText('Push'));

    const menu = container.querySelector('.publish-dropdown-menu');
    const hostingSection = menu?.querySelector('.publish-hosting-section');
    const actions = menu?.querySelector('.publish-actions');

    expect(hostingSection).toBeInTheDocument();
    expect(actions).toBeInTheDocument();
    expect(menu?.lastElementChild).toBe(actions);
  });

  it('keeps Done below the hosting section when GitHub is up to date', () => {
    const { container } = render(
      <PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />
    );

    fireEvent.click(screen.getByText('Push'));

    const menu = container.querySelector('.publish-dropdown-menu');
    const actions = menu?.querySelector('.publish-actions');

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(menu?.lastElementChild).toBe(actions);
  });

  it('never reaches into plugin DOM to force a menu open', () => {
    // The popover used to hold the Vercel/Cloudflare plugins' hover menus open
    // with a synthetic `mouseover` dispatched from a MutationObserver, so every
    // mouse-out collapsed and restored the whole panel.
    const observe = vi.fn();
    const original = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      observe = observe;
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    } as unknown as typeof MutationObserver;

    try {
      render(<PublishBranchDropdown {...makeProps()} />);
      fireEvent.click(screen.getByText('Push'));
      expect(observe).not.toHaveBeenCalled();
    } finally {
      globalThis.MutationObserver = original;
    }
  });

  it('can hide the hosting section where there is no room for it', () => {
    const { container } = render(<PublishBranchDropdown {...makeProps({ hideHosting: true })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(container.querySelector('.publish-hosting-section')).not.toBeInTheDocument();
  });

  it('describes the GitHub push without inferring deployment state', () => {
    const { container } = render(
      <PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />
    );

    fireEvent.click(screen.getByText('Push'));

    expect(container.querySelector('.publish-branch-description')).toHaveTextContent(
      'Commits your changes and pushes the main branch to GitHub.'
    );
    expect(screen.queryByText(/live site/i)).not.toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('supports the grouped trigger treatment without changing the label', () => {
    const { container } = render(<PublishBranchDropdown {...makeProps()} grouped />);

    expect(container.querySelector('.publish-dropdown')).toHaveClass('publish-dropdown--grouped');
    expect(screen.getByText('Push')).toBeInTheDocument();
  });

  it('says there is nothing to push when GitHub is up to date', () => {
    render(<PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText(/Nothing to push/i)).toBeInTheDocument();
    expectNoBannedLabels();
  });

  describe('remotes that are not GitHub', () => {
    const gitlabStatus = {
      status: 'other-remote',
      github_repo: null,
      github_url: null,
      remote_host: 'gitlab.com',
      remote_forge: 'GitLab',
    } as unknown as ProjectGitHubStatus;

    const selfManagedStatus = {
      status: 'other-remote',
      github_repo: null,
      github_url: null,
      remote_host: 'git.acme.com',
      remote_forge: null,
    } as unknown as ProjectGitHubStatus;

    it('lets a GitLab project push', () => {
      // The regression: Push was gated on having a *GitHub* repo, so a GitLab
      // project got a permanently disabled button telling it to create one.
      // `publish_branch` is plain `git push` and always would have worked.
      render(<PublishBranchDropdown {...makeProps({ projectGithubStatus: gitlabStatus })} />);

      const trigger = screen.getByText('Push').closest('button');
      expect(trigger).not.toBeDisabled();
    });

    it('names the actual forge instead of saying GitHub', () => {
      const { container } = render(
        <PublishBranchDropdown
          {...makeProps({ projectGithubStatus: gitlabStatus, currentBranch: 'main' })}
        />
      );

      fireEvent.click(screen.getByText('Push'));

      expect(container.querySelector('.publish-branch-description')).toHaveTextContent(
        'Commits your changes and pushes the main branch to GitLab.'
      );
      expect(screen.getByRole('heading', { name: 'Push to GitLab' })).toBeInTheDocument();
      expect(container.textContent).not.toContain('GitHub');
    });

    it('falls back to the host when the forge is unknown', () => {
      // A self-managed instance gets its address shown, not a guessed vendor.
      const { container } = render(
        <PublishBranchDropdown
          {...makeProps({ projectGithubStatus: selfManagedStatus, currentBranch: 'main' })}
        />
      );

      fireEvent.click(screen.getByText('Push'));

      expect(container.querySelector('.publish-branch-description')).toHaveTextContent(
        'Commits your changes and pushes the main branch to git.acme.com.'
      );
      expect(container.textContent).not.toContain('GitHub');
    });

    it('does not offer PR creation for a non-GitHub remote', () => {
      // `gh pr create` has nothing to talk to here.
      const onCreatePR = vi.fn();
      render(
        <PublishBranchDropdown
          {...makeProps({
            projectGithubStatus: gitlabStatus,
            currentBranch: 'feature/x',
            onCreatePR,
          })}
        />
      );

      fireEvent.click(screen.getByText('Push'));

      expect(screen.queryByText(/create a PR/i)).not.toBeInTheDocument();
    });

    it('keeps hosting available and disables only the push action without any remote', async () => {
      const noRemote = {
        status: 'no-remote',
        github_repo: null,
        github_url: null,
        remote_host: null,
        remote_forge: null,
      } as unknown as ProjectGitHubStatus;

      render(<PublishBranchDropdown {...makeProps({ projectGithubStatus: noRemote })} />);

      fireEvent.click(screen.getByRole('button', { name: 'Push' }));

      expect(await screen.findByText('Hosting')).toBeInTheDocument();
      const pushButtons = screen.getAllByRole('button', { name: 'Push' });
      expect(pushButtons[0]).toBeEnabled();
      expect(pushButtons[pushButtons.length - 1]).toBeDisabled();
    });
  });
});
