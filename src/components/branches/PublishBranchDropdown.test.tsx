/**
 * Tests for PublishBranchDropdown.
 *
 * The core contract: the trigger button says "Push" at ALL times (or
 * "Pushing..." while in flight) — never "Sync", "Publish", "Synced", or
 * "Go Live". That label churn was a real UX complaint; these tests pin it.
 */

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import type { ProjectGitHubStatus } from '../../lib/github';

vi.mock('../../lib/branches', () => ({
  publishBranch: vi.fn().mockResolvedValue({ state: 'PUSHED', url: null }),
}));

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

function FakeCloudflareControls() {
  const [open, setOpen] = useState(false);
  return (
    <div className="cf-dropdown-wrapper" onMouseEnter={() => setOpen(true)}>
      <button type="button">Cloudflare</button>
      {open && (
        <div className="cf-dropdown">
          <div className="cf-dropdown-inner">
            <button type="button">Prod site</button>
            <button type="button">Dashboard</button>
            <button type="button" className="cf-dropdown-action">
              Deploy now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FakeVercelControls() {
  const [open, setOpen] = useState(false);
  return (
    <div className="vercel-dropdown-wrapper" onMouseEnter={() => setOpen(true)}>
      <button type="button">Vercel</button>
      {open && (
        <div className="vercel-dropdown">
          <div className="vercel-dropdown-inner">
            <button type="button">Production</button>
            <button type="button">Dashboard</button>
          </div>
        </div>
      )}
    </div>
  );
}

function expectNoBannedLabels() {
  for (const label of BANNED_LABELS) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
}

describe('PublishBranchDropdown trigger label', () => {
  it('says "Push" on the main branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
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

  it('says "Push" (disabled) when no GitHub repo exists yet', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          projectGithubStatus: { status: 'no_repo' } as unknown as ProjectGitHubStatus,
        })}
      />
    );

    const button = screen.getByText('Push').closest('button');
    expect(button).toBeDisabled();
    expectNoBannedLabels();
  });
});

describe('PublishBranchDropdown open panel', () => {
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

  it('renders hosting plugin controls inside the Push menu', () => {
    render(
      <PublishBranchDropdown
        {...makeProps()}
        hostingControls={<button type="button">Cloudflare deploy controls</button>}
      />
    );

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('Hosting')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare deploy controls')).toBeInTheDocument();
  });

  it('reveals Cloudflare production links by default', async () => {
    render(<PublishBranchDropdown {...makeProps()} hostingControls={<FakeCloudflareControls />} />);

    fireEvent.click(screen.getByText('Push'));

    expect(await screen.findByText('Prod site')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Deploy now')).toHaveClass('cf-dropdown-action');
  });

  it('reveals Vercel production links by default', async () => {
    render(<PublishBranchDropdown {...makeProps()} hostingControls={<FakeVercelControls />} />);

    fireEvent.click(screen.getByText('Push'));

    expect(await screen.findByText('Production')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
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
});
