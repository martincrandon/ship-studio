import type { ChatThread, SavedChatDraft } from './agentChat';

export interface AgentChatInboxData {
  threads: ChatThread[];
  savedDrafts: SavedChatDraft[];
  drafts: Record<string, string>;
  stagedAttachments: Record<string, unknown[]>;
  draftCheckoutPaths: Record<string, string>;
  draftThreadIds: Record<string, string>;
}

export type AgentChatInboxEntry =
  | { kind: 'thread'; thread: ChatThread }
  | {
      kind: 'draft';
      draftId: string;
      checkoutPath: string;
      isSaved: boolean;
      text: string;
    };

export type AgentChatInboxDotState = 'idle' | 'active' | 'thinking' | 'attention' | 'muted';

/** The active rows shared by the Chat inbox and the project sidebar. */
export function getAgentChatInboxEntries(data: AgentChatInboxData): AgentChatInboxEntry[] {
  const threads = data.threads
    .filter((thread) => thread.disposition === 'active' && thread.status !== 'closed')
    .sort((left, right) => (right.latestActivityAt ?? 0) - (left.latestActivityAt ?? 0))
    .map((thread): AgentChatInboxEntry => ({ kind: 'thread', thread }));

  const knownDraftIds = new Set(data.savedDrafts.map((draft) => draft.draftId));
  const savedDrafts = data.savedDrafts
    .filter((draft) => draft.state === 'draft')
    .map(
      (draft): AgentChatInboxEntry => ({
        kind: 'draft',
        draftId: draft.draftId,
        checkoutPath: draft.checkoutPath,
        isSaved: true,
        text: draft.draft.text,
      })
    );

  const currentDrafts = Object.entries(data.draftCheckoutPaths).flatMap(
    ([draftId, checkoutPath]): AgentChatInboxEntry[] => {
      // Promoted drafts belong to their thread row. The empty draft seeded for
      // a new project is not a Chat inbox item until the user has edited it or
      // explicitly created/selected it.
      if (
        knownDraftIds.has(draftId) ||
        data.draftThreadIds[draftId] ||
        (!Object.prototype.hasOwnProperty.call(data.drafts, draftId) &&
          !Object.prototype.hasOwnProperty.call(data.stagedAttachments, draftId))
      ) {
        return [];
      }
      return [
        {
          kind: 'draft',
          draftId,
          checkoutPath,
          isSaved: false,
          text: data.drafts[draftId] ?? '',
        },
      ];
    }
  );

  return [...threads, ...savedDrafts, ...currentDrafts];
}

export function agentChatThreadInboxTitle(thread: ChatThread): string {
  return thread.title.trim() || 'New conversation';
}

export function agentChatDraftInboxTitle(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 72) || 'New conversation';
}

export function agentChatThreadInboxStatus(thread: ChatThread): string {
  if (
    thread.status === 'error' ||
    thread.providerStatus === 'systemError' ||
    thread.error !== null
  ) {
    return 'Error';
  }
  if (thread.status === 'waiting') return 'Needs input';
  if (thread.status === 'running') return 'Working';
  if (thread.status === 'starting') return 'Starting';
  if (thread.providerStatus === 'active') return 'Codex still working';
  if (thread.providerStatus === 'unknown' || thread.providerStatus === 'notLoaded') {
    return thread.status === 'interrupted'
      ? 'Stopped · provider status unknown'
      : 'Provider status unknown';
  }
  if (thread.status === 'interrupted') return 'Stopped';
  if (thread.status === 'closed') return 'Closed';
  return 'Ready';
}

export function agentChatInboxDotState(
  entry: AgentChatInboxEntry,
  threadErrors: Record<string, string>
): AgentChatInboxDotState {
  if (entry.kind === 'draft') return threadErrors[entry.draftId] ? 'attention' : 'idle';
  const { thread } = entry;
  if (
    thread.unread ||
    thread.status === 'waiting' ||
    thread.status === 'error' ||
    thread.providerStatus === 'systemError' ||
    thread.error
  ) {
    return 'attention';
  }
  if (
    thread.providerStatus === 'active' ||
    thread.status === 'starting' ||
    thread.status === 'running'
  ) {
    return 'thinking';
  }
  return 'muted';
}
