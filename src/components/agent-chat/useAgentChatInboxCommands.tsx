import { ChevronIcon, EditIcon, HistoryIcon } from '@/components/icons';
import { useOptionalToast } from '@/contexts/ToastContext';
import { useCommands } from '@/commands/useCommands';
import {
  getAgentChatSnapshot,
  reopenAgentChatThread,
  settleAgentChatThread,
} from '@/lib/agentChatStore';

interface Params {
  projectPath: string;
  selectedThreadId: string | null;
  onRequestRename: (threadId: string) => void;
  onFocusInbox: () => void;
  onNavigate: (direction: -1 | 1) => void;
}

function isBusy(status: string, providerStatus: string): boolean {
  return ['starting', 'running', 'waiting'].includes(status) || providerStatus === 'active';
}

export function useAgentChatInboxCommands({
  projectPath,
  selectedThreadId,
  onRequestRename,
  onFocusInbox,
  onNavigate,
}: Params): void {
  const { showToast } = useOptionalToast();

  useCommands(
    () => [
      {
        id: 'agentChat.focusInbox',
        title: 'Focus Chat conversation list',
        icon: <ChevronIcon size={14} />,
        category: 'navigation',
        when: 'project',
        keywords: ['chat', 'threads', 'inbox', 'keyboard'],
        run: onFocusInbox,
      },
      {
        id: 'agentChat.nextConversation',
        title: 'Select next Chat conversation',
        category: 'navigation',
        when: 'project',
        keywords: ['chat', 'thread', 'keyboard', 'down'],
        run: () => onNavigate(1),
      },
      {
        id: 'agentChat.previousConversation',
        title: 'Select previous Chat conversation',
        category: 'navigation',
        when: 'project',
        keywords: ['chat', 'thread', 'keyboard', 'up'],
        run: () => onNavigate(-1),
      },
      {
        id: 'agentChat.renameSelected',
        title: 'Rename selected Chat conversation…',
        icon: <EditIcon size={14} />,
        category: 'action',
        when: ({ kind }) =>
          kind === 'project' &&
          Boolean(
            selectedThreadId &&
            getAgentChatSnapshot(projectPath).threads.some(
              (thread) => thread.id === selectedThreadId && thread.status !== 'closed'
            )
          ),
        keywords: ['title', 'edit', 'conversation'],
        run: () => {
          if (!selectedThreadId) {
            showToast('Select a Chat conversation before renaming it.', 'info');
            return;
          }
          onRequestRename(selectedThreadId);
        },
      },
      {
        id: 'agentChat.settleSelected',
        title: 'Settle selected Chat conversation',
        icon: <HistoryIcon size={14} />,
        category: 'action',
        when: ({ kind }) => {
          if (kind !== 'project' || !selectedThreadId) return false;
          const thread = getAgentChatSnapshot(projectPath).threads.find(
            (item) => item.id === selectedThreadId
          );
          return Boolean(
            thread &&
            thread.disposition === 'active' &&
            !isBusy(thread.status, thread.providerStatus)
          );
        },
        keywords: ['archive', 'done', 'inbox'],
        run: async () => {
          if (!selectedThreadId) return;
          try {
            await settleAgentChatThread(projectPath, selectedThreadId);
            showToast('Conversation settled.', 'success');
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error');
          }
        },
      },
      {
        id: 'agentChat.reopenSelected',
        title: 'Reopen settled Chat conversation',
        icon: <HistoryIcon size={14} />,
        category: 'action',
        when: ({ kind }) => {
          if (kind !== 'project') return false;
          const threads = getAgentChatSnapshot(projectPath).threads;
          return (
            threads.some(
              (thread) => thread.id === selectedThreadId && thread.disposition === 'settled'
            ) || threads.some((thread) => thread.disposition === 'settled')
          );
        },
        keywords: ['unarchive', 'settled', 'inbox'],
        run: async () => {
          const threads = getAgentChatSnapshot(projectPath).threads;
          const thread =
            threads.find(
              (item) => item.id === selectedThreadId && item.disposition === 'settled'
            ) ?? threads.find((item) => item.disposition === 'settled');
          if (!thread) return;
          try {
            await reopenAgentChatThread(projectPath, thread.id);
            showToast('Conversation reopened.', 'success');
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error');
          }
        },
      },
    ],
    [projectPath, selectedThreadId, onRequestRename, onFocusInbox, onNavigate, showToast]
  );
}
