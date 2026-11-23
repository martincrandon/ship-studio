/** Contract-shaped snapshots for the persistent Codex Chat workspace surface. */

import type { ChatModel, ChatThread, SavedChatDraft } from '../../lib/agentChat';
import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

const defaultChatView = { 'shipstudio.agentChat.defaultView': 'chat' };
const savedDraftFixture: SavedChatDraft = {
  draftId: '0f78c222-2d89-4e49-9b5c-40dd234a2d7f',
  projectId: 'harness-agent-chat-project',
  checkoutPath: WORKSPACE_PROJECT,
  checkoutStatus: 'available',
  draft: { text: 'Check the new checkout flow before I send it.', attachments: [] },
  settings: { modelId: 'gpt-5.4-codex', reasoningEffort: 'medium', autoAcceptMode: false },
  savedAt: Date.now() - 300_000,
  state: 'draft',
  promotedThreadId: null,
};
const existingWorktree = {
  path: `${WORKSPACE_PROJECT}-worktrees/feature-redesign`,
  head: '98af2d1',
  branch: 'feat/redesign',
  is_main: false,
  is_current: false,
  locked: null,
  prunable: null,
  last_commit_date: Date.now() - 3_600_000,
};

function thread(overrides: Partial<ChatThread>): ChatThread {
  return {
    id: 'chat-harness-thread',
    projectId: 'harness-agent-chat-project',
    projectPath: WORKSPACE_PROJECT,
    checkoutPath: WORKSPACE_PROJECT,
    checkoutStatus: 'available',
    providerId: 'codex',
    providerThreadId: 'codex-thread-harness',
    resumeStatus: 'available',
    providerStatus:
      overrides.status && ['starting', 'running', 'waiting'].includes(overrides.status)
        ? 'active'
        : 'idle',
    title: 'Review the pricing page',
    titleSource: 'prompt',
    status: 'idle',
    turnId: null,
    approvalPolicy: null,
    sandboxPolicy: null,
    turns: [],
    items: [],
    requests: [],
    draft: { text: '', attachments: [] },
    settings: { modelId: 'gpt-5.4-codex', reasoningEffort: 'medium', autoAcceptMode: false },
    disposition: 'active',
    activityCursor: 4,
    settledCursor: null,
    readCursor: 4,
    latestActivityAt: Date.now() - 60_000,
    unread: false,
    error: null,
    revision: 4,
    ...overrides,
  };
}

function projectSnapshot(threads: ChatThread[] = []) {
  return { projectId: 'harness-agent-chat-project', threads };
}

const userMessage = {
  id: 'chat-user-1',
  turnId: 'chat-turn-1',
  kind: 'user' as const,
  text: 'Review the pricing page for responsive layout issues.',
  status: null,
  attachments: [],
};

const streamingThread = thread({
  status: 'running',
  turnId: 'chat-turn-1',
  items: [
    userMessage,
    {
      id: 'chat-assistant-1',
      turnId: 'chat-turn-1',
      kind: 'assistant',
      text: 'I’m checking the page layout at the narrow and wide breakpoints…',
      status: 'streaming',
      attachments: [],
    },
    {
      id: 'chat-tool-1',
      turnId: 'chat-turn-1',
      kind: 'tool',
      text: 'Read src/app/pricing/page.tsx\nRead src/components/PricingTable.tsx',
      status: 'completed',
      attachments: [],
    },
  ],
});

const approvalThread = thread({
  status: 'waiting',
  turnId: 'chat-turn-1',
  items: [userMessage],
  requests: [
    {
      id: 'approval-build-1',
      method: 'item/commandExecution/requestApproval',
      kind: 'approval',
      title: 'Run the production build?',
      params: {
        command: 'pnpm build',
        cwd: WORKSPACE_PROJECT,
        reason: 'Codex wants to verify the pricing page changes.',
        availableDecisions: ['accept', 'decline'],
      },
    },
  ],
});

const amendmentApprovalThread = thread({
  id: 'chat-amendment-approval-thread',
  status: 'waiting',
  turnId: 'chat-turn-amendment',
  items: [userMessage],
  requests: [
    {
      id: 'approval-policy-1',
      method: 'item/commandExecution/requestApproval',
      kind: 'approval',
      title: 'Allow the requested command policy?',
      params: {
        command: 'pnpm install',
        cwd: WORKSPACE_PROJECT,
        availableDecisions: [
          { acceptWithExecpolicyAmendment: { reason: 'Allow this command for the project' } },
        ],
      },
    },
  ],
});

const questionThread = thread({
  status: 'waiting',
  turnId: 'chat-turn-1',
  items: [userMessage],
  requests: [
    {
      id: 'question-style-1',
      method: 'item/tool/requestUserInput',
      kind: 'question',
      title: 'Choose a pricing card style',
      params: {
        questions: [
          {
            id: 'card-style',
            header: 'Visual direction',
            question: 'Which card style should Codex use?',
            options: [
              { label: 'Quiet', description: 'Subtle borders and muted surfaces' },
              { label: 'Emphasized', description: 'Clear accent on the recommended plan' },
            ],
            isOther: true,
            isSecret: false,
          },
        ],
      },
    },
  ],
});

const errorThread = thread({
  status: 'error',
  turnId: 'chat-turn-1',
  error: 'Codex disconnected before it could finish this turn.',
  items: [
    userMessage,
    {
      id: 'chat-error-1',
      turnId: 'chat-turn-1',
      kind: 'error',
      text: 'The provider connection closed unexpectedly. Your draft is still available.',
      status: null,
      attachments: [],
    },
  ],
});

const attachmentThread = thread({
  items: [
    {
      ...userMessage,
      attachments: [
        {
          id: 'chat-file-1',
          name: 'pricing-layout.png',
          path: `${WORKSPACE_PROJECT}/.shipstudio/screenshots/pricing-layout.png`,
          mimeType: 'image/png',
          size: 231_424,
          kind: 'file',
        },
      ],
    },
  ],
});

const unavailableThread = thread({
  id: 'chat-unavailable-thread',
  title: 'Model discovery unavailable',
});

const unreadActiveThread = thread({
  id: 'chat-unread-thread',
  title: 'Review the homepage copy',
  activityCursor: 7,
  readCursor: 5,
  unread: true,
  latestActivityAt: Date.now() - 5_000,
});

const waitingInboxThread = thread({
  ...approvalThread,
  id: 'chat-waiting-inbox-thread',
  title: 'Approve the production build',
  activityCursor: 9,
  readCursor: 7,
  unread: true,
  latestActivityAt: Date.now() - 20_000,
});

const settledThread = thread({
  id: 'chat-settled-thread',
  title: 'Audit the contact form',
  disposition: 'settled',
  settledCursor: 3,
  activityCursor: 3,
  readCursor: 3,
  latestActivityAt: Date.now() - 3_600_000,
});

const missingCheckoutThread = thread({
  id: 'chat-missing-checkout-thread',
  title: 'Recover a removed worktree conversation',
  checkoutPath: `${WORKSPACE_PROJECT}-worktrees/removed-checkout`,
  checkoutStatus: 'missing',
  resumeStatus: 'unknown',
  providerStatus: 'unknown',
  status: 'interrupted',
  error: 'The original checkout is unavailable.',
});

const unavailableResumeThread = thread({
  id: 'chat-unavailable-resume-thread',
  title: 'Saved transcript without provider resume',
  resumeStatus: 'unavailable',
  providerStatus: 'unknown',
  status: 'interrupted',
  error: 'Codex could not resume this conversation. Local display history remains available.',
});

const staleModelThread = thread({
  id: 'chat-stale-model-thread',
  title: 'Conversation with a removed model',
  settings: { modelId: 'gpt-old-unavailable', reasoningEffort: 'high', autoAcceptMode: false },
});

function chatScenario(
  id: string,
  title: string,
  looksRightWhen: string,
  chatThread: ChatThread | null,
  requires: string,
  models = workspaceCommands.agent_chat_models
): Scenario {
  return {
    id,
    title,
    looksRightWhen,
    project: WORKSPACE_PROJECT,
    storage: defaultChatView,
    ...(chatThread
      ? {
          steps: [{ click: `.agent-chat__thread-select[data-thread-id="${chatThread.id}"]` }],
        }
      : {}),
    requires,
    commands: {
      ...workspaceCommands,
      list_worktrees: [existingWorktree],
      agent_chat_list: projectSnapshot(chatThread ? [chatThread] : []),
      agent_chat_models: models,
    },
  };
}

export const agentChatScenarios: Scenario[] = [
  {
    ...chatScenario(
      'agent-chat-plain-folder',
      'Agent Chat — registered plain folder',
      'A non-Git folder keeps its durable local composer and shows that Chat history is app-owned while worktree controls are hidden.',
      null,
      '.agent-chat__checkout-note'
    ),
    commands: {
      ...workspaceCommands,
      snapshot_status: {
        watching: true,
        can_undo: false,
        can_redo: false,
        is_git_repo: false,
        history_size: 0,
        cursor: 0,
        files_changed: [],
      },
      agent_chat_project_mode: { isGitRepository: false },
      list_worktrees: [],
      agent_chat_list: projectSnapshot(),
      agent_chat_list_drafts: { drafts: [], nextOffset: null },
    },
  },
  chatScenario(
    'agent-chat-empty',
    'Agent Chat — empty project',
    'The Chat view opens without an implicit native thread and leaves the current checkout ready for a first prompt.',
    null,
    'textarea[aria-label="Message Codex"]'
  ),
  chatScenario(
    'agent-chat-empty-draft',
    'Agent Chat — blank draft',
    'Chat opens directly to a blank editable composer with concise inline guidance. No thread is created until the first Send, and the current checkout is the draft scope.',
    null,
    'textarea[aria-label="Message Codex"]'
  ),
  {
    ...chatScenario(
      'agent-chat-saved-drafts',
      'Agent Chat — saved drafts',
      'The project inbox keeps an older provider-free draft selectable alongside conversations, and selecting it restores its stored composer settings.',
      null,
      `.agent-chat__thread-select[data-draft-id="${savedDraftFixture.draftId}"]`
    ),
    steps: [{ click: `.agent-chat__thread-select[data-draft-id="${savedDraftFixture.draftId}"]` }],
    commands: {
      ...workspaceCommands,
      list_worktrees: [existingWorktree],
      agent_chat_list: projectSnapshot(),
      agent_chat_list_drafts: {
        drafts: [savedDraftFixture],
        nextOffset: null,
      },
    },
  },
  {
    ...chatScenario(
      'agent-chat-long-model-label',
      'Agent Chat — long model label',
      'At the minimum Agent panel width, a long model label truncates while the chevron, effort, attach, and send controls remain visible. Selecting a model and effort updates both labels.',
      null,
      'textarea[aria-label="Message Codex"]',
      [
        {
          ...(workspaceCommands.agent_chat_models as ChatModel[])[0],
          label:
            'GPT-5.4 Codex — Existing default with a deliberately long descriptive fixture label',
        },
        {
          ...(workspaceCommands.agent_chat_models as ChatModel[])[0],
          id: 'gpt-5.4-codex-alternate-fixture',
          label: 'GPT-5.4 Codex — Alternate long-label fixture for responsive control selection',
          isDefault: false,
        },
      ]
    ),
    steps: [
      { click: 'button[aria-label="Model"]' },
      { click: '.agent-chat__setting-menu [role="menuitem"]:last-child' },
      { click: 'button[aria-label="Reasoning effort"]' },
      { click: '.agent-chat__setting-menu [role="menuitem"]:last-child' },
    ],
  },
  chatScenario(
    'agent-chat-streaming',
    'Agent Chat — streaming response',
    'A live thread shows its user message, partial assistant text, completed tool activity, and a working state while retaining its independent Stop control.',
    streamingThread,
    '.agent-chat-item[data-kind="assistant"]'
  ),
  chatScenario(
    'agent-chat-approval',
    'Agent Chat — command approval',
    'A waiting thread shows the exact command and checkout, with separate Allow and Decline actions for this request.',
    approvalThread,
    '.agent-chat-request[data-kind="approval"]'
  ),
  chatScenario(
    'agent-chat-approval-amendment',
    'Agent Chat — policy amendment approval',
    'An object-valued policy amendment option is shown with its supported response, and Stop turn remains available as a safe rejection path when no decline option was offered.',
    amendmentApprovalThread,
    'Stop turn'
  ),
  chatScenario(
    'agent-chat-question',
    'Agent Chat — user question',
    'A waiting thread presents a structured question with answer choices and a submit action.',
    questionThread,
    '.agent-chat-request[data-kind="question"]'
  ),
  chatScenario(
    'agent-chat-error',
    'Agent Chat — disconnected turn',
    'The thread status and transcript preserve a truthful provider error and keep the conversation draft available.',
    errorThread,
    '.agent-chat__send-error'
  ),
  chatScenario(
    'agent-chat-attachment',
    'Agent Chat — attached file',
    'The transcript shows a named attachment in the user message with its file type preserved.',
    attachmentThread,
    '.agent-chat-attachment--file'
  ),
  chatScenario(
    'agent-chat-models-unavailable',
    'Agent Chat — models unavailable',
    'The current conversation remains visible while the model selector states that no models were returned.',
    unavailableThread,
    '.agent-chat__setting-trigger[aria-label="Model"]:disabled',
    []
  ),
  {
    ...chatScenario(
      'agent-chat-project-inbox',
      'Agent Chat — project inbox activity',
      'The project conversation list shows latest activity, unread markers, an active turn, a waiting approval, and a collapsed Settled count without adding a workspace column.',
      unreadActiveThread,
      '.agent-chat__inbox-unread'
    ),
    commands: {
      ...workspaceCommands,
      list_worktrees: [existingWorktree],
      agent_chat_list: projectSnapshot([
        streamingThread,
        unreadActiveThread,
        waitingInboxThread,
        settledThread,
      ]),
    },
  },
  {
    id: 'agent-chat-sidebar-mixed-navigation',
    title: 'Agents sidebar — Terminal and Chat entries',
    looksRightWhen:
      'The Agents section shows the existing Claude terminal, active Chat conversations, and a saved draft in one list. Chat rows identify themselves in metadata, settled history is absent, and Terminal remains the selected view.',
    project: WORKSPACE_PROJECT,
    requires: '.sidebar-project-body-inner .sidebar-section-list .sidebar-row',
    commands: {
      ...workspaceCommands,
      get_terminal_state: {
        tabs: [
          {
            agent_id: 'claude',
            session_id: 'harness-sidebar-terminal-session',
            custom_title: 'Claude Session',
          },
        ],
        active_tab_index: 0,
      },
      list_worktrees: [existingWorktree],
      agent_chat_list: projectSnapshot([streamingThread, waitingInboxThread, settledThread]),
      agent_chat_list_drafts: { drafts: [savedDraftFixture], nextOffset: null },
    },
  },
  {
    ...chatScenario(
      'agent-chat-settled-expanded',
      'Agent Chat — settled history',
      'Settled remains collapsed by default and expands to show a history row that can be reopened without changing selection.',
      settledThread,
      '.agent-chat__thread-list--settled'
    ),
    steps: [
      { click: '.agent-chat__settled-toggle' },
      { click: `.agent-chat__thread-select[data-thread-id="${settledThread.id}"]` },
    ],
    commands: { ...workspaceCommands, agent_chat_list: projectSnapshot([settledThread]) },
  },
  chatScenario(
    'agent-chat-missing-checkout',
    'Agent Chat — missing checkout recovery',
    'A saved transcript stays visible with its missing checkout identified and an explicit relink action.',
    missingCheckoutThread,
    '.agent-chat__relink-trigger'
  ),
  chatScenario(
    'agent-chat-history-only',
    'Agent Chat — history without provider resume',
    'The local transcript stays readable while the UI states that Codex cannot resume it and blocks follow-up sends.',
    unavailableResumeThread,
    'Saved history only'
  ),
  chatScenario(
    'agent-chat-stale-model',
    'Agent Chat — saved model unavailable',
    'An undiscovered saved model remains visible by ID, does not fall back silently, and disables Send until a discovered model is selected.',
    staleModelThread,
    'Unavailable: gpt-old-unavailable'
  ),
  {
    ...chatScenario(
      'agent-chat-storage-unavailable',
      'Agent Chat — storage unavailable',
      'The panel reports that persistent storage is unavailable and preserves the distinction between saved local history and the current draft.',
      null,
      '.agent-chat__recovery--error'
    ),
    commands: {
      ...workspaceCommands,
      agent_chat_storage_status: {
        available: false,
        schemaVersion: 7,
        error: 'The Agent Chat database could not be opened.',
      },
    },
  },
  {
    ...chatScenario(
      'agent-chat-unlinked-project',
      'Agent Chat — unlinked project recovery',
      'A stored project identity with an unavailable prior path is offered for explicit relinking to the open folder.',
      null,
      'Link saved conversations here'
    ),
    commands: {
      ...workspaceCommands,
      agent_chat_list_unlinked_projects: [
        {
          id: 'stored-project-harness-id',
          identityKey: '/old/path/acme-marketing/.git',
          lastPath: '/old/path/acme-marketing',
          threadCount: 3,
        },
      ],
    },
  },
];
