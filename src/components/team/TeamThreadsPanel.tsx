/**
 * Comments, as a conversation between people rather than a private notepad.
 *
 * Canvas comments already exist and are deliberately local: "not committed,
 * synced, or shared with other users" (docs/canvas-comments.md). This is the
 * same note once the storage moves from this webview's localStorage into the
 * repo — the pin, the target and the route are unchanged, and what is added is
 * an author, replies, and a resolution someone else can see.
 *
 * Replying is optimistic and says so. A reply is written locally, marked
 * pending, and stays pending until a push succeeds — because that is literally
 * true, and a message that looks delivered while it sits unpushed on a laptop
 * is the single worst thing this feature could do to a team.
 *
 * @module components/team/TeamThreadsPanel
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  BranchIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CommentIcon,
  FileIcon,
  FolderIcon,
  PendingCircleIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { EmptyState } from '../primitives/EmptyState';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { ExpandableTeamText } from './ExpandableTeamText';
import { TeamAvatar, TeamAvatarStack } from './TeamAvatar';
import { TeamActorName } from './TeamActorName';
import { formatAgo } from '../../lib/workflows';
import { lastMessageAt, threadParticipants, type TeamThread } from '../../lib/team';
import {
  clearThreadSelection,
  getUiSnapshot,
  replyToThread,
  setThreadResolved,
  subscribe,
  toggleThreadSelected,
} from '../../lib/teamStore';

type ThreadFilter = 'open' | 'resolved' | 'all';

interface TeamThreadsPanelProps {
  threads: TeamThread[];
  now: number;
  /** Stacks the list over the reader for the 420px workspace panel. */
  compact?: boolean;
  /**
   * Hand the ticked threads to an agent.
   *
   * Absent on the home screen, which has no terminal to hand them to — the
   * ticks and the button simply do not render there.
   */
  onSendToAgent?: (threads: TeamThread[]) => void;
  /** Where they would go, for the button's label. */
  agentLabel?: string | null;
  sending?: boolean;
  /**
   * Why you cannot click an element to leave a comment right now, if you
   * cannot.
   *
   * The floating comments panel used to say this, and deleting it took the
   * explanation with it: opening the tab on a project with no preview running
   * left a list that simply never grew, with nothing anywhere saying why.
   */
  pickerHint?: string | null;
}

/** Formats the saved route and element target as compact, labelled context tags. */
function ThreadTargetContent({
  target,
  route,
  iconSize = 12,
}: {
  target: string;
  route: string;
  iconSize?: number;
}) {
  const page =
    route === '/'
      ? 'Home'
      : route
          .split('/')
          .filter(Boolean)
          .map((part) =>
            part.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
          )
          .join(' / ');
  const separatorIndex = target.indexOf(' · ');

  return (
    <>
      <span className="team-thread-page team-thread-context-tag" title={route}>
        <FileIcon size={12} aria-hidden="true" />
        {page}
      </span>
      {separatorIndex !== -1 && (
        <>
          <span className="team-thread-target-kind">
            {target.slice(0, separatorIndex).replace(/^h([1-6])$/, 'H$1')}
          </span>
          <ChevronRightIcon
            className="team-thread-target-chevron"
            size={iconSize}
            aria-hidden="true"
          />
        </>
      )}
      <span className="team-thread-target-detail">
        {separatorIndex === -1 ? target : target.slice(separatorIndex + 3)}
      </span>
    </>
  );
}

/** Coordinates thread filtering, selection, conversation details, and agent handoff. */
export function TeamThreadsPanel({
  threads,
  now,
  compact = false,
  onSendToAgent,
  agentLabel,
  sending = false,
  pickerHint,
}: TeamThreadsPanelProps) {
  const { selectedThreadIds } = useSyncExternalStore(subscribe, getUiSnapshot);
  const [filter, setFilter] = useState<ThreadFilter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(true);
  const [draft, setDraft] = useState('');

  const visible = useMemo(() => {
    const matches = threads.filter((thread) => {
      if (filter === 'open') return !thread.resolved;
      if (filter === 'resolved') return thread.resolved;
      return true;
    });
    return matches.sort((a, b) => lastMessageAt(b) - lastMessageAt(a));
  }, [threads, filter]);

  const selected = isDetailOpen
    ? (visible.find((thread) => thread.id === selectedId) ?? visible[0] ?? null)
    : null;

  const handleReply = useCallback(() => {
    if (!selected || !draft.trim()) return;
    void replyToThread(selected.id, draft);
    setDraft('');
  }, [selected, draft]);

  const openCount = threads.filter((thread) => !thread.resolved).length;

  // Ticks only where there is somewhere to send them.
  const selectable = Boolean(onSendToAgent);
  const selectedIds = useMemo(() => new Set(selectedThreadIds), [selectedThreadIds]);
  const chosen = useMemo(
    () => threads.filter((thread) => selectedIds.has(thread.id)),
    [threads, selectedIds]
  );

  return (
    <div className={`team-threads${compact ? ' is-compact' : ''}`}>
      {pickerHint && <p className="team-threads-picker-hint">{pickerHint}</p>}

      <div className="team-threads-controls">
        <SegmentedControl
          aria-label="Filter comments"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: 'open', label: openCount > 0 ? `Open (${openCount})` : 'Open' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
        {selectable && chosen.length > 0 && (
          <div className="team-threads-send">
            <span className="team-threads-send-count">{chosen.length} selected</span>
            <div className="team-threads-send-actions">
              <TextButton onClick={clearThreadSelection}>Clear</TextButton>
              <Button
                variant="primary"
                size="compact"
                disabled={sending}
                onClick={() => onSendToAgent?.(chosen)}
                title={agentLabel ? `Send to ${agentLabel}` : 'Send to your agent'}
              >
                {sending ? 'Sending…' : 'Send to agent'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<CommentIcon size={26} />}
          title={filter === 'open' ? 'No open comments' : 'Nothing here'}
          description={
            filter === 'open'
              ? 'Every comment on this repository has been resolved.'
              : 'No comments match this filter.'
          }
        />
      ) : (
        <div className={`team-threads-body${selected ? '' : ' is-detail-closed'}`}>
          <div className="team-thread-list" role="listbox" aria-label="Comment threads">
            {visible.map((thread) => {
              const last = thread.messages[thread.messages.length - 1];
              return (
                <button
                  key={thread.id}
                  type="button"
                  role="option"
                  aria-selected={thread.id === selected?.id}
                  className={`team-thread-item${thread.id === selected?.id ? ' is-selected' : ''}${
                    thread.resolved ? ' is-resolved' : ''
                  }`}
                  onClick={() => {
                    const currentId = selected?.id ?? selectedId;
                    if (thread.id === currentId) {
                      setIsDetailOpen(!isDetailOpen);
                    } else {
                      setSelectedId(thread.id);
                      setIsDetailOpen(true);
                      setDraft('');
                    }
                  }}
                >
                  <span className="team-thread-item-top">
                    {selectable && (
                      <Checkbox
                        checked={selectedIds.has(thread.id)}
                        onChange={() => toggleThreadSelected(thread.id)}
                        label={`Send comment #${thread.pin} to an agent`}
                        stopPropagation
                      />
                    )}
                    <span className="team-thread-pin team-status team-status--merged">
                      #{thread.pin}
                    </span>
                    <span
                      className="team-thread-target"
                      aria-label={thread.target.replace(' · ', ': ')}
                    >
                      <ThreadTargetContent target={thread.target} route={thread.route} />
                    </span>
                    <span className="team-thread-age">{formatAgo(lastMessageAt(thread), now)}</span>
                  </span>
                  {last && <span className="team-thread-preview">{last.body}</span>}
                  <span className="team-thread-item-meta">
                    <TeamAvatarStack actors={threadParticipants(thread)} />
                    <span className="team-thread-count">
                      1 comment
                      {thread.messages.length > 1 &&
                        `, ${thread.messages.length - 1} ${thread.messages.length === 2 ? 'reply' : 'replies'}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="team-thread-pane">
            {selected && (
              <>
                <header className="team-thread-header">
                  <div className="team-thread-header-top">
                    <div className="team-thread-header-meta">
                      <span className="team-thread-context-tag">
                        <FolderIcon size={12} />
                        {selected.projectName}
                      </span>
                      <span className="team-thread-context-tag">
                        <BranchIcon size={12} />
                        {selected.branch}
                      </span>
                    </div>{' '}
                    <IconButton
                      className="team-thread-close"
                      variant="ghost"
                      size="compact"
                      icon={<CloseIcon size={14} />}
                      onClick={() => setIsDetailOpen(false)}
                      title="Close thread detail"
                      aria-label="Close thread detail"
                    />
                  </div>
                  <div className="team-thread-header-title">
                    <span className="team-thread-pin team-status team-status--merged">
                      #{selected.pin}
                    </span>
                    <h3
                      className="team-thread-heading"
                      aria-label={selected.target.replace(' · ', ': ')}
                    >
                      <ThreadTargetContent
                        target={selected.target}
                        route={selected.route}
                        iconSize={16}
                      />
                    </h3>
                  </div>
                </header>

                <div className="team-thread-messages">
                  {selected.messages.map((message) => (
                    <article className="team-message" key={message.id}>
                      <TeamAvatar actor={message.actor} size="md" />
                      <div className="team-message-body">
                        <div className="team-message-head">
                          <TeamActorName actor={message.actor} className="team-message-author" />
                          <span className="team-message-age">{formatAgo(message.at, now)}</span>
                          {message.pending && (
                            <span
                              className="team-message-pending"
                              title="Written on this machine. Not pushed yet, so nobody else can see it."
                            >
                              <PendingCircleIcon size={12} />
                              not pushed
                            </span>
                          )}
                        </div>
                        <ExpandableTeamText text={message.body} textClassName="team-message-text" />
                      </div>
                    </article>
                  ))}

                  {selected.resolved && selected.resolvedBy && (
                    <div className="team-thread-resolved-note">
                      <CheckIcon size={11} />
                      Resolved by <TeamActorName actor={selected.resolvedBy} />
                    </div>
                  )}
                </div>

                <footer className="team-thread-composer">
                  <textarea
                    className="team-thread-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Reply to ${selected.messages[0]?.actor.name ?? 'this thread'}…`}
                    aria-label="Reply"
                    rows={2}
                    onKeyDown={(e) => {
                      // Enter sends, Shift+Enter breaks the line: this is a
                      // chat box, and the surrounding app is full of textareas
                      // where Enter means newline, so the affordance is
                      // spelled out beneath it rather than assumed.
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleReply();
                      }
                    }}
                  />
                  <div className="team-thread-composer-actions">
                    <span className="team-thread-hint">
                      <span>Enter to send</span>
                      <span>Saved to this project, not pushed yet</span>
                    </span>
                    <div className="team-thread-composer-buttons">
                      <Button
                        variant="secondary"
                        leftIcon={<CheckIcon size={14} />}
                        onClick={() => void setThreadResolved(selected.id, !selected.resolved)}
                      >
                        {selected.resolved ? 'Reopen' : 'Resolve'}
                      </Button>
                      <Button variant="primary" disabled={!draft.trim()} onClick={handleReply}>
                        Reply
                      </Button>
                    </div>
                  </div>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
