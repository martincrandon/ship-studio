import { useCommands } from './useCommands';
import { useOpenModal } from '../contexts/ModalContext';
import { hasPushableRemote, remoteLabel, type ProjectGitHubStatus } from '../lib/github';
import {
  BranchIcon,
  PlusIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  SaveIcon,
  GlobeIcon,
  WarningIcon,
} from '@/components/icons';

/**
 * Workspace-scoped palette commands (Branches, PR flows).
 *
 * Called from `WorkspaceView`, where the necessary handlers live (inside
 * `useBranchManagement` + `useWorkspaceLayout`). The command palette picks
 * these up automatically via the global registry — no prop drilling to
 * `CommandPaletteHost` needed.
 *
 * Follows the "feature owns its commands" rule in CLAUDE.md.
 */
export interface UseWorkspaceCommandsParams {
  currentBranch: string | null;
  hasUncommittedChanges: boolean;
  /** True only when changed-file state is known and has at least one file. */
  canCommit: boolean;
  /** True only when a known upstream comparison has commits ahead. */
  canPushCurrentCommits: boolean;
  /** True when there are known worktree changes and a usable push destination. */
  canCommitAndPush: boolean;
  hasConflicts: boolean;
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  setShowSubmitReview: (branch: string | null) => void;
  handleResolveConflicts: () => void | Promise<void>;
  /** Opens the shared commit dialog in local-only or commit-and-push mode. */
  openCommit: (mode: 'local' | 'commit-and-push') => void;
  /** Pushes existing commits only and surfaces failures to the user. */
  pushCurrentCommits: () => void | Promise<void>;
  /** Opens the header Branches workflow menu */
  openBranchesMenu: () => void;
  /** Opens the full Branches view with its creation form active. */
  openCreateBranch: () => void;
  /** Pulls the latest changes from GitHub (routes conflicts to the resolver) */
  handlePullLatest: () => void;
  /**
   * The project's remote, as the backend reported it.
   *
   * Everything here used to hang off one "is GitHub connected" boolean, which
   * hid a distinction that matters: push, pull, switch and create are plain git
   * and work against any forge, while pull requests are GitHub's. Gating all of
   * them together cost a GitLab project every branch command in the palette.
   */
  projectStatus: ProjectGitHubStatus | null;
  /** Opens the "New worktree" modal. */
  openWorktreeCreate: () => void;
  /** Worktree commands only make sense in a git repo (list is empty otherwise). */
  hasWorktreeData: boolean;
}

export function useWorkspaceCommands({
  currentBranch,
  hasUncommittedChanges,
  canCommit,
  canPushCurrentCommits,
  canCommitAndPush,
  hasConflicts,
  setWorkspaceTab,
  setShowSubmitReview,
  handleResolveConflicts,
  openCommit,
  pushCurrentCommits,
  openBranchesMenu,
  openCreateBranch,
  handlePullLatest,
  projectStatus,
  openWorktreeCreate,
  hasWorktreeData,
}: UseWorkspaceCommandsParams) {
  const openModal = useOpenModal();
  /** Pull requests are GitHub's. */
  const isGitHubConnected = projectStatus?.status === 'connected';
  /** Branch and sync commands need a remote, not a particular forge. */
  const repoAvailable = hasPushableRemote(projectStatus);
  /** "GitHub", "GitLab", or a bare host — never a guessed vendor. */
  const target = remoteLabel(projectStatus) ?? 'the remote';

  useCommands(
    () => [
      {
        id: 'hosting.deployments',
        title: 'View deployments',
        subtitle: 'Recent deploys and their build output',
        icon: <GlobeIcon size={14} />,
        category: 'branch',
        when: 'project',
        keywords: ['deploy', 'vercel', 'netlify', 'cloudflare', 'hosting', 'build', 'logs'],
        run: () => openModal('deployments'),
      },
      {
        id: 'git.commit',
        title: 'Commit changes…',
        subtitle: 'Create a local commit',
        icon: <SaveIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && canCommit,
        keywords: ['save', 'checkpoint', 'git', 'local'],
        run: () => openCommit('local'),
      },
      {
        id: 'git.push',
        title: `Push to ${target}`,
        subtitle: 'Push existing commits; uncommitted files stay local',
        icon: <PushIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && canPushCurrentCommits,
        keywords: ['publish', 'sync', 'upload', 'git'],
        run: pushCurrentCommits,
      },
      {
        id: 'git.commitAndPush',
        title: 'Commit and push…',
        subtitle: `Create a commit, then push to ${target}`,
        icon: <PushIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && canCommitAndPush,
        keywords: ['publish', 'sync', 'upload', 'git'],
        run: () => openCommit('commit-and-push'),
      },
      {
        id: 'git.pull',
        title: `Pull latest from ${target}`,
        icon: <PullIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && repoAvailable,
        keywords: ['sync', 'fetch', 'update', 'download', 'git'],
        run: handlePullLatest,
      },
      {
        id: 'branch.switch',
        title: 'Switch branch…',
        subtitle: currentBranch ? `Currently on ${currentBranch}` : undefined,
        icon: <BranchIcon size={14} />,
        category: 'branch',
        // `useWorkspaceLayout` projects the branches tab back to preview when
        // the project has no remote, so without this gate the command was
        // listed, selectable, and did nothing at all (issue #612). It tracks
        // that projection, which is now "has a remote" rather than "is GitHub".
        when: ({ kind }) => kind === 'project' && repoAvailable,
        keywords: ['checkout', 'change', 'git'],
        run: openBranchesMenu,
      },
      {
        id: 'branch.create',
        title: 'Create new branch…',
        icon: <PlusIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && repoAvailable,
        keywords: ['new', 'git', 'checkout -b'],
        run: openCreateBranch,
      },
      {
        id: 'branch.submitReview',
        title: 'Submit for review',
        subtitle: hasUncommittedChanges
          ? 'You have uncommitted changes — they will be committed first'
          : undefined,
        icon: <PullRequestIcon size={14} />,
        category: 'branch',
        // Only available on a feature branch — opening a PR from main/
        // master into itself isn't a real workflow — and only where pull
        // requests exist at all. Without the GitHub gate the palette offered
        // this to a GitLab project, where it opens a modal that ends in
        // `gh pr create` against a repo GitHub has never heard of. Every
        // other GitHub command here was already gated; this one was missed.
        when: ({ kind }) =>
          kind === 'project' &&
          isGitHubConnected &&
          currentBranch !== null &&
          currentBranch !== 'main' &&
          currentBranch !== 'master',
        keywords: ['pr', 'pull request', 'github'],
        run: () => setShowSubmitReview(currentBranch ?? ''),
      },
      {
        id: 'branch.viewPRs',
        title: 'View open pull requests',
        icon: <PullRequestIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && isGitHubConnected,
        keywords: ['prs', 'reviews'],
        run: () => setWorkspaceTab('prs'),
      },
      {
        id: 'worktree.create',
        title: 'New worktree…',
        subtitle: 'Work on another branch side by side',
        icon: <BranchIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && hasWorktreeData,
        keywords: ['worktree', 'parallel', 'branch', 'git', 'side by side'],
        run: openWorktreeCreate,
      },
      {
        id: 'worktree.manage',
        title: 'Manage worktrees',
        icon: <BranchIcon size={14} />,
        category: 'branch',
        // Lives inside the Branches pane, so it needs the same gate (#612) —
        // which is now "has a remote", since that pane no longer needs GitHub.
        when: ({ kind }) => kind === 'project' && hasWorktreeData && repoAvailable,
        keywords: ['worktree', 'remove', 'prune', 'git'],
        run: () => setWorkspaceTab('branches'),
      },
      {
        id: 'branch.resolveConflicts',
        title: 'Resolve merge conflicts',
        icon: <WarningIcon size={14} />,
        category: 'branch',
        when: ({ kind }) => kind === 'project' && hasConflicts,
        keywords: ['merge', 'conflict'],
        run: () => void handleResolveConflicts(),
      },
    ],
    [
      currentBranch,
      hasUncommittedChanges,
      canCommit,
      canPushCurrentCommits,
      canCommitAndPush,
      hasConflicts,
      setWorkspaceTab,
      setShowSubmitReview,
      handleResolveConflicts,
      openCommit,
      pushCurrentCommits,
      openBranchesMenu,
      openCreateBranch,
      handlePullLatest,
      isGitHubConnected,
      repoAvailable,
      target,
      openWorktreeCreate,
      hasWorktreeData,
    ]
  );
}
