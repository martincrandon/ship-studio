import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ChevronIcon,
  CodexIcon,
  CommentIcon,
  EditIcon,
  HistoryIcon,
  ResetIcon,
} from '@/components/icons';
import { Button } from '@/components/primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '@/components/primitives/Dropdown';
import { MenuButton } from '@/components/primitives/MenuButton';
import { TextField } from '@/components/primitives/TextField';
import { useAsyncState } from '@/hooks/useAsyncState';
import type { ChatThread, SavedChatDraft } from '@/lib/agentChat';
import {
  agentChatDraftInboxTitle,
  agentChatThreadInboxStatus,
  agentChatThreadInboxTitle,
  getAgentChatInboxEntries,
} from '@/lib/agentChatInbox';
import {
  renameAgentChatThread,
  reopenAgentChatThread,
  selectAgentChatThread,
  settleAgentChatThread,
  selectAgentChatSavedDraft,
  loadAgentChatDrafts,
  loadMoreAgentChatDrafts,
} from '@/lib/agentChatStore';
import { useAgentChatInboxCommands } from './useAgentChatInboxCommands';

interface AgentChatInboxProps {
  projectPath: string;
  threads: ChatThread[];
  savedDrafts: SavedChatDraft[];
  drafts: Record<string, string>;
  stagedAttachments: Record<string, unknown[]>;
  selectedThreadId: string | null;
  selectedDraftId: string | null;
  selectedCheckoutPath: string;
  draftCheckoutPaths: Record<string, string>;
  draftThreadIds: Record<string, string>;
  threadErrors: Record<string, string>;
  draftPageOffsets: Record<string, number | null>;
  loadingDraftCheckouts: string[];
  draftPageErrors: Record<string, string>;
  onRequestDiscard: (threadId: string) => void;
  onRequestDeleteDraft: (draftId: string) => void;
}

function activityLabel(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return 'No observed activity';
  return `Activity ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(timestamp))}`;
}

export function AgentChatInbox({
  projectPath,
  threads,
  savedDrafts,
  drafts,
  stagedAttachments,
  selectedThreadId,
  selectedDraftId,
  selectedCheckoutPath,
  draftCheckoutPaths,
  draftThreadIds,
  threadErrors,
  draftPageOffsets,
  loadingDraftCheckouts,
  draftPageErrors,
  onRequestDiscard,
  onRequestDeleteDraft,
}: AgentChatInboxProps) {
  const [expanded, setExpanded] = useState(true);
  const [settledExpanded, setSettledExpanded] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const inboxRef = useRef<HTMLElement>(null);
  const inboxEntries = useMemo(
    () =>
      getAgentChatInboxEntries({
        threads,
        savedDrafts,
        drafts,
        stagedAttachments,
        draftCheckoutPaths,
        draftThreadIds,
      }),
    [threads, savedDrafts, drafts, stagedAttachments, draftCheckoutPaths, draftThreadIds]
  );
  const activeThreads = inboxEntries.flatMap((entry) =>
    entry.kind === 'thread' ? [entry.thread] : []
  );
  const settledThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.disposition === 'settled' && thread.status !== 'closed')
        .sort((a, b) => (b.latestActivityAt ?? 0) - (a.latestActivityAt ?? 0)),
    [threads]
  );
  const unreadCount = activeThreads.filter((thread) => thread.unread).length;
  const editableDrafts = inboxEntries.flatMap((entry) => (entry.kind === 'draft' ? [entry] : []));
  const requestRename = useCallback(
    (threadId: string) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      setExpanded(true);
      if (thread?.disposition === 'settled') setSettledExpanded(true);
      setRenamingThreadId(threadId);
    },
    [threads]
  );

  const focusInbox = useCallback(() => {
    setExpanded(true);
    window.requestAnimationFrame(() => {
      inboxRef.current?.querySelector<HTMLButtonElement>('[data-chat-select]')?.focus();
    });
  }, []);

  const navigateSelection = useCallback(
    (direction: -1 | 1) => {
      if (activeThreads.length === 0) return;
      setExpanded(true);
      const currentIndex = activeThreads.findIndex((thread) => thread.id === selectedThreadId);
      const nextIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : activeThreads.length - 1
          : (currentIndex + direction + activeThreads.length) % activeThreads.length;
      const next = activeThreads[nextIndex];
      selectAgentChatThread(projectPath, next.id);
      window.requestAnimationFrame(() => {
        inboxRef.current
          ?.querySelector<HTMLButtonElement>(`[data-thread-id="${CSS.escape(next.id)}"]`)
          ?.focus();
      });
    },
    [activeThreads, projectPath, selectedThreadId]
  );

  useAgentChatInboxCommands({
    projectPath,
    selectedThreadId,
    onRequestRename: requestRename,
    onFocusInbox: focusInbox,
    onNavigate: navigateSelection,
  });

  const focusAndSelect = (button: HTMLButtonElement | undefined) => {
    if (!button) return;
    button.focus();
    const threadId = button.dataset.threadId;
    if (threadId) selectAgentChatThread(projectPath, threadId);
    const draftId = button.dataset.draftId;
    if (draftId) selectAgentChatSavedDraft(projectPath, draftId);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.hasAttribute('data-chat-select')) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-chat-select]')
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(target);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp') nextIndex = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = buttons.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    focusAndSelect(buttons[nextIndex]);
  };

  return (
    <section className="agent-chat__inbox" aria-label="Project conversations" ref={inboxRef}>
      <div className="agent-chat__inbox-section">
        <Button
          variant="ghost"
          size="compact"
          width="fill"
          className="agent-chat__inbox-toggle"
          aria-label={
            'Chats, ' +
            activeThreads.length +
            ' active conversations' +
            (unreadCount > 0 ? ', ' + unreadCount + ' unread' : '')
          }
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <CommentIcon size={13} aria-hidden="true" />
          <span className="agent-chat__inbox-label">Chats</span>
          <span className="agent-chat__inbox-count">{activeThreads.length}</span>
          {unreadCount > 0 && (
            <span className="agent-chat__inbox-unread" aria-hidden="true">
              {unreadCount}
            </span>
          )}
          <ChevronIcon size={13} className={expanded ? 'agent-chat__inbox-chevron--open' : ''} />
        </Button>

        {expanded && (
          <ul
            className="agent-chat__thread-list"
            aria-label="Active conversations"
            onKeyDown={handleListKeyDown}
          >
            {activeThreads.map((thread, index) => (
              <InboxThreadRow
                key={thread.id}
                projectPath={projectPath}
                thread={thread}
                active={selectedThreadId === thread.id}
                isRenaming={renamingThreadId === thread.id}
                tabIndex={
                  selectedThreadId === thread.id || (!selectedThreadId && index === 0) ? 0 : -1
                }
                onSelect={() => selectAgentChatThread(projectPath, thread.id)}
                onRequestRename={requestRename}
                onCancelRename={() => setRenamingThreadId(null)}
                onRequestDiscard={onRequestDiscard}
              />
            ))}
            {editableDrafts.map((draft) => (
              <InboxDraftRow
                key={draft.draftId}
                draftId={draft.draftId}
                checkoutPath={draft.checkoutPath}
                isSaved={draft.isSaved}
                error={threadErrors[draft.draftId]}
                text={draft.text}
                active={selectedDraftId === draft.draftId}
                tabIndex={selectedDraftId === draft.draftId ? 0 : -1}
                onSelect={() => selectAgentChatSavedDraft(projectPath, draft.draftId)}
                onRequestDelete={() => onRequestDeleteDraft(draft.draftId)}
              />
            ))}
            {editableDrafts.length === 0 && activeThreads.length === 0 && (
              <li className="agent-chat__thread-empty">No active conversations or drafts</li>
            )}
            {draftPageErrors[selectedCheckoutPath] && (
              <li className="agent-chat__thread-error" role="alert">
                {draftPageErrors[selectedCheckoutPath]}
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => void loadAgentChatDrafts(projectPath, selectedCheckoutPath)}
                >
                  Retry
                </Button>
              </li>
            )}
            {(draftPageOffsets[selectedCheckoutPath] !== null &&
              draftPageOffsets[selectedCheckoutPath] !== undefined) ||
            loadingDraftCheckouts.includes(selectedCheckoutPath) ? (
              <li className="agent-chat__draft-page-control">
                <Button
                  size="compact"
                  variant="ghost"
                  disabled={loadingDraftCheckouts.includes(selectedCheckoutPath)}
                  onClick={() => void loadMoreAgentChatDrafts(projectPath, selectedCheckoutPath)}
                >
                  {loadingDraftCheckouts.includes(selectedCheckoutPath)
                    ? 'Loading drafts…'
                    : 'Load older drafts'}
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="agent-chat__inbox-section agent-chat__inbox-section--settled">
        <Button
          variant="ghost"
          size="compact"
          width="fill"
          className="agent-chat__settled-toggle"
          aria-label={'Settled, ' + settledThreads.length + ' conversations'}
          aria-expanded={settledExpanded}
          onClick={() => setSettledExpanded((value) => !value)}
        >
          <HistoryIcon size={13} aria-hidden="true" />
          <span className="agent-chat__inbox-label">Settled</span>
          <span className="agent-chat__inbox-count">{settledThreads.length}</span>
          <ChevronIcon
            size={13}
            className={settledExpanded ? 'agent-chat__inbox-chevron--open' : ''}
          />
        </Button>
        {settledExpanded && (
          <ul
            className="agent-chat__thread-list"
            aria-label="Settled conversations"
            onKeyDown={handleListKeyDown}
          >
            {settledThreads.length === 0 && (
              <li className="agent-chat__thread-empty">No settled conversations</li>
            )}
            {settledThreads.map((thread, index) => (
              <InboxThreadRow
                key={thread.id}
                projectPath={projectPath}
                thread={thread}
                active={selectedThreadId === thread.id}
                isRenaming={renamingThreadId === thread.id}
                tabIndex={
                  selectedThreadId === thread.id || (!selectedThreadId && index === 0) ? 0 : -1
                }
                onSelect={() => selectAgentChatThread(projectPath, thread.id)}
                onRequestRename={requestRename}
                onCancelRename={() => setRenamingThreadId(null)}
                onRequestDiscard={onRequestDiscard}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function InboxDraftRow({
  draftId,
  checkoutPath,
  isSaved,
  error,
  text,
  active,
  tabIndex,
  onSelect,
  onRequestDelete,
}: {
  draftId: string;
  checkoutPath: string;
  isSaved: boolean;
  error: string | undefined;
  text: string;
  active: boolean;
  tabIndex: 0 | -1;
  onSelect: () => void;
  onRequestDelete: () => void;
}) {
  const title = agentChatDraftInboxTitle(text);
  const checkoutParts = checkoutPath.split('/').filter(Boolean);
  const checkout = checkoutParts[checkoutParts.length - 1] || 'Checkout';
  return (
    <li
      className={`agent-chat__thread-row agent-chat__thread-row--draft${active ? ' agent-chat__thread-row--active' : ''}`}
    >
      <button
        type="button"
        className="agent-chat__thread-select"
        data-chat-select
        data-draft-id={draftId}
        aria-current={active ? 'true' : undefined}
        aria-label={`${title}, ${isSaved ? 'saved draft' : 'draft not saved yet'} for ${checkout}`}
        tabIndex={tabIndex}
        onClick={onSelect}
      >
        <span
          className="agent-chat__thread-status agent-chat__thread-status--idle"
          aria-hidden="true"
        />
        <span className="agent-chat__thread-copy">
          <span className="agent-chat__thread-title">{title}</span>
          <span className="agent-chat__thread-meta">
            <span>{error ? 'Save failed' : isSaved ? 'Draft' : 'Saving draft'}</span>
            <span aria-hidden="true">·</span>
            <span>{checkout}</span>
          </span>
        </span>
      </button>
      <Dropdown
        align="right"
        side="bottom"
        portal
        menuClassName="agent-chat__menu"
        trigger={(triggerProps) => (
          <MenuButton
            ref={triggerProps.ref}
            onClick={triggerProps.onClick}
            expanded={triggerProps['aria-expanded']}
            size="compact"
            variant="ghost"
            className="agent-chat__thread-menu-trigger"
            aria-label={`Actions for ${title}`}
          >
            <span aria-hidden="true">•••</span>
          </MenuButton>
        )}
      >
        <DropdownItem variant="danger" icon={<ResetIcon size={14} />} onSelect={onRequestDelete}>
          Delete draft…
        </DropdownItem>
      </Dropdown>
    </li>
  );
}

function InboxThreadRow({
  projectPath,
  thread,
  active,
  isRenaming,
  tabIndex,
  onSelect,
  onRequestRename,
  onCancelRename,
  onRequestDiscard,
}: {
  projectPath: string;
  thread: ChatThread;
  active: boolean;
  isRenaming: boolean;
  tabIndex: 0 | -1;
  onSelect: () => void;
  onRequestRename: (threadId: string) => void;
  onCancelRename: () => void;
  onRequestDiscard: (threadId: string) => void;
}) {
  const [title, setTitle] = useState(thread.title);
  const {
    execute: saveTitle,
    isLoading,
    error: renameError,
  } = useAsyncState<boolean, [string]>(async (nextTitle) => {
    await renameAgentChatThread(projectPath, thread.id, nextTitle);
    return true;
  });
  const {
    execute: settle,
    isLoading: isSettling,
    error: settleError,
  } = useAsyncState<boolean, []>(async () => {
    await settleAgentChatThread(projectPath, thread.id);
    return true;
  });
  const {
    execute: reopen,
    isLoading: isReopening,
    error: reopenError,
  } = useAsyncState<boolean, []>(async () => {
    await reopenAgentChatThread(projectPath, thread.id);
    return true;
  });
  const isBusy =
    ['starting', 'running', 'waiting'].includes(thread.status) ||
    thread.providerStatus === 'active';
  const titleValue = title.trim();

  const submitRename = async () => {
    if (!titleValue || isLoading) return;
    if (await saveTitle(titleValue)) onCancelRename();
  };

  if (isRenaming) {
    return (
      <li className="agent-chat__thread-row agent-chat__thread-row--renaming">
        <form
          className="agent-chat__thread-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <TextField
            autoFocus
            aria-label="Conversation title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCancelRename();
            }}
          />
          <Button
            size="compact"
            variant="primary"
            disabled={!titleValue || isLoading}
            type="submit"
          >
            Save
          </Button>
          <Button size="compact" variant="ghost" disabled={isLoading} onClick={onCancelRename}>
            Cancel
          </Button>
        </form>
        {renameError && (
          <p className="agent-chat__thread-error" role="alert">
            {renameError.message}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className={`agent-chat__thread-row${active ? ' agent-chat__thread-row--active' : ''}`}>
      <button
        type="button"
        className="agent-chat__thread-select"
        data-chat-select
        data-thread-id={thread.id}
        aria-current={active ? 'true' : undefined}
        aria-label={`${thread.title || 'Untitled conversation'}, ${agentChatThreadInboxStatus(thread)}${thread.unread ? ', unread' : ''}`}
        tabIndex={tabIndex}
        onClick={onSelect}
      >
        <span
          className={`agent-chat__thread-status agent-chat__thread-status--${thread.providerStatus === 'active' ? 'provider-active' : thread.status}`}
          aria-hidden="true"
        />
        <span className="agent-chat__thread-copy">
          <span className="agent-chat__thread-title">{agentChatThreadInboxTitle(thread)}</span>
          <span className="agent-chat__thread-meta">
            <span>{agentChatThreadInboxStatus(thread)}</span>
            <span aria-hidden="true">·</span>
            <span>{activityLabel(thread.latestActivityAt)}</span>
          </span>
        </span>
        {thread.unread && (
          <span className="agent-chat__thread-unread" aria-label="Unread activity" />
        )}
      </button>
      <Dropdown
        align="right"
        side="bottom"
        portal
        menuClassName="agent-chat__menu"
        trigger={(triggerProps) => (
          <MenuButton
            ref={triggerProps.ref}
            onClick={triggerProps.onClick}
            expanded={triggerProps['aria-expanded']}
            size="compact"
            variant="ghost"
            className="agent-chat__thread-menu-trigger"
            aria-label={`Actions for ${thread.title || 'conversation'}`}
          >
            <span aria-hidden="true">•••</span>
          </MenuButton>
        )}
      >
        <DropdownItem
          icon={<EditIcon size={14} />}
          onSelect={() => {
            setTitle(thread.title);
            onRequestRename(thread.id);
          }}
        >
          Rename
        </DropdownItem>
        {thread.disposition === 'active' ? (
          <DropdownItem
            icon={<HistoryIcon size={14} />}
            disabled={isBusy || isSettling}
            onSelect={() => void settle()}
          >
            Settle
          </DropdownItem>
        ) : (
          <DropdownItem
            icon={<CodexIcon size={14} />}
            disabled={isReopening}
            onSelect={() => void reopen()}
          >
            Reopen
          </DropdownItem>
        )}
        <DropdownDivider />
        <DropdownItem
          variant="danger"
          icon={<ResetIcon size={14} />}
          onSelect={() => onRequestDiscard(thread.id)}
        >
          Discard…
        </DropdownItem>
      </Dropdown>
      {(settleError || reopenError) && (
        <p className="agent-chat__thread-error" role="alert">
          {settleError?.message ?? reopenError?.message}
        </p>
      )}
    </li>
  );
}
