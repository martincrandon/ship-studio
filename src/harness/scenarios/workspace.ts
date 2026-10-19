/**
 * The commands a project workspace asks for on open.
 *
 * Split out from `baseCommands` because the dashboard never needs them, and
 * keeping them separate makes it obvious which fixtures exist to open a
 * project versus to render the home screen.
 *
 * Every shape is taken from the `invoke<...>` type at the call site, including
 * the snake_case/camelCase split — the backend is inconsistent about it and a
 * fixture that "tidies" the casing would test a response the app never gets.
 */

import type { CommandMap } from '../types';
import type {
  ChatAttachment,
  ChatModel,
  ChatThread,
  ChatThreadStatus,
  SavedChatDraft,
} from '../../lib/agentChat';
import { HARNESS_ROOT } from './base';
import { buildTeamFixture } from '../fixtures/team';

export const WORKSPACE_PROJECT = `${HARNESS_ROOT}/acme-marketing`;

let agentChatFixtureSequence = 0;
const agentChatThreads = new Map<string, ChatThread>();
const agentChatDrafts = new Map<string, SavedChatDraft>();
const agentChatDraftProjects = new Map<string, string>();

function agentChatThreadFromArgs(
  args: Record<string, unknown>,
  status: ChatThreadStatus = 'idle'
): ChatThread {
  const requestedId = typeof args.threadId === 'string' ? args.threadId : null;
  const existing = requestedId ? agentChatThreads.get(requestedId) : undefined;
  const projectPath =
    existing?.projectPath ??
    (typeof args.projectPath === 'string' ? args.projectPath : WORKSPACE_PROJECT);
  const checkoutPath =
    existing?.checkoutPath ??
    (typeof args.checkoutPath === 'string' ? args.checkoutPath : projectPath);
  const id = existing?.id ?? requestedId ?? `harness-chat-${++agentChatFixtureSequence}`;
  const thread: ChatThread = {
    ...existing,
    id,
    projectId: existing?.projectId ?? 'harness-agent-chat-project',
    projectPath,
    checkoutPath,
    checkoutStatus: existing?.checkoutStatus ?? 'available',
    providerId:
      existing?.providerId ?? (typeof args.providerId === 'string' ? args.providerId : 'codex'),
    providerThreadId: existing?.providerThreadId ?? `codex-${id}`,
    resumeStatus: existing?.resumeStatus ?? 'available',
    providerStatus:
      existing?.providerStatus ??
      (['starting', 'running', 'waiting'].includes(status) ? 'active' : 'idle'),
    title: existing?.title ?? 'New conversation',
    titleSource: existing?.titleSource ?? 'draft',
    status,
    turnId: existing?.turnId ?? null,
    items: existing?.items ?? [],
    requests: existing?.requests ?? [],
    draft: existing?.draft ?? { text: '', attachments: [] },
    settings: existing?.settings ?? { modelId: null, reasoningEffort: null, autoAcceptMode: false },
    disposition: existing?.disposition ?? 'active',
    activityCursor: existing?.activityCursor ?? 0,
    settledCursor: existing?.settledCursor ?? null,
    readCursor: existing?.readCursor ?? 0,
    latestActivityAt: existing?.latestActivityAt ?? Date.now(),
    unread: existing?.unread ?? false,
    error: status === 'error' ? 'The Chat request failed in this fixture.' : null,
    revision: (existing?.revision ?? 0) + 1,
  };
  agentChatThreads.set(id, thread);
  return thread;
}

const agentChatModels: ChatModel[] = [
  {
    id: 'gpt-5.4-codex',
    label: 'GPT-5.4 Codex',
    description: 'Codex model available in the current environment.',
    isDefault: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  },
];

type FixtureArgs = Record<string, unknown>;

/**
 * `get_team_snapshot`, which reads a real repository — git history, `gh pr
 * list`, and any records under `.shipstudio-team/`. A capture machine has none
 * of those, so this stands in for it.
 *
 * Answered per invocation rather than as a frozen literal, so the fixture
 * adopts whichever project the scenario opened. The screens are about *your*
 * project with people in it, and a fixture naming a repo nobody has heard of
 * photographs the wrong idea.
 *
 * Exported because the home-level Team screen reads the same command for
 * several projects at once, and two copies of this would drift.
 */
export const teamSnapshotCommand = (args: Record<string, unknown>) => {
  const projectPath = typeof args.projectPath === 'string' ? args.projectPath : WORKSPACE_PROJECT;
  return buildTeamFixture({
    projectPath,
    projectName: projectPath.split('/').pop() || 'your project',
  });
};

export const workspaceCommands: CommandMap = {
  // ---- project identity & registration ----------------------------------
  get_workspace_subpath: null,
  get_project_account_id: 'default',
  get_project_window: null,
  register_project_for_window: null,
  register_project_session: null,
  ensure_external_project_registered: null,
  ensure_gitignore_has_shipstudio: null,
  mark_project_opened: null,
  set_window_title: null,
  get_auto_accept_mode: false,

  // ---- dev server --------------------------------------------------------
  // Null rather than a port: the harness has no dev server, and inventing a
  // running one would put the preview into a state the machine can't back up.
  get_dev_server_port: null,
  find_and_reserve_port: 3000,
  kill_port: null,
  get_force_static_serve: false,
  detect_project_type_command: 'nextjs',
  check_dependencies_installed: {
    installed: true,
    has_package_json: true,
    workspace_has_package_json: false,
  },
  // Asked for on every workspace open, on the path that decides which package
  // manager runs the dev script. Unmocked, it badged 41 of the 58 palette
  // captures incomplete — which by this harness's own rule means none of their
  // screenshots counted as evidence, and the sweep that is supposed to give
  // every feature visual coverage was blind. A plain string, per
  // `detectPackageManager` in `src/lib/github.ts` ("pnpm" | "yarn" | "bun" |
  // "npm"); 'pnpm' matches what this repo uses.
  detect_package_manager: 'pnpm',

  // Asked for on every workspace open. Unmocked it badged every workspace
  // capture incomplete, which by this harness's own rule means none of their
  // screenshots counted as evidence. `true` is the backend's default
  // (settings.rs: element_breadcrumb_enabled.unwrap_or(true)).
  get_element_breadcrumb_enabled: true,

  // ---- git / github ------------------------------------------------------
  get_project_github_status: {
    status: 'connected',
    github_repo: 'harness-user/acme-marketing',
    github_url: 'https://github.com/harness-user/acme-marketing',
    remote_host: null,
    remote_forge: null,
  },
  list_pull_requests: [],
  // Asked for on every workspace open (`useBranchManagement`). Without it
  // every workspace capture — including all ten hosting states — was badged
  // incomplete, which by this harness's own rule means their screenshots were
  // not evidence. False is the real answer for these fixtures: `get_conflict_info`
  // is empty and no scenario stages a conflicted merge.
  has_conflicts: false,
  list_worktrees: [],
  detect_workspaces: [],
  /**
   * Matches `uncommitted_count: 3` on the dashboard fixture — a workspace that
   * claimed three changes and then listed none would be exactly the kind of
   * quiet inconsistency this harness exists to make visible.
   */
  get_changed_files: [
    { path: 'src/app/pricing/page.tsx', status: 'modified' },
    { path: 'src/components/PricingTable.tsx', status: 'added' },
    { path: 'README.md', status: 'modified' },
  ],

  // ---- snapshots ---------------------------------------------------------
  snapshot_status: {
    watching: true,
    can_undo: false,
    can_redo: false,
    is_git_repo: true,
    history_size: 0,
    cursor: 0,
    files_changed: [],
  },
  snapshot_start_watching: null,

  // ---- code / files ------------------------------------------------------
  list_project_files: [
    { name: 'package.json', path: 'package.json', is_directory: false, size: 812 },
    { name: 'src', path: 'src', is_directory: true, size: 0 },
    { name: 'README.md', path: 'README.md', is_directory: false, size: 1240 },
  ],
  read_project_file: {
    content: '# acme-marketing\n\nHarness fixture file.\n',
    is_binary: false,
    is_truncated: false,
    size: 41,
    language: 'markdown',
  },

  // ---- terminal ----------------------------------------------------------
  // An explicitly empty tab list, not null: null makes the workspace seed a
  // default tab and try to spawn a real agent PTY, which cannot exist here and
  // fills the pane with retry noise that would show up in every screenshot.
  get_terminal_state: { tabs: [], active_tab_index: 0 },
  get_shell_path: '/bin/zsh',
  get_system_env: {},

  // ---- preview -----------------------------------------------------------
  check_browser_availability: [
    { id: 'chrome', name: 'Google Chrome' },
    { id: 'safari', name: 'Safari' },
  ],
  is_tailwind_active: false,
  get_hide_main_branch_warning: false,
  get_terminal_gpu_enabled: true,

  // ---- persistent Codex Chat --------------------------------------------
  // Every response matches the durable frontend contract. Draft and settings
  // writes return authoritative thread snapshots, as they do over Tauri IPC.
  agent_chat_list: (args: FixtureArgs) => {
    const projectPath = typeof args.projectPath === 'string' ? args.projectPath : WORKSPACE_PROJECT;
    return [...agentChatThreads.values()].filter((thread) => thread.projectPath === projectPath);
  },
  agent_chat_storage_status: { available: true, schemaVersion: 3, error: null },
  agent_chat_list_unlinked_projects: [],
  agent_chat_models: agentChatModels,
  agent_chat_list_drafts: (args: FixtureArgs) => {
    const projectPath = typeof args.projectPath === 'string' ? args.projectPath : WORKSPACE_PROJECT;
    const checkoutPath = typeof args.checkoutPath === 'string' ? args.checkoutPath : projectPath;
    const limit = typeof args.limit === 'number' ? args.limit : 50;
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const drafts = [...agentChatDrafts.values()]
      .filter(
        (draft) =>
          agentChatDraftProjects.get(draft.draftId) === projectPath &&
          draft.checkoutPath === checkoutPath
      )
      .sort((left, right) => right.savedAt - left.savedAt);
    return {
      drafts: drafts.slice(offset, offset + limit),
      nextOffset: offset + limit < drafts.length ? offset + limit : null,
    };
  },
  agent_chat_save_project_draft: (args: FixtureArgs) => {
    const draftId = typeof args.draftId === 'string' ? args.draftId : '';
    const projectPath = typeof args.projectPath === 'string' ? args.projectPath : WORKSPACE_PROJECT;
    const checkoutPath = typeof args.checkoutPath === 'string' ? args.checkoutPath : projectPath;
    const existing = agentChatDrafts.get(draftId);
    const draft =
      args.draft && typeof args.draft === 'object'
        ? (args.draft as SavedChatDraft['draft'])
        : { text: '', attachments: [] };
    const settings =
      args.settings && typeof args.settings === 'object'
        ? (args.settings as SavedChatDraft['settings'])
        : { modelId: null, reasoningEffort: null, autoAcceptMode: false };
    if (existing?.state === 'promoted' && existing.promotedThreadId) {
      const thread = agentChatThreads.get(existing.promotedThreadId);
      if (thread) {
        agentChatThreads.set(thread.id, {
          ...thread,
          draft,
          settings,
          revision: thread.revision + 1,
        });
      }
    }
    const savedDraft: SavedChatDraft = {
      draftId,
      projectId: existing?.projectId ?? 'harness-agent-chat-project',
      checkoutPath,
      checkoutStatus: 'available',
      draft,
      settings,
      savedAt: Date.now(),
      state: existing?.state ?? 'draft',
      promotedThreadId: existing?.promotedThreadId ?? null,
    };
    agentChatDrafts.set(draftId, savedDraft);
    agentChatDraftProjects.set(draftId, projectPath);
    return savedDraft;
  },
  agent_chat_delete_project_draft: (args: FixtureArgs) => {
    const draftId = typeof args.draftId === 'string' ? args.draftId : '';
    const savedDraft = agentChatDrafts.get(draftId);
    if (savedDraft?.state === 'promoted')
      throw new Error('Promoted drafts cannot be deleted here.');
    agentChatDrafts.delete(draftId);
    agentChatDraftProjects.delete(draftId);
    return null;
  },
  agent_chat_promote_draft: (args: FixtureArgs) => {
    const draftId = typeof args.draftId === 'string' ? args.draftId : '';
    const savedDraft = agentChatDrafts.get(draftId);
    if (!savedDraft) throw new Error('Save this draft before sending.');
    if (savedDraft.state === 'promoted' && savedDraft.promotedThreadId) {
      const existing = agentChatThreads.get(savedDraft.promotedThreadId);
      if (!existing) throw new Error('Promoted fixture thread is missing.');
      return existing;
    }
    const created = agentChatThreadFromArgs(args, 'idle');
    const promoted: ChatThread = {
      ...created,
      checkoutPath: savedDraft.checkoutPath,
      providerThreadId: `codex-${created.id}`,
      resumeStatus: 'available',
      providerStatus: 'idle',
      draft: savedDraft.draft,
      settings: savedDraft.settings,
    };
    agentChatThreads.set(promoted.id, promoted);
    agentChatDrafts.set(draftId, {
      ...savedDraft,
      state: 'promoted',
      promotedThreadId: promoted.id,
      savedAt: Date.now(),
    });
    return promoted;
  },
  agent_chat_create: (args: FixtureArgs) => agentChatThreadFromArgs(args, 'idle'),
  agent_chat_save_draft: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const draft =
      args.draft && typeof args.draft === 'object'
        ? (args.draft as ChatThread['draft'])
        : { text: '', attachments: [] };
    const updated = { ...thread, draft, revision: thread.revision + 1 };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_save_settings: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const settings =
      args.settings && typeof args.settings === 'object'
        ? (args.settings as ChatThread['settings'])
        : thread.settings;
    const updated = { ...thread, settings, revision: thread.revision + 1 };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_rename: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const title = typeof args.title === 'string' ? args.title.trim() : thread.title;
    const updated = {
      ...thread,
      title,
      titleSource: 'manual' as const,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_mark_read: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const updated = {
      ...thread,
      readCursor: thread.activityCursor,
      unread: false,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_settle: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    if (
      ['starting', 'running', 'waiting'].includes(thread.status) ||
      thread.providerStatus === 'active'
    ) {
      throw new Error('A busy conversation cannot be settled.');
    }
    const updated = {
      ...thread,
      disposition: 'settled' as const,
      settledCursor: thread.activityCursor,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_reopen: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const updated = {
      ...thread,
      disposition: 'active' as const,
      settledCursor: null,
      readCursor: thread.activityCursor,
      unread: false,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_resume_check: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const updated = {
      ...thread,
      checkoutStatus: 'available' as const,
      resumeStatus: thread.providerThreadId ? ('available' as const) : ('unavailable' as const),
      providerStatus:
        thread.providerStatus === 'active'
          ? ('active' as const)
          : thread.providerThreadId
            ? ('idle' as const)
            : ('unknown' as const),
      error: null,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_relink_checkout: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args);
    const checkoutPath =
      typeof args.checkoutPath === 'string' ? args.checkoutPath : thread.projectPath;
    const updated = {
      ...thread,
      checkoutPath,
      checkoutStatus: 'available' as const,
      resumeStatus: 'unknown' as const,
      providerStatus: 'unknown' as const,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_relink_project: (args: FixtureArgs) => {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    const projectPath = typeof args.projectPath === 'string' ? args.projectPath : WORKSPACE_PROJECT;
    for (const [id, thread] of agentChatThreads) {
      if (thread.projectId === projectId) {
        agentChatThreads.set(id, { ...thread, projectPath, revision: thread.revision + 1 });
      }
    }
    return null;
  },
  agent_chat_send: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args, 'running');
    const turnId = `turn-${thread.id}`;
    const text = typeof args.text === 'string' ? args.text : '';
    const updated: ChatThread = {
      ...thread,
      turnId,
      revision: thread.revision + 1,
      activityCursor: thread.activityCursor + 1,
      latestActivityAt: Date.now(),
      providerStatus: 'active',
      settings: {
        modelId: typeof args.model === 'string' ? args.model : null,
        reasoningEffort: typeof args.effort === 'string' ? args.effort : null,
        autoAcceptMode: args.autoAcceptMode === true,
      },
      draft: { text: '', attachments: [] },
      items: [
        {
          id: `user-${turnId}`,
          turnId,
          kind: 'user',
          text,
          status: null,
          attachments: Array.isArray(args.attachments)
            ? (args.attachments as ChatAttachment[])
            : [],
        },
        {
          id: `assistant-${turnId}`,
          turnId,
          kind: 'assistant',
          text: 'The harness is showing a representative streaming response.',
          status: 'streaming',
          attachments: [],
        },
      ],
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_interrupt: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args, 'interrupted');
    const updated = { ...thread, revision: thread.revision + 1 };
    updated.providerStatus = 'idle';
    updated.turnId = null;
    updated.latestActivityAt = Date.now();
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_respond: (args: FixtureArgs) => {
    const thread = agentChatThreadFromArgs(args, 'idle');
    const requestId = typeof args.requestId === 'string' ? args.requestId : null;
    const updated: ChatThread = {
      ...thread,
      requests: thread.requests.filter((request) => request.id !== requestId),
      providerStatus: 'idle',
      turnId: null,
      revision: thread.revision + 1,
    };
    agentChatThreads.set(updated.id, updated);
    return updated;
  },
  agent_chat_discard: (args: FixtureArgs) => {
    if (args.confirmed !== true) throw new Error('Confirm before discarding this local history.');
    if (typeof args.threadId === 'string') agentChatThreads.delete(args.threadId);
    return null;
  },
  agent_chat_stage_attachment: (args: FixtureArgs) => {
    const path = typeof args.path === 'string' ? args.path : `${WORKSPACE_PROJECT}/screenshot.png`;
    const name = path.split('/').pop() || 'screenshot.png';
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    const mimeTypeByExtension: Record<string, string> = {
      avif: 'image/avif',
      gif: 'image/gif',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
      png: 'image/png',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      webp: 'image/webp',
    };
    const mimeType = mimeTypeByExtension[extension] ?? 'application/octet-stream';
    const kind = mimeType.startsWith('image/') ? 'image' : 'file';
    return {
      id: `attachment-${name}`,
      name,
      path,
      mimeType,
      size: 184_320,
      kind,
      available: true,
    };
  },

  // ---- agent bridge ------------------------------------------------------
  // Inert: the bridge registers a loopback MCP server against a real agent CLI,
  // which the harness has no business doing.
  get_agent_bridge_url: '',
  get_agent_bridge_active_url: '',
  agent_bridge_attach: null,

  // ---- terminal plumbing --------------------------------------------------
  // The harness has no PTY. These answer the shape the caller expects so the
  // terminal renders its chrome, and stop there — no session is really open.
  resolve_cli_path: { path: '/opt/homebrew/bin/claude', dir: '/opt/homebrew/bin' },
  attached_library_dirs: [],
  pty_session_open: { sessionId: 'harness-session', pid: 0 },
  pty_session_attach: null,
  pty_session_resize: null,
  pty_session_write: null,
  pty_session_close: null,

  // ---- MCP registration ---------------------------------------------------
  // Inert on purpose: registering an MCP server writes to the user's real
  // agent config, which a screenshot run must never do.
  register_cursor_mcp: false,
  add_mcp_server: null,
  remove_mcp_server: null,

  // ---- plugins -----------------------------------------------------------
  list_plugins: [],

  // ---- team --------------------------------------------------------------
  // Read on every workspace open, because the header's presence cluster mounts
  // with the workspace. It lives here rather than in the Team scenarios for
  // exactly that reason: without it every workspace capture -- all ten hosting
  // states included -- is badged incomplete, and by this harness's own rule an
  // incomplete screenshot is not evidence.
  get_team_snapshot: teamSnapshotCommand,
  // Opening a project exchanges comments with the remote, so every workspace
  // capture reaches this. A capture machine has no remote; the honest fixture
  // is a sync that found nothing to do, which is also the common real answer.
  sync_team_threads: { pulled: 0, pushed: 0, pending: 0, error: null, hasRemote: false },
};
