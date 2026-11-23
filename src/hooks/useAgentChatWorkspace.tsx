import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useAgentChatCommands } from '../commands/useAgentChatCommands';
import { useAgentChatPreferences } from './useAgentChatPreferences';
import { useAgentChatCaptureState } from './useAgentChatCaptureState';
import type { AgentWorkspaceView } from '../lib/agentChatPreferences';
import type { WorktreeInfo } from '../lib/worktrees';
import type { AgentChatProjectSnapshot } from '../lib/agentChatStore';
import {
  getAgentChatSnapshot,
  loadAgentChatDrafts,
  loadAgentChatProject,
  selectAgentChatSavedDraft,
  selectAgentChatThread,
  setAgentChatThreadSettings,
  subscribeAgentChat,
} from '../lib/agentChatStore';
import { getAgentChatInboxEntries } from '../lib/agentChatInbox';
import {
  completeAgentWorkspaceNavigation,
  getAgentWorkspaceNavigationRequest,
  type AgentWorkspaceNavigationTarget,
} from '../lib/agentWorkspaceNavigation';
import { ProjectActionConfirmModal } from '../components/dashboard/ProjectActionConfirmModal';

export interface AgentChatWorkspaceProps {
  view: AgentWorkspaceView;
  defaultView: AgentWorkspaceView;
  hasProjectOverride: boolean;
  onViewChange: (view: AgentWorkspaceView) => void;
  onUseDefaultView: () => void;
  captureAvailable: boolean;
  captureUnavailableReason: string | null;
  worktrees: WorktreeInfo[];
  onCreateWorktree: () => void;
  /** Sidebar activity derived from live Chat threads for this project. */
  sidebarActivity: 'idle' | 'active' | 'thinking';
  /** Loaded project snapshot shared with the Agents sidebar. */
  chatSnapshot: AgentChatProjectSnapshot;
  /** Switch to one exact active Chat inbox target in this project. */
  selectSidebarTarget: (
    target: Extract<AgentWorkspaceNavigationTarget, { kind: 'chat-thread' | 'chat-draft' }>
  ) => void;
  approvalMode: boolean;
  onToggleApprovalMode: () => void;
  /** Confirmation opened by the Cmd+K reset action. */
  commandDialogs: ReactNode;
}

interface Params {
  projectPath: string;
  worktrees: WorktreeInfo[];
  onCreateWorktree: () => void;
  setAgentPanelHidden: (hidden: boolean) => void;
  setPreviewHidden: (hidden: boolean) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  onOpenNotificationSettings?: () => void;
  canToggleApprovalMode?: boolean;
  autoAcceptMode?: boolean;
  onToggleApprovalMode?: () => void;
  onSelectTerminalTarget?: (sessionId: string) => 'selected' | 'pending' | 'missing';
}

/** Connects view preferences, the live thread snapshot, palette actions and worktrees. */
export function useAgentChatWorkspace({
  projectPath,
  worktrees,
  onCreateWorktree,
  setAgentPanelHidden,
  setPreviewHidden,
  showToast,
  onOpenNotificationSettings,
  autoAcceptMode = false,
  canToggleApprovalMode,
  onToggleApprovalMode: onToggleTerminalApprovalMode,
  onSelectTerminalTarget,
}: Params): AgentChatWorkspaceProps {
  const preferences = useAgentChatPreferences(projectPath);
  const {
    defaultView,
    projectView,
    setProjectView,
    useDefaultView: resetToDefault,
    view,
  } = preferences;
  const capture = useAgentChatCaptureState(projectPath);
  const subscribeChat = useCallback(
    (listener: () => void) => subscribeAgentChat(projectPath, listener),
    [projectPath]
  );
  const getChatSnapshot = useCallback(() => getAgentChatSnapshot(projectPath), [projectPath]);
  const chatSnapshot = useSyncExternalStore(subscribeChat, getChatSnapshot, getChatSnapshot);
  useEffect(() => {
    void loadAgentChatProject(projectPath);
  }, [projectPath]);

  const draftCheckouts = useMemo(
    () => [
      ...new Set([
        projectPath,
        chatSnapshot.selectedCheckoutPath,
        ...worktrees.map((item) => item.path),
      ]),
    ],
    [projectPath, chatSnapshot.selectedCheckoutPath, worktrees]
  );
  useEffect(() => {
    draftCheckouts.forEach((checkoutPath) => {
      void loadAgentChatDrafts(projectPath, checkoutPath);
    });
  }, [projectPath, draftCheckouts]);
  const [approvalConfirmTarget, setApprovalConfirmTarget] = useState<{
    projectPath: string;
    targetId: string;
  } | null>(null);
  useEffect(() => setApprovalConfirmTarget(null), [projectPath]);
  const selectedTargetId = chatSnapshot.selectedThreadId ?? chatSnapshot.selectedDraftId;
  const selectedThread = chatSnapshot.threads.find((thread) => thread.id === selectedTargetId);
  const selectedSettings = selectedTargetId ? chatSnapshot.threadSettings[selectedTargetId] : null;
  const approvalMode =
    selectedSettings?.autoAcceptMode ?? selectedThread?.settings.autoAcceptMode ?? autoAcceptMode;
  const activeChatStatuses = chatSnapshot.threads
    .filter((thread) => ['starting', 'running', 'waiting'].includes(thread.status))
    .map((thread) => thread.status);
  const sidebarActivity =
    activeChatStatuses.length === 0
      ? 'idle'
      : activeChatStatuses.includes('running')
        ? 'thinking'
        : 'active';

  const onViewChange = useCallback(
    (view: AgentWorkspaceView) => {
      if (!setProjectView(view)) {
        showToast('Could not save this project’s Agent panel choice.', 'error');
      }
    },
    [setProjectView, showToast]
  );
  const onUseDefaultView = useCallback(() => {
    if (!resetToDefault()) {
      showToast('Could not save this project’s Agent panel choice.', 'error');
    }
  }, [resetToDefault, showToast]);

  const selectSidebarTarget = useCallback(
    (target: Extract<AgentWorkspaceNavigationTarget, { kind: 'chat-thread' | 'chat-draft' }>) => {
      const latest = getAgentChatSnapshot(projectPath);
      const entry = getAgentChatInboxEntries(latest).find((candidate) =>
        target.kind === 'chat-thread'
          ? candidate.kind === 'thread' && candidate.thread.id === target.threadId
          : candidate.kind === 'draft' && candidate.draftId === target.draftId
      );
      if (!entry) return;

      onViewChange('chat');
      setAgentPanelHidden(false);
      if (entry.kind === 'thread') {
        selectAgentChatThread(projectPath, entry.thread.id);
      } else {
        selectAgentChatSavedDraft(projectPath, entry.draftId);
      }
    },
    [onViewChange, projectPath, setAgentPanelHidden]
  );

  useEffect(() => {
    const request = getAgentWorkspaceNavigationRequest(projectPath);
    if (!request) return;
    const target = request.target;

    if (target.kind === 'terminal-tab') {
      onViewChange('terminal');
      setAgentPanelHidden(false);
      const selection = onSelectTerminalTarget?.(target.sessionId) ?? 'selected';
      if (selection === 'pending') return;
      completeAgentWorkspaceNavigation(projectPath, request.id);
      if (selection === 'missing') {
        showToast('That Terminal session is no longer available.', 'info');
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      await loadAgentChatProject(projectPath);
      if (target.kind === 'chat-draft') {
        await loadAgentChatDrafts(projectPath, target.checkoutPath);
      }
      if (cancelled) return;
      if (getAgentWorkspaceNavigationRequest(projectPath)?.id !== request.id) return;

      const latest = getAgentChatSnapshot(projectPath);
      const entries = getAgentChatInboxEntries(latest);
      const entry =
        target.kind === 'chat-thread'
          ? entries.find(
              (candidate) => candidate.kind === 'thread' && candidate.thread.id === target.threadId
            )
          : entries.find(
              (candidate) => candidate.kind === 'draft' && candidate.draftId === target.draftId
            );
      if (!entry) {
        completeAgentWorkspaceNavigation(projectPath, request.id);
        showToast('That Chat item is no longer active.', 'info');
        return;
      }

      selectSidebarTarget(
        entry.kind === 'thread'
          ? { kind: 'chat-thread', threadId: entry.thread.id }
          : {
              kind: 'chat-draft',
              draftId: entry.draftId,
              checkoutPath: entry.checkoutPath,
            }
      );
      completeAgentWorkspaceNavigation(projectPath, request.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    projectPath,
    selectSidebarTarget,
    onViewChange,
    setAgentPanelHidden,
    showToast,
    onSelectTerminalTarget,
  ]);

  const onToggleApprovalMode = useCallback(() => {
    if (view !== 'chat') {
      onToggleTerminalApprovalMode?.();
      return;
    }
    if (!selectedTargetId) {
      showToast('Select a Chat draft or conversation first.', 'info');
      return;
    }
    const thread = chatSnapshot.threads.find((item) => item.id === selectedTargetId);
    const current = chatSnapshot.threadSettings[selectedTargetId] ?? {
      modelId: thread?.settings.modelId ?? null,
      reasoningEffort: thread?.settings.reasoningEffort ?? null,
      autoAcceptMode: thread?.settings.autoAcceptMode ?? autoAcceptMode,
    };
    const currentAutoAcceptMode =
      current.autoAcceptMode ?? thread?.settings.autoAcceptMode ?? autoAcceptMode;
    if (currentAutoAcceptMode) {
      setAgentChatThreadSettings(projectPath, selectedTargetId, {
        ...current,
        autoAcceptMode: false,
      });
    } else {
      setApprovalConfirmTarget({ projectPath, targetId: selectedTargetId });
    }
  }, [
    autoAcceptMode,
    chatSnapshot,
    onToggleTerminalApprovalMode,
    projectPath,
    selectedTargetId,
    showToast,
    view,
  ]);

  const paletteDialogs = useAgentChatCommands({
    projectPath,
    setProjectView,
    setAgentPanelHidden,
    setPreviewHidden,
    showToast,
    selectedThreadId: chatSnapshot.selectedThreadId,
    canToggleApprovalMode,
    onOpenNotificationSettings,
    onToggleApprovalMode,
  });
  const commandDialogs = (
    <>
      {paletteDialogs}
      {approvalConfirmTarget?.projectPath === projectPath && (
        <ProjectActionConfirmModal
          title="Enable auto-accept for this conversation?"
          body="Codex can apply requested changes without asking for approval on this conversation. This choice is saved with this draft or conversation."
          hint="You can switch back to Ask before changes at any time."
          loading={false}
          confirmLabel="Enable auto-accept"
          loadingLabel="Enabling…"
          confirmVariant="danger"
          onCancel={() => setApprovalConfirmTarget(null)}
          onConfirm={() => {
            const target = approvalConfirmTarget;
            if (target?.projectPath === projectPath) {
              const snapshot = getAgentChatSnapshot(target.projectPath);
              const thread = snapshot.threads.find((item) => item.id === target.targetId);
              const current = snapshot.threadSettings[target.targetId] ?? {
                modelId: thread?.settings.modelId ?? null,
                reasoningEffort: thread?.settings.reasoningEffort ?? null,
                autoAcceptMode: thread?.settings.autoAcceptMode ?? false,
              };
              setAgentChatThreadSettings(target.projectPath, target.targetId, {
                ...current,
                autoAcceptMode: true,
              });
            }
            setApprovalConfirmTarget(null);
          }}
        />
      )}
    </>
  );

  const captureTarget = capture.target;
  const captureState = !captureTarget
    ? {
        captureAvailable: false,
        captureUnavailableReason: 'The Chat draft is not ready for screenshot attachments.',
      }
    : captureTarget.checkoutPath !== projectPath
      ? {
          captureAvailable: false,
          captureUnavailableReason: `The selected Chat target runs in ${captureTarget.checkoutPath}. Its checkout differs from this Preview; attach an existing file to continue.`,
        }
      : { captureAvailable: true, captureUnavailableReason: null };

  return {
    view,
    defaultView,
    hasProjectOverride: projectView !== null,
    onViewChange,
    onUseDefaultView,
    ...captureState,
    sidebarActivity,
    chatSnapshot,
    selectSidebarTarget,
    approvalMode,
    onToggleApprovalMode,
    commandDialogs,
    worktrees,
    onCreateWorktree,
  };
}
