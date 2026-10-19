import { describe, expect, it } from 'vitest';
import type { ChatThread, SavedChatDraft } from './agentChat';
import {
  agentChatDraftInboxTitle,
  agentChatThreadInboxStatus,
  agentChatThreadInboxTitle,
  getAgentChatInboxEntries,
} from './agentChatInbox';

function thread(overrides: Partial<ChatThread>): ChatThread {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    projectPath: '/projects/one',
    checkoutPath: '/projects/one',
    checkoutStatus: 'available',
    providerId: 'codex',
    providerThreadId: 'codex-1',
    resumeStatus: 'available',
    providerStatus: 'idle',
    title: 'Review the header',
    titleSource: 'prompt',
    status: 'idle',
    turnId: null,
    items: [],
    requests: [],
    draft: { text: '', attachments: [] },
    settings: { modelId: null, reasoningEffort: null, autoAcceptMode: false },
    disposition: 'active',
    activityCursor: 1,
    settledCursor: null,
    readCursor: 1,
    latestActivityAt: 10,
    unread: false,
    error: null,
    revision: 1,
    ...overrides,
  };
}

function savedDraft(overrides: Partial<SavedChatDraft>): SavedChatDraft {
  return {
    draftId: 'saved-blank',
    projectId: 'project-1',
    checkoutPath: '/projects/one',
    checkoutStatus: 'available',
    draft: { text: '', attachments: [] },
    settings: { modelId: null, reasoningEffort: null, autoAcceptMode: false },
    savedAt: 1,
    state: 'draft',
    promotedThreadId: null,
    ...overrides,
  };
}

describe('Agent Chat inbox rows shared with the project sidebar', () => {
  it('keeps only active inbox rows, hides the auto placeholder, and avoids promoted duplicates', () => {
    const data = {
      threads: [
        thread({ id: 'active' }),
        thread({ id: 'settled', disposition: 'settled', settledCursor: 1 }),
        thread({ id: 'closed', status: 'closed' }),
      ],
      savedDrafts: [
        savedDraft({ draftId: 'saved-blank' }),
        savedDraft({ draftId: 'promoted', state: 'promoted', promotedThreadId: 'active' }),
      ],
      drafts: { 'current-blank': '' },
      stagedAttachments: { 'current-blank': [] },
      draftCheckoutPaths: {
        'auto-placeholder': '/projects/one',
        'saved-blank': '/projects/one',
        promoted: '/projects/one',
        'current-blank': '/projects/one',
      },
      draftThreadIds: { promoted: 'active' },
    };
    const entries = getAgentChatInboxEntries(data);

    expect(
      entries.map(
        (entry) => `${entry.kind}:${entry.kind === 'thread' ? entry.thread.id : entry.draftId}`
      )
    ).toEqual(['thread:active', 'draft:saved-blank', 'draft:current-blank']);
    expect(
      getAgentChatInboxEntries({
        ...data,
        threads: data.threads.map((item) =>
          item.id === 'settled' ? { ...item, disposition: 'active', settledCursor: null } : item
        ),
      }).some((entry) => entry.kind === 'thread' && entry.thread.id === 'settled')
    ).toBe(true);
  });

  it('uses the same title rules as the Chat inbox', () => {
    expect(agentChatThreadInboxTitle(thread({ title: '  ' }))).toBe('New conversation');
    expect(agentChatDraftInboxTitle('  Update checkout copy\nMore detail')).toBe(
      'Update checkout copy'
    );
  });

  it('reports observed waiting and error states in Chat row metadata', () => {
    expect(
      agentChatThreadInboxStatus(thread({ status: 'waiting', providerStatus: 'active' }))
    ).toBe('Needs input');
    expect(agentChatThreadInboxStatus(thread({ status: 'error', error: 'Provider failed' }))).toBe(
      'Error'
    );
  });
});
