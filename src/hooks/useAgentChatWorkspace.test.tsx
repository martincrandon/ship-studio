import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  threads: [] as Array<{ status: string }>,
  snapshot: {
    threads: [] as Array<{ status: string }>,
    selectedCheckoutPath: '/tmp/project',
    selectedThreadId: null as string | null,
    selectedDraftId: null as string | null,
    threadSettings: {} as Record<string, never>,
    savedDrafts: [] as Array<Record<string, unknown>>,
    drafts: {} as Record<string, string>,
    stagedAttachments: {} as Record<string, unknown[]>,
    draftCheckoutPaths: {} as Record<string, string>,
    draftThreadIds: {} as Record<string, string>,
    loadingDraftCheckouts: [] as string[],
    draftPageOffsets: {} as Record<string, number | null>,
    draftPageErrors: {} as Record<string, string>,
    threadErrors: {} as Record<string, string>,
    models: [],
  },
  snapshots: new Map<string, Record<string, unknown>>(),
  loadProject: vi.fn(),
  loadDrafts: vi.fn(),
  selectThread: vi.fn(),
  selectDraft: vi.fn(),
  setProjectView: vi.fn(() => true),
  showToast: vi.fn(),
}));

vi.mock('../commands/useAgentChatCommands', () => ({ useAgentChatCommands: vi.fn() }));
vi.mock('./useAgentChatCaptureState', () => ({
  useAgentChatCaptureState: () => ({ target: null }),
}));
vi.mock('./useAgentChatPreferences', () => ({
  useAgentChatPreferences: () => ({
    defaultView: 'chat',
    projectView: 'terminal',
    setProjectView: mocks.setProjectView,
    useDefaultView: vi.fn(() => true),
    view: 'terminal',
  }),
}));
vi.mock('../lib/agentChatStore', () => ({
  getAgentChatSnapshot: (projectPath: string) =>
    (mocks.snapshots.get(projectPath) as typeof mocks.snapshot | undefined) ?? mocks.snapshot,
  subscribeAgentChat: () => () => undefined,
  loadAgentChatProject: mocks.loadProject,
  loadAgentChatDrafts: mocks.loadDrafts,
  selectAgentChatThread: mocks.selectThread,
  selectAgentChatSavedDraft: mocks.selectDraft,
  setAgentChatThreadSettings: vi.fn(),
}));

import { useAgentChatWorkspace } from './useAgentChatWorkspace';
import type { ChatThread } from '../lib/agentChat';
import { getAgentChatInboxEntries } from '../lib/agentChatInbox';
import {
  getAgentWorkspaceNavigationRequest,
  requestAgentWorkspaceNavigation,
} from '../lib/agentWorkspaceNavigation';

function projectSnapshot(threads: ChatThread[], projectPath: string) {
  return {
    ...mocks.snapshot,
    threads,
    selectedCheckoutPath: projectPath,
    savedDrafts: [],
    drafts: {},
    stagedAttachments: {},
    draftCheckoutPaths: {},
    draftThreadIds: {},
    threadErrors: {},
    selectedThreadId: null,
    selectedDraftId: null,
    threadSettings: {},
  };
}

function chatThread(
  projectPath: string,
  id: string,
  disposition: 'active' | 'settled' = 'active'
): ChatThread {
  return {
    id,
    projectId: `id-${projectPath}`,
    projectPath,
    checkoutPath: projectPath,
    checkoutStatus: 'available',
    providerId: 'codex',
    providerThreadId: `provider-${id}`,
    resumeStatus: 'available',
    providerStatus: 'idle',
    title: id,
    titleSource: 'prompt',
    status: 'idle',
    turnId: null,
    items: [],
    requests: [],
    draft: { text: '', attachments: [] },
    settings: { modelId: null, reasoningEffort: null, autoAcceptMode: false },
    disposition,
    activityCursor: 0,
    settledCursor: disposition === 'settled' ? 0 : null,
    readCursor: 0,
    latestActivityAt: 1,
    unread: false,
    error: null,
    revision: 1,
  };
}

describe('useAgentChatWorkspace sidebar activity', () => {
  afterEach(() => {
    mocks.threads = [];
    mocks.snapshot = projectSnapshot([], '/tmp/project');
    mocks.snapshots.clear();
    mocks.loadProject.mockReset().mockResolvedValue(undefined);
    mocks.loadDrafts.mockReset().mockResolvedValue(undefined);
    mocks.selectThread.mockReset();
    mocks.selectDraft.mockReset();
    mocks.setProjectView.mockReset().mockReturnValue(true);
    mocks.showToast.mockReset();
  });

  it('keeps a running Chat thread thinking in the sidebar when Terminal is selected', () => {
    mocks.threads = [{ status: 'running' }];
    mocks.snapshot = projectSnapshot(mocks.threads as ChatThread[], '/tmp/project');

    const { result } = renderHook(() =>
      useAgentChatWorkspace({
        projectPath: '/tmp/project',
        worktrees: [],
        onCreateWorktree: vi.fn(),
        setAgentPanelHidden: vi.fn(),
        setPreviewHidden: vi.fn(),
        showToast: vi.fn(),
      })
    );

    expect(result.current.view).toBe('terminal');
    expect(result.current.sidebarActivity).toBe('thinking');
  });

  it.each([
    ['starting', 'active'],
    ['waiting', 'active'],
    ['interrupted', 'idle'],
    ['closed', 'idle'],
  ] as const)('maps %s Chat status to %s in the sidebar', (status, activity) => {
    mocks.threads = [{ status }];
    mocks.snapshot = projectSnapshot(mocks.threads as ChatThread[], '/tmp/project');

    const { result } = renderHook(() =>
      useAgentChatWorkspace({
        projectPath: '/tmp/project',
        worktrees: [],
        onCreateWorktree: vi.fn(),
        setAgentPanelHidden: vi.fn(),
        setPreviewHidden: vi.fn(),
        showToast: vi.fn(),
      })
    );

    expect(result.current.sidebarActivity).toBe(activity);
  });

  it('applies an exact Chat target only in its project and excludes settled rows', async () => {
    const projectA = '/tmp/project-a';
    const projectB = '/tmp/project-b';
    const active = chatThread(projectB, 'thread-b-active');
    const settled = chatThread(projectB, 'thread-b-settled', 'settled');
    mocks.snapshots.set(projectA, projectSnapshot([], projectA));
    mocks.snapshots.set(projectB, projectSnapshot([active, settled], projectB));
    requestAgentWorkspaceNavigation(projectB, { kind: 'chat-thread', threadId: active.id });

    const setAgentPanelHidden = vi.fn();
    const { rerender } = renderHook(
      ({ projectPath }) =>
        useAgentChatWorkspace({
          projectPath,
          worktrees: [],
          onCreateWorktree: vi.fn(),
          setAgentPanelHidden,
          setPreviewHidden: vi.fn(),
          showToast: mocks.showToast,
        }),
      { initialProps: { projectPath: projectA } }
    );

    expect(mocks.selectThread).not.toHaveBeenCalled();
    expect(getAgentWorkspaceNavigationRequest(projectB)).not.toBeNull();
    expect(
      getAgentChatInboxEntries(
        mocks.snapshots.get(projectB) as ReturnType<typeof projectSnapshot>
      ).map((entry) => (entry.kind === 'thread' ? entry.thread.id : entry.draftId))
    ).toEqual([active.id]);

    rerender({ projectPath: projectB });

    await waitFor(() => expect(mocks.selectThread).toHaveBeenCalledWith(projectB, active.id));
    expect(mocks.setProjectView).toHaveBeenCalledWith('chat');
    expect(setAgentPanelHidden).toHaveBeenCalledWith(false);
    expect(getAgentWorkspaceNavigationRequest(projectB)).toBeNull();
    expect(mocks.selectThread).not.toHaveBeenCalledWith(projectA, active.id);
  });
});
