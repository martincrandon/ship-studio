import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment, ChatThread, SavedChatDraft } from './agentChat';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  listThreads: vi.fn(),
  listDrafts: vi.fn(),
  listModels: vi.fn(),
  createThread: vi.fn(),
  discardThread: vi.fn(),
  send: vi.fn(),
  stageAttachment: vi.fn(),
  recheckAttachments: vi.fn(),
  saveDraft: vi.fn(),
  saveProjectDraft: vi.fn(),
  deleteProjectDraft: vi.fn(),
  promoteDraft: vi.fn(),
  saveSettings: vi.fn(),
  getStorageStatus: vi.fn(),
  listUnlinkedProjects: vi.fn(),
  markRead: vi.fn(),
  settleThread: vi.fn(),
  renameThread: vi.fn(),
  reopenThread: vi.fn(),
  resumeCheck: vi.fn(),
  relinkCheckout: vi.fn(),
  relinkProject: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('./agentChat', () => ({
  createAgentChatThreadCommand: mocks.createThread,
  discardAgentChatCommand: mocks.discardThread,
  interruptAgentChatCommand: vi.fn(),
  listAgentChatModels: mocks.listModels,
  listAgentChatDrafts: mocks.listDrafts,
  listAgentChatThreads: mocks.listThreads,
  saveAgentChatDraftCommand: mocks.saveDraft,
  saveAgentChatProjectDraftCommand: mocks.saveProjectDraft,
  deleteAgentChatProjectDraftCommand: mocks.deleteProjectDraft,
  promoteAgentChatDraftCommand: mocks.promoteDraft,
  saveAgentChatSettingsCommand: mocks.saveSettings,
  getAgentChatStorageStatusCommand: mocks.getStorageStatus,
  listUnlinkedAgentChatProjectsCommand: mocks.listUnlinkedProjects,
  markAgentChatThreadReadCommand: mocks.markRead,
  settleAgentChatThreadCommand: mocks.settleThread,
  renameAgentChatThreadCommand: mocks.renameThread,
  reopenAgentChatThreadCommand: mocks.reopenThread,
  resumeCheckAgentChatThreadCommand: mocks.resumeCheck,
  relinkAgentChatCheckoutCommand: mocks.relinkCheckout,
  relinkAgentChatProjectCommand: mocks.relinkProject,
  respondAgentChatCommand: vi.fn(),
  sendAgentChatCommand: mocks.send,
  stageAgentChatAttachmentCommand: mocks.stageAttachment,
  recheckAgentChatAttachmentsCommand: mocks.recheckAttachments,
}));

let emitThread: ((event: { payload: ChatThread }) => void) | undefined;

function thread(
  id: string,
  projectPath: string,
  revision: number,
  title: string,
  status: ChatThread['status'] = 'idle'
): ChatThread {
  return {
    id,
    projectId: 'project-agent-chat-store-fixture',
    projectPath,
    checkoutPath: projectPath,
    checkoutStatus: 'available',
    providerId: 'codex',
    providerThreadId: `codex-${id}`,
    resumeStatus: 'available',
    providerStatus: 'idle',
    title,
    titleSource: 'prompt',
    status,
    turnId: null,
    items: [],
    requests: [],
    draft: { text: '', attachments: [] },
    settings: { modelId: null, reasoningEffort: null, autoAcceptMode: false },
    disposition: 'active',
    activityCursor: 0,
    settledCursor: null,
    readCursor: 0,
    latestActivityAt: 1000,
    unread: false,
    error: null,
    revision,
  };
}

describe('agent chat event reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.listen.mockReset();
    mocks.listThreads.mockReset();
    mocks.listDrafts.mockReset().mockResolvedValue({ drafts: [], nextOffset: null });
    mocks.listModels.mockReset();
    mocks.createThread.mockReset();
    mocks.discardThread.mockReset();
    mocks.send.mockReset();
    mocks.stageAttachment.mockReset();
    mocks.recheckAttachments
      .mockReset()
      .mockImplementation((_projectPath: string, attachments: ChatAttachment[]) =>
        Promise.resolve(attachments.map((attachment) => ({ ...attachment, available: true })))
      );
    mocks.saveDraft
      .mockReset()
      .mockImplementation((projectPath: string, threadId: string, draft: ChatThread['draft']) =>
        Promise.resolve({
          ...thread(threadId, projectPath, 2, 'Conversation'),
          draft,
        })
      );
    mocks.saveProjectDraft
      .mockReset()
      .mockImplementation(
        (
          _projectPath: string,
          checkoutPath: string,
          draftId: string,
          draft: SavedChatDraft['draft'],
          settings: SavedChatDraft['settings']
        ) =>
          Promise.resolve({
            draftId,
            projectId: 'project-agent-chat-store-fixture',
            checkoutPath,
            checkoutStatus: 'available',
            draft,
            settings,
            savedAt: Date.now(),
            state: 'draft',
            promotedThreadId: null,
          })
      );
    mocks.deleteProjectDraft.mockReset().mockResolvedValue(undefined);
    mocks.promoteDraft.mockReset();
    mocks.saveSettings
      .mockReset()
      .mockImplementation(
        (projectPath: string, threadId: string, settings: ChatThread['settings']) =>
          Promise.resolve({
            ...thread(threadId, projectPath, 2, 'Conversation'),
            settings,
          })
      );
    mocks.getStorageStatus
      .mockReset()
      .mockResolvedValue({ available: true, schemaVersion: 3, error: null });
    mocks.listUnlinkedProjects.mockReset().mockResolvedValue([]);
    mocks.markRead.mockReset();
    mocks.settleThread.mockReset();
    mocks.renameThread.mockReset();
    mocks.reopenThread.mockReset();
    mocks.resumeCheck.mockReset();
    mocks.relinkCheckout.mockReset();
    mocks.relinkProject.mockReset();
    localStorage.clear();
    emitThread = undefined;
  });

  it('rehydrates saved draft attachment availability without replacing dirty edits or selection', async () => {
    const projectPath = '/projects/agent-chat-attachment-hydration';
    const recoveredDraftId = '00000000-0000-4000-8000-000000000001';
    const blockedDraftId = '00000000-0000-4000-8000-000000000002';
    const recoveredAttachment: ChatAttachment = {
      id: 'owned-image',
      name: 'capture.png',
      path: '/agent-chat/attachments/owned-image.png',
      mimeType: 'image/png',
      size: 2048,
      kind: 'image',
      available: false,
    };
    const removedAttachment: ChatAttachment = {
      id: 'removed-file',
      name: 'removed.txt',
      path: '/agent-chat/attachments/removed.txt',
      mimeType: 'text/plain',
      size: 128,
      kind: 'file',
      available: false,
    };
    const blockedAttachment: ChatAttachment = {
      id: 'missing-image',
      name: 'missing.png',
      path: '/agent-chat/attachments/missing-image.png',
      mimeType: 'image/png',
      size: 512,
      kind: 'image',
      available: false,
    };
    localStorage.setItem(
      `shipstudio.agentChat.localState:${encodeURIComponent(projectPath)}`,
      JSON.stringify({
        version: 4,
        projectId: 'project-agent-chat-store-fixture',
        selectedThreadId: null,
        selectedDraftId: recoveredDraftId,
        selectedCheckoutPath: projectPath,
        draftCheckoutPaths: {
          [recoveredDraftId]: projectPath,
          [blockedDraftId]: projectPath,
        },
        draftThreadIds: {},
        activeDraftIdsByCheckout: { [projectPath]: recoveredDraftId },
        drafts: {
          [recoveredDraftId]: 'Unsaved local prompt edit',
          [blockedDraftId]: 'Prompt with a missing attachment',
        },
        stagedAttachments: {
          [recoveredDraftId]: [recoveredAttachment],
          [blockedDraftId]: [blockedAttachment],
        },
        threadSettings: {},
        pendingSends: {},
      })
    );

    let resolveDraftPage:
      | ((page: { drafts: SavedChatDraft[]; nextOffset: number | null }) => void)
      | undefined;
    mocks.listThreads.mockResolvedValue([thread('unrelated-thread', projectPath, 1, 'Existing')]);
    mocks.listModels.mockResolvedValue([]);
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    mocks.listDrafts.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDraftPage = resolve;
        })
    );

    const { getAgentChatSnapshot, loadAgentChatProject, sendAgentChatDraftTurn } =
      await import('./agentChatStore');
    const loading = loadAgentChatProject(projectPath);
    await vi.waitFor(() => expect(mocks.listDrafts).toHaveBeenCalledOnce());

    const beforeDraftHydration = getAgentChatSnapshot(projectPath);
    expect(beforeDraftHydration.attachmentAvailability[recoveredDraftId]).toBe('checking');
    expect(beforeDraftHydration.stagedAttachments[recoveredDraftId][0].available).toBeUndefined();
    await expect(
      sendAgentChatDraftTurn(
        projectPath,
        recoveredDraftId,
        projectPath,
        'Unsaved local prompt edit',
        false
      )
    ).rejects.toThrow('availability is still being checked');

    const savedDraft = (
      draftId: string,
      text: string,
      attachments: ChatAttachment[]
    ): SavedChatDraft => ({
      draftId,
      projectId: 'project-agent-chat-store-fixture',
      checkoutPath: projectPath,
      checkoutStatus: 'available',
      draft: { text, attachments },
      settings: { modelId: null, reasoningEffort: null, autoAcceptMode: false },
      savedAt: 1000,
      state: 'draft',
      promotedThreadId: null,
    });
    resolveDraftPage?.({
      drafts: [
        savedDraft(recoveredDraftId, 'Older persisted text', [
          { ...recoveredAttachment, available: true },
          { ...removedAttachment, available: true },
        ]),
        savedDraft(blockedDraftId, 'Persisted blocked text', [
          { ...blockedAttachment, available: false },
        ]),
      ],
      nextOffset: null,
    });
    await loading;

    const afterDraftHydration = getAgentChatSnapshot(projectPath);
    expect(afterDraftHydration.drafts[recoveredDraftId]).toBe('Unsaved local prompt edit');
    expect(afterDraftHydration.stagedAttachments[recoveredDraftId]).toEqual([
      expect.objectContaining({ id: 'owned-image', available: true }),
    ]);
    expect(afterDraftHydration.attachmentAvailability[recoveredDraftId]).toBeUndefined();
    expect(afterDraftHydration.threadErrors[recoveredDraftId]).toBeUndefined();
    expect(afterDraftHydration.stagedAttachments[blockedDraftId]).toEqual([
      expect.objectContaining({ id: 'missing-image', available: false }),
    ]);
    await expect(
      sendAgentChatDraftTurn(
        projectPath,
        blockedDraftId,
        projectPath,
        'Prompt with a missing attachment',
        false
      )
    ).rejects.toThrow('One or more saved attachments are unavailable');
    expect(mocks.recheckAttachments).not.toHaveBeenCalled();
  });

  it('subscribes before listing and keeps a newer event over a stale list result', async () => {
    const calls: string[] = [];
    let resolveThreads: ((threads: ChatThread[]) => void) | undefined;

    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        calls.push('listen');
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    mocks.listThreads.mockImplementation(() => {
      calls.push('list');
      return new Promise<ChatThread[]>((resolve) => {
        resolveThreads = resolve;
      });
    });
    mocks.listModels.mockImplementation(() => {
      calls.push('models');
      return Promise.resolve([]);
    });

    const { getAgentChatSnapshot, loadAgentChatProject } = await import('./agentChatStore');
    const projectPath = '/projects/agent-chat-store-fixture';
    const loading = loadAgentChatProject(projectPath);
    await vi.waitFor(() => expect(mocks.listThreads).toHaveBeenCalledOnce());

    expect(calls.slice(0, 2)).toEqual(['listen', 'list']);
    emitThread?.({ payload: thread('thread-1', projectPath, 2, 'newer event') });
    resolveThreads?.([thread('thread-1', projectPath, 1, 'stale list')]);
    await loading;

    expect(getAgentChatSnapshot(projectPath).threads).toEqual([
      thread('thread-1', projectPath, 2, 'newer event'),
    ]);
  });

  it('keeps two sends and their drafts isolated while thread events interleave', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );

    const { getAgentChatSnapshot, loadAgentChatProject, sendAgentChatTurn, setAgentChatDraft } =
      await import('./agentChatStore');
    const projectPath = '/projects/agent-chat-interleaving-fixture';
    const first = thread('thread-a', projectPath, 1, 'Conversation A');
    const second = thread('thread-b', projectPath, 1, 'Conversation B');
    mocks.listThreads.mockResolvedValue([first, second]);
    mocks.listModels.mockResolvedValue([]);
    await loadAgentChatProject(projectPath);

    const resolveSend = new Map<string, (result: ChatThread) => void>();
    const sentTurns: Array<[string, string]> = [];
    mocks.send.mockImplementation((_path: string, threadId: string, text: string) => {
      sentTurns.push([threadId, text]);
      return new Promise<ChatThread>((resolve) => resolveSend.set(threadId, resolve));
    });
    setAgentChatDraft(projectPath, first.id, 'draft for A');
    setAgentChatDraft(projectPath, second.id, 'draft for B');

    const sendA = sendAgentChatTurn(projectPath, first.id, 'draft for A', false);
    emitThread?.({ payload: thread(first.id, projectPath, 2, 'Conversation A', 'running') });
    const sendB = sendAgentChatTurn(projectPath, second.id, 'draft for B', false);
    emitThread?.({ payload: thread(second.id, projectPath, 2, 'Conversation B', 'running') });

    expect([...getAgentChatSnapshot(projectPath).sendingThreadIds].sort()).toEqual([
      'thread-a',
      'thread-b',
    ]);
    expect(sentTurns).toEqual([
      ['thread-a', 'draft for A'],
      ['thread-b', 'draft for B'],
    ]);

    resolveSend.get(first.id)?.(thread(first.id, projectPath, 3, 'Conversation A', 'idle'));
    await sendA;
    expect(getAgentChatSnapshot(projectPath).sendingThreadIds).toEqual([second.id]);
    expect(getAgentChatSnapshot(projectPath).drafts[first.id]).toBe('');
    expect(getAgentChatSnapshot(projectPath).drafts[second.id]).toBe('draft for B');

    resolveSend.get(second.id)?.(thread(second.id, projectPath, 3, 'Conversation B', 'idle'));
    await sendB;
    const snapshot = getAgentChatSnapshot(projectPath);
    expect(snapshot.sendingThreadIds).toEqual([]);
    expect(snapshot.drafts[first.id]).toBe('');
    expect(snapshot.drafts[second.id]).toBe('');
    expect(snapshot.threads.find((candidate) => candidate.id === first.id)?.status).toBe('idle');
    expect(snapshot.threads.find((candidate) => candidate.id === second.id)?.status).toBe('idle');
  });

  it('inherits a selected saved draft’s model and effort when creating a draft on another checkout', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    mocks.listThreads.mockResolvedValue([]);
    mocks.listModels.mockResolvedValue([
      {
        id: 'model-default',
        label: 'Default',
        description: null,
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      },
      {
        id: 'model-selected',
        label: 'Selected',
        description: null,
        isDefault: false,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      },
    ]);

    const {
      getAgentChatSnapshot,
      loadAgentChatProject,
      selectAgentChatDraft,
      setAgentChatThreadSettings,
    } = await import('./agentChatStore');
    const projectPath = '/projects/agent-chat-settings-fixture';
    localStorage.removeItem(`shipstudio.agentChat.lastSettings:${encodeURIComponent(projectPath)}`);
    await loadAgentChatProject(projectPath);

    const currentDraftId = getAgentChatSnapshot(projectPath).selectedDraftId;
    setAgentChatThreadSettings(projectPath, currentDraftId!, {
      modelId: 'model-selected',
      reasoningEffort: 'high',
    });
    const newDraftId = selectAgentChatDraft(projectPath, `${projectPath}/worktree`);

    expect(getAgentChatSnapshot(projectPath).threadSettings[newDraftId]).toEqual({
      modelId: 'model-selected',
      reasoningEffort: 'high',
    });

    mocks.listDrafts.mockResolvedValue({
      drafts: [
        {
          draftId: newDraftId,
          projectId: 'project-agent-chat-store-fixture',
          checkoutPath: `${projectPath}/worktree`,
          checkoutStatus: 'available',
          draft: { text: '', attachments: [] },
          settings: { modelId: 'model-selected', reasoningEffort: 'high', autoAcceptMode: false },
          savedAt: Date.now(),
          state: 'draft',
          promotedThreadId: null,
        },
      ],
      nextOffset: null,
    });

    vi.resetModules();
    const freshStore = await import('./agentChatStore');
    await freshStore.loadAgentChatProject(projectPath);
    const restoredDraftId = freshStore.selectAgentChatDraft(
      projectPath,
      `${projectPath}/fresh-worktree`
    );
    expect(freshStore.getAgentChatSnapshot(projectPath).threadSettings[restoredDraftId]).toEqual({
      modelId: 'model-selected',
      reasoningEffort: 'high',
    });
  });

  it('blocks sends when a saved model is no longer in discovered models', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    const projectPath = '/projects/agent-chat-stale-model-fixture';
    const savedThread = {
      ...thread('thread-stale-model', projectPath, 1, 'Saved model conversation'),
      settings: { modelId: 'model-removed', reasoningEffort: 'high', autoAcceptMode: false },
    };
    mocks.listThreads.mockResolvedValue([savedThread]);
    mocks.listModels.mockResolvedValue([
      {
        id: 'model-current',
        label: 'Current model',
        description: null,
        isDefault: true,
        reasoningEfforts: ['low', 'medium'],
        defaultReasoningEffort: 'medium',
      },
    ]);

    const { getAgentChatSnapshot, loadAgentChatProject, sendAgentChatTurn } =
      await import('./agentChatStore');
    await loadAgentChatProject(projectPath);

    expect(getAgentChatSnapshot(projectPath).threadSettings[savedThread.id]).toEqual({
      modelId: 'model-removed',
      reasoningEffort: 'high',
    });
    await expect(sendAgentChatTurn(projectPath, savedThread.id, 'continue', false)).rejects.toThrow(
      'The saved model “model-removed” is unavailable.'
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('promotes one saved draft per first send and keeps late edits and captures with their original draft', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    mocks.listThreads.mockResolvedValue([]);
    mocks.listModels.mockResolvedValue([
      {
        id: 'model-before',
        label: 'Before',
        description: null,
        isDefault: false,
        reasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
      },
      {
        id: 'model-after',
        label: 'After',
        description: null,
        isDefault: true,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
      },
    ]);

    const {
      discardAgentChatThread,
      createAgentChatDraft,
      getAgentChatCaptureTarget,
      getAgentChatSnapshot,
      loadAgentChatProject,
      sendAgentChatDraftTurn,
      setAgentChatDraft,
      setAgentChatThreadSettings,
      stageCapturedAttachment,
    } = await import('./agentChatStore');
    const projectPath = '/projects/agent-chat-first-send-fixture';
    await loadAgentChatProject(projectPath);

    const firstDraftId = getAgentChatSnapshot(projectPath).selectedDraftId;
    expect(firstDraftId).toBeTruthy();
    const capturedTarget = getAgentChatCaptureTarget(projectPath);
    expect(capturedTarget?.kind).toBe('draft');
    if (!capturedTarget || capturedTarget.kind !== 'draft') {
      throw new Error('Expected a draft capture target');
    }

    const initialAttachment = {
      id: 'initial-attachment',
      name: 'initial.png',
      path: '/tmp/initial.png',
      mimeType: 'image/png',
      size: 10,
      kind: 'image' as const,
    };
    mocks.stageAttachment.mockResolvedValueOnce(initialAttachment);
    await stageCapturedAttachment(capturedTarget, initialAttachment.path);

    const initiatingSettings = { modelId: 'model-before', reasoningEffort: 'low' };
    setAgentChatDraft(projectPath, firstDraftId!, 'first prompt');
    setAgentChatThreadSettings(projectPath, firstDraftId!, initiatingSettings);

    let resolvePromotion: ((created: ChatThread) => void) | undefined;
    mocks.promoteDraft.mockImplementationOnce(
      () => new Promise<ChatThread>((resolve) => (resolvePromotion = resolve))
    );

    const sentCalls: Array<{
      threadId: string;
      text: string;
      attachments: Array<{ id: string }>;
      modelId: string | null;
      reasoningEffort: string | null;
      autoAcceptMode: boolean;
    }> = [];
    let resolveSend: ((sent: ChatThread) => void) | undefined;
    mocks.send.mockImplementation(
      (
        _path: string,
        threadId: string,
        text: string,
        attachments: Array<{ id: string }>,
        modelId: string | null,
        reasoningEffort: string | null,
        autoAcceptMode: boolean
      ) => {
        sentCalls.push({ threadId, text, attachments, modelId, reasoningEffort, autoAcceptMode });
        return new Promise<ChatThread>((resolve) => (resolveSend = resolve));
      }
    );

    const firstSend = sendAgentChatDraftTurn(
      projectPath,
      firstDraftId!,
      projectPath,
      'first prompt',
      true
    );
    await vi.waitFor(() => expect(mocks.promoteDraft).toHaveBeenCalledOnce());

    // These edits happen after the request is captured and must remain for a later turn.
    setAgentChatDraft(projectPath, firstDraftId!, 'follow-up prompt');
    const followUpSettings = { modelId: 'model-after', reasoningEffort: 'high' };
    setAgentChatThreadSettings(projectPath, firstDraftId!, followUpSettings);

    let resolveLateAttachment: ((attachment: typeof initialAttachment) => void) | undefined;
    mocks.stageAttachment.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLateAttachment = resolve))
    );
    const lateCapture = stageCapturedAttachment(capturedTarget, '/tmp/late.png');
    await vi.waitFor(() => expect(mocks.stageAttachment).toHaveBeenCalledTimes(2));

    // Choosing New while promotion is pending allocates another draft immediately.
    const nextDraftId = createAgentChatDraft(projectPath, projectPath);
    expect(nextDraftId).not.toBe(firstDraftId);
    expect(getAgentChatSnapshot(projectPath).selectedDraftId).toBe(nextDraftId);
    await expect(
      sendAgentChatDraftTurn(projectPath, firstDraftId!, projectPath, 'duplicate', false)
    ).rejects.toThrow('A send is already starting for this draft.');
    expect(mocks.promoteDraft).toHaveBeenCalledOnce();

    const firstThread = thread('thread-first-send', projectPath, 1, 'First conversation');
    resolvePromotion?.(firstThread);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());

    expect(sentCalls).toEqual([
      {
        threadId: firstThread.id,
        text: 'first prompt',
        attachments: [initialAttachment],
        modelId: initiatingSettings.modelId,
        reasoningEffort: initiatingSettings.reasoningEffort,
        autoAcceptMode: true,
      },
    ]);
    expect(getAgentChatSnapshot(projectPath).threadSettings[firstThread.id]).toEqual(
      followUpSettings
    );

    const lateAttachment = { ...initialAttachment, id: 'late-attachment', name: 'late.png' };
    resolveLateAttachment?.(lateAttachment);
    await expect(lateCapture).resolves.toEqual(lateAttachment);

    resolveSend?.(thread(firstThread.id, projectPath, 3, 'First conversation'));
    await firstSend;

    let snapshot = getAgentChatSnapshot(projectPath);
    expect(snapshot.draftThreadIds[firstDraftId!]).toBe(firstThread.id);
    expect(snapshot.draftCheckoutPaths[firstDraftId!]).toBe(projectPath);
    expect(snapshot.selectedDraftId).toBe(nextDraftId);
    expect(snapshot.selectedThreadId).toBeNull();
    expect(snapshot.drafts[firstThread.id]).toBe('follow-up prompt');
    expect(snapshot.stagedAttachments[firstThread.id]).toEqual([lateAttachment]);
    expect(snapshot.stagedAttachments[nextDraftId]).toBeUndefined();

    // Sending the next draft promotes a separate saved draft.
    const secondThread = thread('thread-second-send', projectPath, 1, 'Second conversation');
    mocks.promoteDraft.mockResolvedValueOnce(secondThread);
    mocks.send.mockImplementationOnce(() => Promise.resolve(secondThread));
    const secondResult = await sendAgentChatDraftTurn(
      projectPath,
      nextDraftId,
      projectPath,
      'second prompt',
      false
    );
    expect(secondResult.id).toBe(secondThread.id);
    expect(mocks.promoteDraft).toHaveBeenCalledTimes(2);
    expect(sentCalls.map((call) => call.threadId)).toEqual([firstThread.id]);
    snapshot = getAgentChatSnapshot(projectPath);
    expect(snapshot.threads.map((candidate) => candidate.id)).toEqual([
      firstThread.id,
      secondThread.id,
    ]);
    expect(snapshot.draftThreadIds[nextDraftId]).toBe(secondThread.id);

    mocks.discardThread.mockResolvedValue(undefined);
    await discardAgentChatThread(projectPath, firstThread.id);
    expect(await stageCapturedAttachment(capturedTarget, '/tmp/discarded.png')).toBeNull();
    expect(mocks.stageAttachment).toHaveBeenCalledTimes(2);
  });

  it('keeps the editable draft and staged attachments when draft promotion fails', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    mocks.listThreads.mockResolvedValue([]);
    mocks.listModels.mockResolvedValue([]);

    const {
      getAgentChatCaptureTarget,
      getAgentChatSnapshot,
      loadAgentChatProject,
      sendAgentChatDraftTurn,
      setAgentChatDraft,
      stageCapturedAttachment,
    } = await import('./agentChatStore');
    const projectPath = '/projects/agent-chat-create-failure-fixture';
    await loadAgentChatProject(projectPath);

    const draftId = getAgentChatSnapshot(projectPath).selectedDraftId!;
    const target = getAgentChatCaptureTarget(projectPath)!;
    const attachment = {
      id: 'retained-attachment',
      name: 'keep.png',
      path: '/tmp/keep.png',
      mimeType: 'image/png',
      size: 10,
      kind: 'image' as const,
    };
    mocks.stageAttachment.mockResolvedValueOnce(attachment);
    await stageCapturedAttachment(target, attachment.path);
    setAgentChatDraft(projectPath, draftId, 'prompt to keep');
    mocks.promoteDraft.mockRejectedValueOnce(new Error('promotion failed'));

    await expect(
      sendAgentChatDraftTurn(projectPath, draftId, projectPath, 'prompt to keep', false)
    ).rejects.toThrow('promotion failed');

    const afterFailure = getAgentChatSnapshot(projectPath);
    expect(afterFailure.selectedDraftId).toBe(draftId);
    expect(afterFailure.draftThreadIds[draftId]).toBeUndefined();
    expect(afterFailure.drafts[draftId]).toBe('prompt to keep');
    expect(afterFailure.stagedAttachments[draftId]).toEqual([attachment]);
    expect(afterFailure.sendingDraftIds).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps the prompt and staged attachments on the promoted thread when its first send fails', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    mocks.listThreads.mockResolvedValue([]);
    mocks.listModels.mockResolvedValue([]);

    const {
      getAgentChatCaptureTarget,
      getAgentChatSnapshot,
      loadAgentChatProject,
      sendAgentChatDraftTurn,
      setAgentChatDraft,
      stageCapturedAttachment,
    } = await import('./agentChatStore');
    const projectPath = '/projects/agent-chat-send-failure-fixture';
    await loadAgentChatProject(projectPath);

    const draftId = getAgentChatSnapshot(projectPath).selectedDraftId!;
    const target = getAgentChatCaptureTarget(projectPath)!;
    const attachment = {
      id: 'send-failure-attachment',
      name: 'keep-on-retry.png',
      path: '/tmp/keep-on-retry.png',
      mimeType: 'image/png',
      size: 10,
      kind: 'image' as const,
    };
    mocks.stageAttachment.mockResolvedValueOnce(attachment);
    await stageCapturedAttachment(target, attachment.path);
    setAgentChatDraft(projectPath, draftId, 'retry this prompt');

    const createdThread = thread('thread-first-send-failure', projectPath, 1, 'Retry conversation');
    mocks.promoteDraft.mockResolvedValueOnce(createdThread);
    mocks.send.mockRejectedValueOnce(new Error('send failed'));

    await expect(
      sendAgentChatDraftTurn(projectPath, draftId, projectPath, 'retry this prompt', false)
    ).rejects.toThrow('send failed');

    const afterFailure = getAgentChatSnapshot(projectPath);
    expect(afterFailure.draftThreadIds[draftId]).toBe(createdThread.id);
    expect(afterFailure.drafts[createdThread.id]).toBe('retry this prompt');
    expect(afterFailure.stagedAttachments[createdThread.id]).toEqual([attachment]);
    expect(afterFailure.sendingDraftIds).toEqual([]);
    expect(afterFailure.sendingThreadIds).toEqual([]);
  });

  it('keeps project aliases isolated, reads fresh activity only while visible, and blocks uncertain sends', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    const projectPath = '/projects/agent-chat-reconciliation-fixture';
    const savedThread = thread('thread-reconciliation', projectPath, 1, 'Saved conversation');
    mocks.listThreads.mockResolvedValue([savedThread]);
    mocks.listModels.mockResolvedValue([]);
    mocks.markRead.mockImplementation(() =>
      Promise.resolve({
        ...savedThread,
        revision: 4,
        activityCursor: 1,
        readCursor: 1,
        unread: false,
      })
    );
    let resolveDraftSave: ((saved: ChatThread) => void) | undefined;
    mocks.saveDraft.mockImplementationOnce(
      (_path: string, _threadId: string, _draft: ChatThread['draft']) =>
        new Promise<ChatThread>((resolve) => {
          resolveDraftSave = resolve;
        })
    );
    let rejectSend: ((error: Error) => void) | undefined;
    mocks.send.mockImplementationOnce(
      () =>
        new Promise<ChatThread>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    mocks.resumeCheck.mockResolvedValue({
      ...savedThread,
      revision: 7,
      items: [
        {
          id: 'provider-user-item',
          turnId: 'provider-turn',
          kind: 'user',
          text: 'uncertain prompt',
          status: 'completed',
          attachments: [],
        },
      ],
    });

    const {
      getAgentChatSnapshot,
      loadAgentChatProject,
      resumeCheckAgentChatThread,
      sendAgentChatTurn,
      setAgentChatPanelVisible,
      setAgentChatDraft,
    } = await import('./agentChatStore');
    await loadAgentChatProject(projectPath);

    emitThread?.({
      payload: {
        ...thread('foreign-thread', projectPath, 10, 'Other repository'),
        projectId: 'different-project-id',
      },
    });
    expect(getAgentChatSnapshot(projectPath).threads.map((candidate) => candidate.id)).toEqual([
      savedThread.id,
    ]);

    emitThread?.({
      payload: {
        ...savedThread,
        projectPath: `${projectPath}-checkout-alias`,
        revision: 2,
        title: 'Updated through checkout alias',
      },
    });
    expect(
      getAgentChatSnapshot(projectPath).threads.find((candidate) => candidate.id === savedThread.id)
        ?.title
    ).toBe('Updated through checkout alias');

    setAgentChatPanelVisible(projectPath, true);
    emitThread?.({
      payload: {
        ...savedThread,
        revision: 3,
        activityCursor: 1,
        readCursor: 0,
        unread: true,
      },
    });
    await vi.waitFor(() => expect(mocks.markRead).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        getAgentChatSnapshot(projectPath).threads.find(
          (candidate) => candidate.id === savedThread.id
        )?.unread
      ).toBe(false)
    );

    setAgentChatPanelVisible(projectPath, false);
    emitThread?.({
      payload: {
        ...savedThread,
        revision: 5,
        activityCursor: 2,
        readCursor: 1,
        unread: true,
      },
    });
    expect(mocks.markRead).toHaveBeenCalledOnce();
    expect(
      getAgentChatSnapshot(projectPath).threads.find((candidate) => candidate.id === savedThread.id)
        ?.unread
    ).toBe(true);

    setAgentChatDraft(projectPath, savedThread.id, 'uncertain prompt');
    const uncertainSend = sendAgentChatTurn(projectPath, savedThread.id, 'uncertain prompt', false);
    await vi.waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledOnce());
    await expect(
      sendAgentChatTurn(projectPath, savedThread.id, 'a concurrent prompt', false)
    ).rejects.toThrow('A send is already starting for this conversation.');
    resolveDraftSave?.({
      ...savedThread,
      revision: 6,
      activityCursor: 2,
      readCursor: 1,
      unread: true,
      draft: { text: 'uncertain prompt', attachments: [] },
    });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    rejectSend?.(new Error('send acknowledgement was lost'));
    await expect(uncertainSend).rejects.toThrow('send acknowledgement was lost');
    await resumeCheckAgentChatThread(projectPath, savedThread.id);
    const safety = getAgentChatSnapshot(projectPath).sendSafety[savedThread.id];
    expect(safety?.reconciled).toBe(false);
    expect(safety?.message).toContain('cannot confirm whether the previous prompt was accepted');
    await expect(
      sendAgentChatTurn(projectPath, savedThread.id, 'a different prompt', false)
    ).rejects.toThrow('cannot confirm whether the previous prompt was accepted');
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('persists before promotion and keeps edits and delayed captures on the original draft', async () => {
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload: ChatThread }) => void) => {
        emitThread = handler;
        return Promise.resolve(() => undefined);
      }
    );
    const projectPath = '/projects/agent-chat-draft-promotion-race';
    mocks.listThreads.mockResolvedValue([]);
    mocks.listModels.mockResolvedValue([
      {
        id: 'model-default',
        label: 'Default',
        description: null,
        isDefault: true,
        reasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
      },
    ]);

    const {
      getAgentChatCaptureTarget,
      getAgentChatSnapshot,
      loadAgentChatProject,
      sendAgentChatDraftTurn,
      setAgentChatDraft,
      stageCapturedAttachment,
    } = await import('./agentChatStore');
    await loadAgentChatProject(projectPath);
    await vi.waitFor(() => expect(mocks.saveProjectDraft).toHaveBeenCalled());

    const draftId = getAgentChatSnapshot(projectPath).selectedDraftId;
    expect(draftId).toMatch(/^[0-9a-f-]{36}$/i);
    if (!draftId) throw new Error('Expected a selected draft');
    setAgentChatDraft(projectPath, draftId, 'first prompt');
    const captureTarget = getAgentChatCaptureTarget(projectPath);
    if (!captureTarget || captureTarget.kind !== 'draft') {
      throw new Error('Expected the capture to retain its original draft identity');
    }

    const calls: string[] = [];
    let savedDraft: SavedChatDraft | null = null;
    const promotion = {} as { resolve: (result: ChatThread) => void };
    const stagedAttachment = {} as { resolve: (attachment: ChatAttachment) => void };
    const promotedThread = thread('promoted-thread', projectPath, 1, 'New conversation');
    mocks.saveProjectDraft.mockImplementation(
      (
        _projectPath: string,
        checkoutPath: string,
        id: string,
        draft: SavedChatDraft['draft'],
        settings: SavedChatDraft['settings']
      ) => {
        calls.push('save');
        savedDraft = {
          draftId: id,
          projectId: 'project-agent-chat-store-fixture',
          checkoutPath,
          checkoutStatus: 'available',
          draft,
          settings,
          savedAt: Date.now(),
          state: 'draft',
          promotedThreadId: null,
        };
        return Promise.resolve(savedDraft);
      }
    );
    mocks.promoteDraft.mockImplementation(() => {
      calls.push('promote');
      return new Promise<ChatThread>((resolve) => {
        promotion.resolve = (result) => {
          savedDraft = savedDraft
            ? { ...savedDraft, state: 'promoted', promotedThreadId: result.id }
            : null;
          resolve(result);
        };
      });
    });
    mocks.stageAttachment.mockImplementation(
      () =>
        new Promise<ChatAttachment>((resolve) => {
          stagedAttachment.resolve = resolve;
        })
    );
    mocks.send.mockImplementation(
      (_path: string, threadId: string, text: string, attachments: ChatAttachment[]) => {
        calls.push('send');
        return Promise.resolve({
          ...thread(threadId, projectPath, 3, 'New conversation'),
          items: [
            {
              id: 'accepted-user-item',
              turnId: 'accepted-turn',
              kind: 'user',
              text,
              status: null,
              attachments,
            },
          ],
        });
      }
    );

    const sending = sendAgentChatDraftTurn(
      projectPath,
      draftId,
      projectPath,
      'first prompt',
      false
    );
    await vi.waitFor(() => expect(mocks.promoteDraft).toHaveBeenCalledOnce());
    const capture = stageCapturedAttachment(captureTarget, '/tmp/delayed-image.png');
    setAgentChatDraft(projectPath, draftId, 'later edit');
    promotion.resolve({
      ...promotedThread,
      providerThreadId: 'codex-promoted-thread',
      resumeStatus: 'available',
      providerStatus: 'idle',
      status: 'idle',
      draft: { text: 'first prompt', attachments: [] },
    });
    await vi.waitFor(() =>
      expect(getAgentChatSnapshot(projectPath).draftThreadIds[draftId]).toBe('promoted-thread')
    );
    stagedAttachment.resolve({
      id: 'delayed-image',
      name: 'delayed-image.png',
      path: '/owned/delayed-image.png',
      mimeType: 'image/png',
      size: 1024,
      kind: 'image',
      available: true,
    });

    await sending;
    await capture;
    await vi.waitFor(() => expect(mocks.saveDraft).toHaveBeenCalled());
    const snapshot = getAgentChatSnapshot(projectPath);
    expect(calls.slice(0, 3)).toEqual(['save', 'promote', 'send']);
    expect(mocks.promoteDraft).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(snapshot.drafts['promoted-thread']).toBe('later edit');
    expect(snapshot.stagedAttachments['promoted-thread']).toEqual([
      expect.objectContaining({ id: 'delayed-image' }),
    ]);
  });
});
