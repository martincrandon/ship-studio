/**
 * Feature-surface scenarios: the states that carry real data.
 *
 * The `--commands` sweep already reaches every surface the palette can open,
 * but it reaches them against the default fixtures — which are mostly empty.
 * An empty list is a state worth reviewing exactly once; what needs looking at
 * repeatedly is a populated one, where truncation, wrapping, overflow, and
 * ordering actually happen. That is what lives here.
 */

import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';
import { rejectsWith } from '../reject';

const HOUR = 3_600_000;

const pr = (n: number, title: string, over: Record<string, unknown> = {}) => ({
  number: n,
  title,
  head_ref: `feat/branch-${n}`,
  base_ref: 'main',
  author: 'harness-user',
  state: 'OPEN',
  mergeable: true,
  is_draft: false,
  url: `https://github.com/harness-user/acme-marketing/pull/${n}`,
  created_at: new Date(Date.now() - n * HOUR).toISOString(),
  ...over,
});

const branch = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  is_current: false,
  is_remote: false,
  is_default: false,
  last_commit_date: Date.now() - HOUR,
  last_commit_author: 'Harness User',
  ahead_of_main: 0,
  behind_main: 0,
  ...over,
});

const manyChangedFiles = Array.from({ length: 26 }, (_, index) => ({
  path: `src/components/publishing/PublishRow${String(index + 1).padStart(2, '0')}.tsx`,
  status: index % 8 === 0 ? 'added' : index % 9 === 0 ? 'deleted' : 'modified',
  additions: 3 + (index % 11),
  deletions: index % 5,
}));

const manyChangedFileSummary = {
  files: manyChangedFiles,
  additions: manyChangedFiles.reduce((total, file) => total + file.additions, 0),
  deletions: manyChangedFiles.reduce((total, file) => total + file.deletions, 0),
};

const workflow = (slug: string, name: string, over: Record<string, unknown> = {}) => ({
  id: `${WORKSPACE_PROJECT}::${slug}`,
  slug,
  name,
  icon: null,
  description: 'Checks the things that keep breaking.',
  agentId: null,
  projectPath: WORKSPACE_PROJECT,
  projectName: 'acme-marketing',
  trigger: { kind: 'manual' },
  permission: 'read-only',
  prompt: 'Review the diff and report anything that would break in production.',
  severityFloor: 'info',
  autoRun: false,
  filePath: `${WORKSPACE_PROJECT}/.shipstudio/workflows/${slug}.md`,
  updatedAt: Date.now() - HOUR,
  nextRunAt: null,
  isRunning: false,
  runningSince: null,
  runs: [],
  ...over,
});

const finding = (id: string, severity: string, title: string, summary: string) => ({
  id,
  workflowId: `${WORKSPACE_PROJECT}::pre-release`,
  workflowName: 'Pre-release check',
  projectName: 'acme-marketing',
  projectPath: WORKSPACE_PROJECT,
  severity,
  title,
  summary,
  bodyMd: `## ${title}\n\n${summary}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`,
  createdAt: Date.now() - HOUR,
  read: false,
  archived: false,
  fingerprint: id,
  occurrences: 1,
  firstSeenAt: Date.now() - HOUR,
  locations: [{ path: 'src/app/page.tsx', line: 42 }],
  suggestedPrompt: `Fix: ${title}`,
  runId: 'run_1',
});

export const featureScenarios: Scenario[] = [
  {
    id: 'workspace',
    requires: '.workspace-header',
    title: 'Workspace — a project open',
    looksRightWhen:
      'Header, sidebar, agent pane, and preview all render. This is the baseline every command capture is diffed against.',
    project: WORKSPACE_PROJECT,
    commands: { ...workspaceCommands },
  },
  {
    id: 'push-many-changes',
    title: 'Push popover — a long list of changes',
    looksRightWhen:
      'The file count and total line changes are visible, per-file additions and deletions line up on the right, the list scrolls, and the bottom actions remain visible.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    requires: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_changed_files: manyChangedFiles,
      get_changed_file_summary: manyChangedFileSummary,
    },
  },
  {
    id: 'push-ready-no-commits',
    title: 'Push popover — local changes with nothing outgoing',
    looksRightWhen:
      'The local summary expands, the local commit controls stay visible, and the disabled pure push explains that local changes must be committed first.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    requires: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_changed_files: manyChangedFiles,
      get_changed_file_summary: manyChangedFileSummary,
      get_git_sync_status: {
        status: 'ready',
        branch: 'feat/cloudflare-workers',
        remote: 'origin',
        upstream: 'origin/feat/cloudflare-workers',
        remotes: ['origin'],
        ahead: 0,
        behind: 0,
        headSha: '1111111111111111111111111111111111111111',
        comparedUpstream: 'origin/feat/cloudflare-workers',
        comparedUpstreamSha: '1111111111111111111111111111111111111111',
        outgoingCommits: [],
        outgoingComparison: 'upstream',
        outgoingComparisonLabel: 'origin/feat/cloudflare-workers',
        outgoingCount: 0,
      },
    },
  },
  {
    id: 'push-no-upstream',
    title: 'Push popover — choose an upstream remote',
    looksRightWhen:
      'The destination selector and Push action share one aligned row beneath the destination label.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    requires: '.publish-remote-select-row',
    commands: {
      ...workspaceCommands,
      get_changed_files: manyChangedFiles,
      get_changed_file_summary: manyChangedFileSummary,
      get_git_sync_status: {
        status: 'no-upstream',
        branch: 'main',
        remote: null,
        upstream: null,
        remotes: ['origin', 'backup'],
        ahead: null,
        behind: null,
        headSha: '2222222222222222222222222222222222222222',
        comparedUpstream: null,
        comparedUpstreamSha: null,
        outgoingCommits: [
          {
            sha: '2222222222222222222222222222222222222222',
            shortSha: '2222222',
            subject: 'Test alternative homepage hero',
          },
        ],
        outgoingComparison: 'remote-known-branches',
        outgoingComparisonLabel: 'origin known branches (last fetched)',
        outgoingCount: 1,
      },
    },
  },
  {
    id: 'gitlab-remote-push',
    title: 'Push popover — a GitLab remote',
    looksRightWhen:
      'Push is enabled and the copy says GitLab throughout — heading, description, and the hint. ' +
      'The word "GitHub" appears nowhere, and nothing offers to create a GitHub repository.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    requires: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_project_github_status: {
        status: 'other-remote',
        github_repo: null,
        github_url: null,
        remote_host: 'gitlab.com',
        remote_forge: 'GitLab',
      },
      // Show the popover with work to push, so the heading and description
      // are on screen — the strings that used to hardcode "GitHub".
      check_git_has_changes: true,
    },
  },
  {
    id: 'self-managed-remote-push',
    title: 'Push popover — a self-managed remote',
    looksRightWhen:
      'The host (git.acme.com) is named literally. No vendor is guessed from the hostname, ' +
      'and push still works.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    requires: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_project_github_status: {
        status: 'other-remote',
        github_repo: null,
        github_url: null,
        remote_host: 'git.acme.com',
        remote_forge: null,
      },
      check_git_has_changes: true,
    },
  },
  {
    id: 'gitlab-branches-tab',
    // Reached via `branch.create`, which is itself one of the commands that
    // used to be hidden for a non-GitHub remote — if the gate regresses, the
    // palette won't have the command and this capture fails rather than
    // quietly photographing the preview tab.
    command: 'branch.create',
    requires: '.branch-card',
    title: 'Branches tab — a GitLab remote',
    looksRightWhen:
      'The branch list is fully usable: switch, create, delete, worktrees. No "Connect GitHub" ' +
      'overlay, and no "Submit for Review" button, because pull requests need a GitHub remote.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      get_project_github_status: {
        status: 'other-remote',
        github_repo: null,
        github_url: null,
        remote_host: 'gitlab.com',
        remote_forge: 'GitLab',
      },
      list_branches: [
        branch('main', { is_current: false, is_default: true }),
        branch('feat/pricing-page', { is_current: true, ahead_of_main: 3, behind_main: 1 }),
        branch('chore/deps', { behind_main: 2 }),
      ],
    },
  },
  {
    id: 'gitlab-branches-menu',
    command: 'branch.switch',
    requires: '.branches-menu-branch-row',
    title: 'Branches menu — a GitLab remote',
    looksRightWhen:
      'The menu is fully populated — sync and the branch list — rather than the "Connect this ' +
      'project to GitHub" setup panel. Pull says GitLab, and there is no "Open in GitHub" link, ' +
      'because we have no GitLab URL to open.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      get_project_github_status: {
        status: 'other-remote',
        github_repo: null,
        github_url: null,
        remote_host: 'gitlab.com',
        remote_forge: 'GitLab',
      },
      list_branches: [
        branch('main', { is_current: true, is_default: true }),
        branch('feat/pricing-page', { ahead_of_main: 3, behind_main: 1 }),
        branch('chore/deps', { behind_main: 2 }),
      ],
    },
  },
  {
    id: 'branches-many',
    // Nothing opened the branches menu, so this photographed the workspace —
    // no branch list, no ahead/behind counts, none of what the caption checks.
    // `prs-open` beside it already did this correctly; this one did not.
    command: 'branch.switch',
    requires: '.branches-menu-branch-row',
    title: 'Branches — a busy repo',
    looksRightWhen:
      'Long branch names truncate rather than overflow; ahead/behind counts read clearly; the current branch is unmistakable.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_branches: [
        branch('main', { is_current: true, is_default: true }),
        branch('feat/pricing-page', { ahead_of_main: 3, behind_main: 1 }),
        branch('fix/a-very-long-branch-name-that-should-truncate-not-overflow', {
          ahead_of_main: 12,
          behind_main: 40,
        }),
        branch('chore/deps', { behind_main: 2 }),
        branch('origin/main', { is_remote: true }),
      ],
    },
  },
  {
    id: 'prs-open',
    title: 'Pull requests — several open',
    looksRightWhen:
      'Each row shows number, title, author and branch without collision. Draft and non-mergeable states are visually distinct.',
    project: WORKSPACE_PROJECT,
    command: 'branch.viewPRs',
    requires: '.pr-card',
    commands: {
      ...workspaceCommands,
      list_pull_requests: [
        pr(128, 'Add the pricing page'),
        pr(127, 'Bump dependencies', { is_draft: true }),
        pr(126, 'Refactor the checkout flow so that it no longer depends on the legacy cart', {
          mergeable: false,
        }),
      ],
    },
  },
  {
    id: 'conflicts',
    title: 'Merge conflicts — resolution UI',
    looksRightWhen:
      'Both sides are readable and equally weighted; it is obvious which file is being resolved and how many blocks remain.',
    project: WORKSPACE_PROJECT,
    // Reached through a *failure*, not a command. `branch.resolveConflicts`
    // cannot open this panel — its `when` predicate is gated on
    // `hasConflicts: showConflictResolution` (WorkspaceView.tsx:845), i.e. on
    // the panel already being visible, so it only appears once you no longer
    // need it. That is a product bug, reported separately; the panel's real
    // entry point is `pull_and_merge` rejecting with a `MERGE_CONFLICT:`
    // message, which is what this scenario does.
    command: 'git.pull',
    requires: '.conflict-content',
    commands: {
      ...workspaceCommands,
      pull_and_merge: rejectsWith(
        'MERGE_CONFLICT:Auto-merging src/app/page.tsx\nCONFLICT (content): Merge conflict in src/app/page.tsx'
      ),
      // The repo really is conflicted here, so the workspace default of
      // `false` would contradict the rest of this scenario's fixtures.
      has_conflicts: true,
      // `get_conflict_info`, snake_case — the shape at the real call site in
      // `src/lib/conflicts.ts`, which differs from the camelCase
      // `ConflictedFile` the lib maps it into.
      get_conflict_info: [
        {
          file_path: 'src/app/page.tsx',
          is_binary: false,
          ours_branch: 'main',
          theirs_branch: 'feat/pricing-page',
          unsupported_reason: null,
          conflicts: [
            {
              line_start: 12,
              line_end: 16,
              current_content: '        <h1>Welcome</h1>',
              incoming_content: '        <h1>Welcome to Acme</h1>',
              context_before: 'export default function Page() {\n  return (\n    <main>',
              context_after: '    </main>\n  );\n}',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'workflows-populated',
    // Same as the Inbox above: the fixture existed, but nothing navigated to
    // Workflows, so the capture showed the workspace instead of the list it
    // describes. Requiring the running workflow's live region makes the
    // "running is distinguishable from idle" claim something the run can
    // actually fail on. Note it is NOT the row dot: a running workflow renders
    // PixelLoaderRings instead, so `data-state="running"` on the dot is
    // unreachable.
    command: 'workflows.open',
    requires: '[role="status"][aria-label$="is running"]',
    title: 'Workflows — several configured',
    looksRightWhen:
      'Trigger descriptions are legible, and a running workflow is distinguishable from an idle one.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_all_workflows: [
        workflow('pre-release', 'Pre-release check'),
        workflow('a11y', 'Accessibility sweep', {
          trigger: { kind: 'daily', atHour: 9, atMinute: 0 },
          autoRun: true,
          nextRunAt: Date.now() + HOUR,
        }),
        workflow('deps', 'Dependency audit', {
          isRunning: true,
          runningSince: Date.now() - 30_000,
        }),
      ],
    },
  },
  {
    id: 'inbox-populated',
    // The fixture was here but nothing opened the Inbox, so this photographed
    // the workspace with an unread badge on the bell and nothing else — no
    // severities, no unread row, no detail pane, none of what the caption
    // below claims to check. `requires` names a severity chip so a scenario
    // that stops reaching the Inbox fails the run instead of passing on the
    // screen behind it.
    command: 'inbox.open',
    requires: '.inbox-item-severity[data-severity="critical"]',
    title: 'Inbox — findings to triage',
    looksRightWhen:
      'Severities are distinguishable at a glance, unread stands out, and the detail pane renders markdown without breaking the layout.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      list_inbox_items: [
        finding(
          'f1',
          'critical',
          'Preview URL is constructed, not observed',
          'The card builds a URL from the project name, which 404s past 63 characters.'
        ),
        finding(
          'f2',
          'warning',
          'Unbounded CLI call on the boot path',
          'A network CLI call without a timeout can hang the window indefinitely.'
        ),
        finding(
          'f3',
          'info',
          'Off-scale font size',
          'A 15px literal should round to the nearest type-scale token.'
        ),
      ],
    },
  },
];
