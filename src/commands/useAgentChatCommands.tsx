import { BellIcon, CommentIcon, ResetIcon, ShieldCheckIcon } from '@/components/icons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useCommands } from './useCommands';
import {
  discardAgentChatThread,
  createAgentChatDraft,
  getAgentChatSnapshot,
  interruptSelectedAgentChatThread,
} from '../lib/agentChatStore';
import type { AgentWorkspaceView } from '../lib/agentChatPreferences';
import { useAsyncState } from '../hooks/useAsyncState';
import { ProjectActionConfirmModal } from '../components/dashboard/ProjectActionConfirmModal';

interface Params {
  projectPath: string;
  setProjectView: (view: AgentWorkspaceView) => boolean;
  setAgentPanelHidden: (hidden: boolean) => void;
  setPreviewHidden: (hidden: boolean) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  selectedThreadId?: string | null;
  canToggleApprovalMode?: boolean;
  onOpenNotificationSettings?: () => void;
  onToggleApprovalMode?: () => void;
}

const noop = () => undefined;

/** Palette actions for the workspace's optional Codex Chat view. */
export function useAgentChatCommands({
  projectPath,
  setProjectView,
  setAgentPanelHidden,
  setPreviewHidden,
  showToast,
  selectedThreadId = null,
  canToggleApprovalMode = false,
  onOpenNotificationSettings,
  onToggleApprovalMode,
}: Params): ReactNode {
  const [resetTarget, setResetTarget] = useState<{ projectPath: string; threadId: string } | null>(
    null
  );
  const openNotificationSettings = onOpenNotificationSettings ?? noop;
  const toggleApprovalMode = onToggleApprovalMode ?? noop;
  const previousProjectPath = useRef(projectPath);
  const {
    execute: discardThread,
    reset: resetDiscard,
    isLoading: isDiscarding,
    error: discardError,
  } = useAsyncState<boolean, [string, string]>(async (targetProjectPath, threadId) => {
    await discardAgentChatThread(targetProjectPath, threadId);
    return true;
  });

  useEffect(() => {
    if (previousProjectPath.current === projectPath) return;
    previousProjectPath.current = projectPath;
    // This dialog is local to its project and must close when the workspace scope changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResetTarget(null);
    resetDiscard();
  }, [projectPath, resetDiscard]);

  const reveal = useCallback(
    (view: AgentWorkspaceView, focus: boolean) => {
      if (!setProjectView(view)) {
        showToast('Could not save this project’s Agent panel choice.', 'error');
      }
      setAgentPanelHidden(false);
      if (focus) setPreviewHidden(true);
    },
    [setProjectView, setAgentPanelHidden, setPreviewHidden, showToast]
  );

  useCommands(
    () => [
      {
        id: 'agentChat.showChat',
        title: 'Show Agent Chat',
        icon: <CommentIcon size={14} />,
        category: 'navigation',
        when: 'project',
        keywords: ['codex', 'conversation', 'chat', 'agent panel'],
        run: () => reveal('chat', false),
      },
      {
        id: 'agentChat.showTerminal',
        title: 'Show Agent Terminal',
        category: 'navigation',
        when: 'project',
        keywords: ['terminal', 'claude', 'opencode', 'agent panel'],
        run: () => reveal('terminal', false),
      },
      {
        id: 'agentChat.focus',
        title: 'Focus Agent Chat',
        icon: <CommentIcon size={14} />,
        category: 'navigation',
        when: 'project',
        keywords: ['codex', 'conversation', 'focus', 'agent panel'],
        run: () => reveal('chat', true),
      },
      {
        id: 'agentChat.newConversation',
        title: 'New Chat conversation',
        icon: <CommentIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['codex', 'thread', 'new chat'],
        run: () => {
          reveal('chat', false);
          createAgentChatDraft(projectPath, getAgentChatSnapshot(projectPath).selectedCheckoutPath);
        },
      },
      {
        id: 'agentChat.resetConversation',
        title: 'Reset Chat conversation',
        icon: <ResetIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && selectedThreadId !== null,
        keywords: ['discard', 'clear', 'delete', 'conversation', 'transcript'],
        run: () => {
          if (!selectedThreadId) {
            showToast('Select a Chat conversation before resetting it.', 'info');
            return;
          }
          resetDiscard();
          setResetTarget({ projectPath, threadId: selectedThreadId });
          reveal('chat', false);
        },
      },
      {
        id: 'agentChat.settings.notifications',
        title: 'Agent Settings: notification sounds',
        icon: <BellIcon size={14} />,
        category: 'settings',
        when: 'project',
        keywords: ['agent settings', 'notifications', 'sounds'],
        run: openNotificationSettings,
      },
      {
        id: 'agentChat.settings.approvalMode',
        title: 'Toggle Agent auto-accept',
        icon: <ShieldCheckIcon size={14} />,
        category: 'settings',
        when: ({ kind }) => kind === 'project' && canToggleApprovalMode,
        keywords: ['agent settings', 'approval', 'permissions', 'yolo', 'auto accept'],
        run: toggleApprovalMode,
      },
      {
        id: 'agentChat.stopCurrent',
        title: 'Stop current Chat turn',
        category: 'action',
        when: ({ kind }) => {
          if (kind !== 'project') return false;
          const snapshot = getAgentChatSnapshot(projectPath);
          const thread = snapshot.threads.find((item) => item.id === snapshot.selectedThreadId);
          return !!thread && ['starting', 'running', 'waiting'].includes(thread.status);
        },
        keywords: ['interrupt', 'cancel', 'codex'],
        run: async () => {
          try {
            const thread = await interruptSelectedAgentChatThread(projectPath);
            if (!thread) showToast('There is no running Chat turn to stop.', 'info');
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error');
          }
        },
      },
    ],
    [
      projectPath,
      reveal,
      showToast,
      selectedThreadId,
      canToggleApprovalMode,
      openNotificationSettings,
      toggleApprovalMode,
      resetDiscard,
    ]
  );

  const handleReset = useCallback(async () => {
    if (!resetTarget || resetTarget.projectPath !== projectPath) return;
    const discarded = await discardThread(resetTarget.projectPath, resetTarget.threadId);
    if (discarded) {
      setResetTarget(null);
      showToast('Chat conversation deleted.', 'success');
    }
  }, [discardThread, projectPath, resetTarget, showToast]);

  if (!resetTarget || resetTarget.projectPath !== projectPath) return null;
  return (
    <ProjectActionConfirmModal
      title="Delete this saved conversation?"
      body={
        <>
          This permanently deletes the saved Ship Studio conversation, its draft, and attachments
          owned by Ship Studio. Codex’s provider history is retained.
          {discardError && (
            <p className="agent-chat__modal-error" role="alert">
              {discardError.message}
            </p>
          )}
        </>
      }
      hint="You cannot restore this conversation in Ship Studio after deleting it."
      loading={isDiscarding}
      confirmLabel="Delete conversation"
      loadingLabel="Deleting…"
      confirmVariant="danger"
      onCancel={() => {
        if (!isDiscarding) setResetTarget(null);
      }}
      onConfirm={() => void handleReset()}
    />
  );
}
