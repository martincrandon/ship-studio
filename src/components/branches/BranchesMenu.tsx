/**
 * Compact repository workflow for the workspace header.
 *
 * Pulling, branch switching, pull-request entry points, repository setup, and
 * navigation to the full repository pages live here. Destructive/advanced
 * branch and PR management remains in the full views.
 */

import { useCallback, useMemo } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';
import type { ProjectGitHubStatus } from '../../lib/github';
import type { GitHubState } from '../../hooks/useIntegrationStatus';
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  ExternalLinkIcon,
  GitHubIcon,
  PlusIcon,
  PullIcon,
  PullRequestIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { Dropdown } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { Spinner } from '../primitives/Spinner';
import { GitHubButton } from './GitHubButton';

interface BranchesMenuProps {
  githubState: GitHubState;
  projectStatus: ProjectGitHubStatus | null;
  projectPath: string;
  projectName: string;
  currentBranch: string | null;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  isPulling: boolean;
  isBranchSwitching: boolean;
  isRepositoryViewActive: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onPullLatest: () => void;
  onBranchSwitch: (branch: string) => void;
  onViewBranches: () => void;
  onCreateBranch: () => void;
  onViewPRs: () => void;
  onStartPR: (branch: string) => void;
  onGitHubConnect: () => void;
  onGitHubStatusChange: () => void | Promise<void>;
  onModalClose?: () => void;
}

export function BranchesMenu({
  githubState,
  projectStatus,
  projectPath,
  projectName,
  currentBranch,
  branches,
  openPRs,
  isPulling,
  isBranchSwitching,
  isRepositoryViewActive,
  isOpen,
  onOpenChange,
  onPullLatest,
  onBranchSwitch,
  onViewBranches,
  onCreateBranch,
  onViewPRs,
  onStartPR,
  onGitHubConnect,
  onGitHubStatusChange,
  onModalClose,
}: BranchesMenuProps) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const repositoryReady =
    githubState.cliStatus.installed &&
    githubState.cliStatus.authenticated &&
    projectStatus?.status === 'connected';

  const recentBranches = useMemo(
    () =>
      branches
        .filter((branch) => !branch.isCurrent && branch.name !== currentBranch)
        .sort((a, b) => b.lastCommitDate - a.lastCommitDate)
        .slice(0, 5),
    [branches, currentBranch]
  );

  const currentOpenPR = useMemo(
    () =>
      currentBranch
        ? (openPRs.find((pr) => pr.state === 'OPEN' && pr.headRef === currentBranch) ?? null)
        : null,
    [currentBranch, openPRs]
  );
  const isMainBranch = currentBranch === 'main' || currentBranch === 'master';
  const pullRequestBranch = useMemo(() => {
    if (currentBranch && !isMainBranch && !currentOpenPR) return currentBranch;
    return (
      recentBranches.find(
        (branch) =>
          !branch.isRemote &&
          branch.name !== 'main' &&
          branch.name !== 'master' &&
          !openPRs.some((pr) => pr.state === 'OPEN' && pr.headRef === branch.name)
      )?.name ?? null
    );
  }, [currentBranch, currentOpenPR, isMainBranch, openPRs, recentBranches]);

  const runAndClose = (action: () => void) => {
    close();
    action();
  };

  return (
    <div className="branches-menu">
      <Dropdown
        portal
        align="right"
        open={isOpen}
        onOpenChange={onOpenChange}
        menuClassName="branches-menu-popover"
        trigger={(triggerProps) => (
          <MenuButton
            expanded={triggerProps['aria-expanded']}
            className={`branches-menu-trigger${isRepositoryViewActive ? ' is-active' : ''}`}
            data-education-id="branches-button"
            leftIcon={<BranchIcon size={14} />}
            rightIcon={<ChevronIcon />}
            {...triggerProps}
          >
            Branches
          </MenuButton>
        )}
      >
        {!repositoryReady ? (
          <div className="branches-menu-setup">
            <div className="branches-menu-section-title">GitHub</div>
            <p>Connect this project to GitHub to pull, switch branches, and manage reviews.</p>
            <GitHubButton
              githubState={githubState}
              projectStatus={projectStatus}
              projectPath={projectPath}
              projectName={projectName}
              onStatusChange={onGitHubStatusChange}
              onGitHubConnect={onGitHubConnect}
              onModalClose={onModalClose}
            />
          </div>
        ) : (
          <>
            <section className="branches-menu-section" aria-labelledby="branches-menu-sync">
              <div className="branches-menu-section-title" id="branches-menu-sync">
                Sync
              </div>
              <Button
                width="fill"
                variant="secondary"
                onClick={onPullLatest}
                disabled={isPulling}
                leftIcon={isPulling ? <Spinner size="sm" /> : <PullIcon size={14} />}
              >
                {isPulling ? 'Pulling latest...' : 'Pull latest from GitHub'}
              </Button>
            </section>

            <section className="branches-menu-section" aria-labelledby="branches-menu-branches">
              <div className="branches-menu-section-heading">
                <div className="branches-menu-section-title" id="branches-menu-branches">
                  Branches
                </div>
              </div>
              {currentBranch && (
                <button type="button" className="branches-menu-row is-current" disabled>
                  <CheckIcon size={14} />
                  <span className="branches-menu-row-label">{currentBranch}</span>
                  <span className="branches-menu-row-meta">Current</span>
                </button>
              )}
              {recentBranches.map((branch) => (
                <button
                  type="button"
                  className="branches-menu-row"
                  key={`${branch.isRemote ? 'remote' : 'local'}:${branch.name}`}
                  disabled={isBranchSwitching}
                  onClick={() => runAndClose(() => onBranchSwitch(branch.name))}
                >
                  <BranchIcon size={14} />
                  <span className="branches-menu-row-label">{branch.name}</span>
                  {branch.isRemote && <span className="branches-menu-row-meta">Remote</span>}
                </button>
              ))}
              {recentBranches.length === 0 && (
                <div className="branches-menu-empty">No other branches yet.</div>
              )}
              <Button
                width="fill"
                variant="ghost"
                onClick={() => runAndClose(onCreateBranch)}
                leftIcon={<PlusIcon size={14} />}
              >
                New branch
              </Button>
              <Button width="fill" variant="ghost" onClick={() => runAndClose(onViewBranches)}>
                View all branches
              </Button>
            </section>

            <section className="branches-menu-section" aria-labelledby="branches-menu-prs">
              <div className="branches-menu-section-heading">
                <div className="branches-menu-section-title" id="branches-menu-prs">
                  Pull requests
                </div>
                <span className="branches-menu-count" aria-label={`${openPRs.length} open`}>
                  {openPRs.length}
                </span>
              </div>
              {currentOpenPR && (
                <button
                  type="button"
                  className="branches-menu-row"
                  onClick={() => {
                    close();
                    void openUrl(currentOpenPR.url);
                  }}
                >
                  <PullRequestIcon size={14} />
                  <span className="branches-menu-row-label">View PR #{currentOpenPR.number}</span>
                  <ExternalLinkIcon size={12} />
                </button>
              )}
              <button
                type="button"
                className="branches-menu-row"
                disabled={!pullRequestBranch}
                title={
                  pullRequestBranch
                    ? `Create a pull request from ${pullRequestBranch}`
                    : 'Create a feature branch first'
                }
                onClick={() => pullRequestBranch && runAndClose(() => onStartPR(pullRequestBranch))}
              >
                <PullRequestIcon size={14} />
                <span className="branches-menu-row-label">New pull request</span>
                {pullRequestBranch && (
                  <span className="branches-menu-row-meta">{pullRequestBranch}</span>
                )}
              </button>
              <Button width="fill" variant="ghost" onClick={() => runAndClose(onViewPRs)}>
                View all pull requests
              </Button>
            </section>

            {projectStatus.github_url && (
              <section className="branches-menu-section branches-menu-repository">
                <button
                  type="button"
                  className="branches-menu-row"
                  onClick={() => {
                    close();
                    void openUrl(projectStatus.github_url!);
                  }}
                >
                  <GitHubIcon size={14} />
                  <span className="branches-menu-row-label">Open repository on GitHub</span>
                  <ExternalLinkIcon size={12} />
                </button>
              </section>
            )}
          </>
        )}
      </Dropdown>
    </div>
  );
}
