import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  ActivityIcon,
  AlertIcon,
  ArrowDownIcon,
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  PushIcon,
  ZapIcon,
} from '@/components/icons';
import { Button } from '@/components/primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '@/components/primitives/Dropdown';
import { IconButton } from '@/components/primitives/IconButton';
import { MenuButton } from '@/components/primitives/MenuButton';
import { TextArea } from '@/components/primitives/TextField';
import { useAsyncState } from '@/hooks/useAsyncState';
import { type ChatAttachment, type ChatItem, type ChatThread } from '@/lib/agentChat';
import {
  discardAgentChatThread,
  deleteAgentChatDraft,
  createAgentChatDraft,
  getAgentChatCaptureTarget,
  getAgentChatSnapshot,
  loadAgentChatDrafts,
  interruptAgentChatThread,
  loadAgentChatProject,
  removeStagedAgentChatAttachment,
  selectAgentChatDraft,
  sendAgentChatDraftTurn,
  sendAgentChatTurn,
  setAgentChatDraft,
  setAgentChatThreadSettings,
  stageCapturedAttachment,
  subscribeAgentChat,
  type AgentChatCaptureTarget,
  relinkAgentChatCheckout,
  relinkUnlinkedAgentChatProject,
  resumeCheckAgentChatThread,
} from '@/lib/agentChatStore';
import { stageClipboardImage } from '@/lib/clipboard';
import { dropPointToLogical, isPointInRect } from '@/lib/dropTarget';
import { isWindows } from '@/lib/setup';
import type { WorktreeInfo } from '@/lib/worktrees';
import { AgentChatMarkdown, AgentChatCopyButton } from './AgentChatMarkdown';
import { PixelLoaderWaves } from './PixelLoaderWaves';
import { AgentChatRequestCard } from './AgentChatRequestCard';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { AgentChatInbox } from './AgentChatInbox';

export interface AgentChatPanelProps {
  projectPath: string;
  autoAcceptMode: boolean;
  worktrees: WorktreeInfo[];
  onCreateWorktree: () => void;
}

function threadTitle(thread: ChatThread): string {
  return thread.title.trim() || 'New conversation';
}

function checkoutLabel(
  checkoutPath: string,
  projectPath: string,
  worktrees: WorktreeInfo[]
): string {
  if (checkoutPath === projectPath) return 'Current checkout';
  const worktree = worktrees.find((candidate) => candidate.path === checkoutPath);
  if (worktree?.branch) return worktree.branch;
  if (worktree?.isMain) return 'Main checkout';
  if (worktree) return 'Detached worktree';
  return checkoutPath;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function useElapsedTimer(isActive: boolean, timerKey: string): number | null {
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const timerRef = useRef<{
    key: string | null;
    startedAt: number | null;
    accumulatedMs: number;
    hasStarted: boolean;
  }>({ key: null, startedAt: null, accumulatedMs: 0, hasStarted: false });

  useEffect(() => {
    const now = Date.now();
    const timer = timerRef.current;
    if (timer.key !== timerKey) {
      timer.key = timerKey;
      timer.startedAt = isActive ? now : null;
      timer.accumulatedMs = 0;
      timer.hasStarted = isActive;
    } else if (isActive && timer.startedAt === null) {
      timer.startedAt = now;
      timer.hasStarted = true;
    } else if (!isActive && timer.startedAt !== null) {
      timer.accumulatedMs += now - timer.startedAt;
      timer.startedAt = null;
    }

    const updateElapsed = () => {
      const current = timerRef.current;
      if (!current.hasStarted) {
        setElapsedMs(null);
        return;
      }
      setElapsedMs(
        current.accumulatedMs + (current.startedAt === null ? 0 : Date.now() - current.startedAt)
      );
    };

    updateElapsed();
    if (!isActive) return;

    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [isActive, timerKey]);

  return elapsedMs;
}

function turnDurationKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function useCompletedTurnDurations(threads: ChatThread[]): Map<string, number> {
  const storeRef = useRef<{
    observedTurns: Map<string, { turnId: string | null; startedAt: number }>;
    durations: Map<string, number>;
    listeners: Set<() => void>;
  }>({ observedTurns: new Map(), durations: new Map(), listeners: new Set() });
  const subscribe = useCallback((listener: () => void) => {
    storeRef.current.listeners.add(listener);
    return () => storeRef.current.listeners.delete(listener);
  }, []);
  const getSnapshot = useCallback(() => storeRef.current.durations, []);
  const durations = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const now = Date.now();
    const store = storeRef.current;
    const observedTurns = store.observedTurns;
    const nextDurations = new Map(store.durations);
    let changed = false;

    for (const thread of threads) {
      const isActive = ['starting', 'running', 'waiting'].includes(thread.status);
      const observed = observedTurns.get(thread.id);

      if (isActive) {
        if (!observed) {
          observedTurns.set(thread.id, { turnId: thread.turnId, startedAt: now });
        } else if (observed.turnId === null && thread.turnId !== null) {
          observed.turnId = thread.turnId;
        } else if (
          observed.turnId !== null &&
          thread.turnId !== null &&
          observed.turnId !== thread.turnId
        ) {
          nextDurations.set(
            turnDurationKey(thread.id, observed.turnId),
            Math.max(0, now - observed.startedAt)
          );
          changed = true;
          observedTurns.set(thread.id, { turnId: thread.turnId, startedAt: now });
        }
        continue;
      }

      if (observed) {
        const turnId = observed.turnId ?? thread.turnId;
        if (turnId !== null) {
          nextDurations.set(
            turnDurationKey(thread.id, turnId),
            Math.max(0, now - observed.startedAt)
          );
          changed = true;
        }
        observedTurns.delete(thread.id);
      }
    }

    if (changed) {
      store.durations = nextDurations;
      store.listeners.forEach((listener) => listener());
    }
  }, [threads]);

  return durations;
}

type AttachmentPreviewKind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'file';

function attachmentPreviewKind(attachment: ChatAttachment): AttachmentPreviewKind {
  const mimeType = attachment.mimeType.toLowerCase();
  const extension = attachment.name.split('.').pop()?.toLowerCase();
  if (attachment.kind === 'image' || mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (
    mimeType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml'].includes(mimeType)
  ) {
    return 'text';
  }
  return 'file';
}

function AttachmentMedia({
  attachment,
  previewKind,
}: {
  attachment: ChatAttachment;
  previewKind: AttachmentPreviewKind;
}) {
  if (attachment.available !== true) {
    const availabilityMessage =
      attachment.available === false
        ? 'File bytes are unavailable. Its saved name remains available.'
        : 'File availability has not been confirmed.';
    return (
      <div className="agent-chat-attachment__file-content agent-chat__staged-file-content">
        <FileIcon size={16} />
        <span>{availabilityMessage}</span>
      </div>
    );
  }
  const src = convertFileSrc(attachment.path);

  if (previewKind === 'image') {
    return <img src={src} alt={attachment.name} loading="lazy" />;
  }
  if (previewKind === 'pdf') {
    return (
      <iframe
        src={`${src}#page=1&toolbar=0&navpanes=0`}
        title={`${attachment.name}, first page preview`}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (previewKind === 'audio') {
    return <audio controls preload="none" src={src} aria-label={attachment.name} />;
  }
  if (previewKind === 'video') {
    return <video controls playsInline preload="metadata" src={src} aria-label={attachment.name} />;
  }
  if (previewKind === 'text') {
    return (
      <iframe
        src={src}
        title={`${attachment.name} preview`}
        loading="lazy"
        sandbox=""
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div className="agent-chat-attachment__file-content agent-chat__staged-file-content">
      <FileIcon size={16} />
      <span>
        {attachment.mimeType === 'application/octet-stream' ? 'File' : attachment.mimeType}
      </span>
      <span>{formatSize(attachment.size)}</span>
    </div>
  );
}

function itemRoleLabel(item: ChatItem): string {
  if (item.kind === 'assistant') return 'Codex';
  if (item.kind === 'user') return 'You';
  if (item.kind === 'reasoning') return 'Reasoning';
  if (item.kind === 'tool') return 'Tool activity';
  if (item.kind === 'fileChange') return 'File change';
  if (item.kind === 'plan') return 'Plan';
  if (item.kind === 'error') return 'Error';
  return 'Activity';
}

function toolDescription(item: ChatItem): string {
  const firstLine = item.text.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim() || item.status || 'Tool activity';
}

function AttachmentPreview({ attachment }: { attachment: ChatAttachment }) {
  const previewKind = attachmentPreviewKind(attachment);
  if (previewKind === 'file') {
    return (
      <div className="agent-chat-attachment agent-chat-attachment--file">
        <FileIcon size={16} />
        <span className="agent-chat-attachment__name" title={attachment.name}>
          {attachment.name}
        </span>
        <span>{formatSize(attachment.size)}</span>
        {attachment.available === false && <span>File bytes unavailable</span>}
        {attachment.available === undefined && <span>Availability unconfirmed</span>}
      </div>
    );
  }
  if (previewKind === 'image') {
    return (
      <figure className="agent-chat-attachment agent-chat-attachment--image">
        <AttachmentMedia attachment={attachment} previewKind={previewKind} />
        <figcaption>
          <span>{attachment.name}</span>
          <span>{formatSize(attachment.size)}</span>
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className={`agent-chat-attachment agent-chat-attachment--${previewKind}`}>
      <AttachmentMedia attachment={attachment} previewKind={previewKind} />
      <figcaption>
        <span title={attachment.name}>{attachment.name}</span>
        <span>{formatSize(attachment.size)}</span>
      </figcaption>
    </figure>
  );
}

function isEmptyReasoning(item: ChatItem): boolean {
  return item.kind === 'reasoning' && !item.text.trim();
}

function collapseEmptyReasoningItems(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  for (const item of items) {
    const previous = collapsed[collapsed.length - 1];
    if (isEmptyReasoning(item) && previous && isEmptyReasoning(previous)) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        status: item.status ?? previous.status,
      };
      continue;
    }
    collapsed.push(item);
  }
  return collapsed;
}

function visibleTranscriptItems(items: ChatItem[]): ChatItem[] {
  return collapseEmptyReasoningItems(
    items.filter((item) => !(isEmptyReasoning(item) && item.status === 'completed'))
  );
}

function isActivityItem(item: ChatItem): boolean {
  return item.kind === 'tool' || item.kind === 'reasoning' || item.kind === 'plan';
}

function groupActivityItems(
  items: ChatItem[]
): Array<{ kind: 'activity'; items: ChatItem[] } | { kind: 'item'; item: ChatItem }> {
  const groups: Array<{ kind: 'activity'; items: ChatItem[] } | { kind: 'item'; item: ChatItem }> =
    [];

  for (const item of items) {
    const previous = groups[groups.length - 1];
    if (isActivityItem(item) && previous?.kind === 'activity') {
      previous.items.push(item);
    } else if (isActivityItem(item)) {
      groups.push({ kind: 'activity', items: [item] });
    } else {
      groups.push({ kind: 'item', item });
    }
  }

  return groups;
}

function ChatActivityGroup({
  items,
  threadId,
  isRunning,
}: {
  items: ChatItem[];
  threadId: string;
  isRunning: boolean;
}) {
  const [entryState, setEntryState] = useState(() => ({
    seen: new Set(items.map((item) => item.id)),
    entering: new Set<string>(),
  }));
  const newItems = items.filter((item) => !entryState.seen.has(item.id));
  if (newItems.length > 0 || (!isRunning && entryState.entering.size > 0)) {
    const seen = new Set(entryState.seen);
    const entering = isRunning ? new Set(entryState.entering) : new Set<string>();
    for (const item of newItems) {
      seen.add(item.id);
      if (isRunning) entering.add(item.id);
    }
    setEntryState({ seen, entering });
  }

  return (
    <div className="agent-chat__activity-group">
      {items.map((item) => (
        <div
          className="agent-chat__activity-entry"
          data-entering={isRunning && entryState.entering.has(item.id) ? 'true' : undefined}
          key={`${threadId}:${item.id}`}
        >
          <ChatItemView item={item} timerKey={`${threadId}:${item.id}`} />
        </div>
      ))}
    </div>
  );
}

function ChatItemView({ item, timerKey }: { item: ChatItem; timerKey: string }) {
  const emptyReasoning = isEmptyReasoning(item);
  const reasoningElapsedMs = useElapsedTimer(emptyReasoning && item.status === 'running', timerKey);
  const isCollapsible =
    item.kind === 'tool' || (item.kind === 'reasoning' && !emptyReasoning) || item.kind === 'plan';
  const isUser = item.kind === 'user';
  const isAssistant = item.kind === 'assistant';
  const body = item.text ? <AgentChatMarkdown text={item.text} /> : null;
  const attachments = item.attachments.map((attachment) => (
    <AttachmentPreview attachment={attachment} key={attachment.id} />
  ));

  if (emptyReasoning) {
    return (
      <div
        className="agent-chat-item agent-chat-item--activity agent-chat-item--empty-reasoning"
        role="status"
      >
        <ZapIcon size={14} aria-hidden="true" />
        <span className="agent-chat-item__role">Reasoning…</span>
        {reasoningElapsedMs !== null && (
          <span
            className="agent-chat-item__elapsed"
            aria-label={`Elapsed reasoning time ${formatElapsedDuration(reasoningElapsedMs)}`}
          >
            {formatElapsedDuration(reasoningElapsedMs)}
          </span>
        )}
      </div>
    );
  }

  if (isCollapsible) {
    return (
      <details
        className="agent-chat-item agent-chat-item--activity agent-chat-item--detail"
        data-kind={item.kind}
      >
        <summary>
          <ChevronIcon size={14} aria-hidden="true" />
          {item.kind === 'tool' && <ActivityIcon size={14} aria-hidden="true" />}
          {item.kind === 'reasoning' && <ZapIcon size={14} aria-hidden="true" />}
          <span className="agent-chat-item__summary-description">
            {item.kind === 'tool' ? toolDescription(item) : itemRoleLabel(item)}
          </span>
          {item.status && <span className="agent-chat-item__status">{item.status}</span>}
        </summary>
        <div className="agent-chat-item__detail-body">
          {item.kind === 'tool' && item.text ? (
            <pre className="agent-chat-item__tool-output">
              <code>{item.text}</code>
            </pre>
          ) : (
            (body ??
            (item.kind === 'reasoning' ? (
              <p className="agent-chat-item__empty-reasoning">Waiting for summary text…</p>
            ) : null))
          )}
          {attachments}
        </div>
      </details>
    );
  }

  return (
    <article
      className={`agent-chat-item${isAssistant && item.text ? ' agent-chat-item--assistant-text' : ''}`}
      data-kind={item.kind}
    >
      <header className="agent-chat-item__header">
        <span className="agent-chat-item__role">
          {item.kind === 'error' ? <AlertIcon size={14} /> : null}
          {itemRoleLabel(item)}
        </span>
        {(item.status || (isAssistant && item.text)) && (
          <div className="agent-chat-item__header-end">
            {item.status && <span className="agent-chat-item__status">{item.status}</span>}
            {isAssistant && item.text && <AgentChatCopyButton text={item.text} />}
          </div>
        )}
      </header>
      {isUser && item.text && <div className="agent-chat-item__user-body">{body}</div>}
      {!isUser && body}
      {attachments.length > 0 && <div className="agent-chat-item__attachments">{attachments}</div>}
    </article>
  );
}

export function AgentChatPanel(props: AgentChatPanelProps) {
  return <AgentChatPanelContents key={props.projectPath} {...props} />;
}

function AgentChatPanelContents({
  projectPath,
  autoAcceptMode,
  worktrees,
  onCreateWorktree,
}: AgentChatPanelProps) {
  const [discardTargetThreadId, setDiscardTargetThreadId] = useState<string | null>(null);
  const [deleteTargetDraftId, setDeleteTargetDraftId] = useState<string | null>(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const isFollowingLatestRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousItemsRef = useRef<ChatItem[]>([]);
  const previousRequestsKeyRef = useRef('');
  const previousStatusRef = useRef<ChatThread['status'] | null>(null);

  const subscribe = useCallback(
    (listener: () => void) => subscribeAgentChat(projectPath, listener),
    [projectPath]
  );
  const getSnapshot = useCallback(() => getAgentChatSnapshot(projectPath), [projectPath]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const selectedThread =
    snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId) ?? null;
  const completedTurnDurations = useCompletedTurnDurations(snapshot.threads);
  const activeId = selectedThread?.id ?? snapshot.selectedDraftId;
  const activeCheckoutPath = selectedThread?.checkoutPath ?? snapshot.selectedCheckoutPath;
  const selectedSettings = activeId
    ? (snapshot.threadSettings[activeId] ?? {
        modelId: null,
        reasoningEffort: null,
        autoAcceptMode,
      })
    : null;
  const effectiveAutoAcceptMode = selectedSettings?.autoAcceptMode ?? autoAcceptMode;
  const selectedModel = selectedSettings
    ? selectedSettings.modelId
      ? (snapshot.models.find((model) => model.id === selectedSettings.modelId) ?? null)
      : (snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0] ?? null)
    : null;
  const modelUnavailable = Boolean(
    selectedSettings?.modelId &&
    !snapshot.models.some((model) => model.id === selectedSettings.modelId)
  );
  const effortUnavailable = Boolean(
    selectedSettings?.reasoningEffort &&
    (!selectedModel || !selectedModel.reasoningEfforts.includes(selectedSettings.reasoningEffort))
  );
  const sendSafety = activeId ? snapshot.sendSafety[activeId] : undefined;
  const currentError = activeId
    ? (snapshot.threadErrors[activeId] ?? selectedThread?.error ?? null)
    : null;
  const currentDraft = activeId ? (snapshot.drafts[activeId] ?? '') : '';
  const selectedAttachments = activeId ? (snapshot.stagedAttachments[activeId] ?? []) : [];
  const unavailableAttachments = selectedAttachments.some(
    (attachment) => attachment.available === false
  );
  const unverifiedAttachments = selectedAttachments.some(
    (attachment) => attachment.available !== true
  );
  const attachmentAvailability = activeId ? snapshot.attachmentAvailability[activeId] : undefined;
  const threadIsActive =
    selectedThread && ['starting', 'running', 'waiting'].includes(selectedThread.status);
  const workingElapsedMs = useElapsedTimer(
    Boolean(threadIsActive),
    selectedThread ? `${selectedThread.id}:${selectedThread.turnId ?? 'unassigned'}` : 'no-thread'
  );
  const isSending = activeId
    ? snapshot.sendingThreadIds.includes(activeId) || snapshot.sendingDraftIds.includes(activeId)
    : false;
  const resumeCheckNeeded = Boolean(
    selectedThread &&
    selectedThread.checkoutStatus === 'available' &&
    (selectedThread.providerStatus === 'active' ||
      selectedThread.resumeStatus === 'unknown' ||
      selectedThread.providerStatus === 'unknown' ||
      selectedThread.providerStatus === 'notLoaded' ||
      (sendSafety && !sendSafety.reconciled))
  );
  const sendDisabled = Boolean(
    threadIsActive ||
    isSending ||
    modelUnavailable ||
    effortUnavailable ||
    unverifiedAttachments ||
    attachmentAvailability === 'checking' ||
    (selectedThread && selectedThread.checkoutStatus !== 'available') ||
    (selectedThread && selectedThread.resumeStatus !== 'available') ||
    selectedThread?.providerStatus === 'active' ||
    selectedThread?.providerStatus === 'unknown' ||
    selectedThread?.providerStatus === 'notLoaded' ||
    (sendSafety && (!sendSafety.reconciled || sendSafety.blockedText === currentDraft))
  );

  const { execute: sendTurn } = useAsyncState<ChatThread, [string, string]>((threadId, text) =>
    sendAgentChatTurn(projectPath, threadId, text, effectiveAutoAcceptMode)
  );
  const { execute: interruptThread } = useAsyncState<ChatThread, [string]>((threadId) =>
    interruptAgentChatThread(projectPath, threadId)
  );
  const {
    execute: discardThread,
    reset: resetDiscard,
    isLoading: isDiscarding,
    error: discardError,
  } = useAsyncState<boolean, [string]>(async (threadId) => {
    await discardAgentChatThread(projectPath, threadId);
    return true;
  });
  const {
    execute: deleteDraft,
    reset: resetDeleteDraft,
    isLoading: isDeletingDraft,
    error: deleteDraftError,
  } = useAsyncState<boolean, [string]>(async (draftId) => {
    await deleteAgentChatDraft(projectPath, draftId);
    return true;
  });
  const {
    execute: stagePaths,
    isLoading: isStaging,
    error: stagingError,
  } = useAsyncState<ChatAttachment[], [AgentChatCaptureTarget, string[]]>(async (target, paths) =>
    Promise.all(
      paths.map(async (path) => {
        const attachment = await stageCapturedAttachment(target, path);
        if (!attachment) throw new Error('The destination conversation is no longer available.');
        return attachment;
      })
    )
  );
  const {
    execute: checkThreadHistory,
    isLoading: isCheckingHistory,
    error: historyCheckError,
  } = useAsyncState<ChatThread, [string]>((threadId) =>
    resumeCheckAgentChatThread(projectPath, threadId)
  );
  const { execute: relinkCheckout, isLoading: isRelinkingCheckout } = useAsyncState<
    boolean,
    [string, string]
  >(async (threadId, checkoutPath) => {
    await relinkAgentChatCheckout(projectPath, threadId, checkoutPath);
    return true;
  });
  const { execute: relinkProject, isLoading: isRelinkingProject } = useAsyncState<
    boolean,
    [string]
  >(async (projectId) => {
    await relinkUnlinkedAgentChatProject(projectPath, projectId);
    return true;
  });

  useEffect(() => {
    void loadAgentChatProject(projectPath);
  }, [projectPath]);

  const draftCheckoutPaths = useMemo(
    () => [
      ...new Set([
        projectPath,
        snapshot.selectedCheckoutPath,
        ...worktrees.map((item) => item.path),
      ]),
    ],
    [projectPath, snapshot.selectedCheckoutPath, worktrees]
  );
  useEffect(() => {
    draftCheckoutPaths.forEach((checkoutPath) => {
      void loadAgentChatDrafts(projectPath, checkoutPath);
    });
  }, [draftCheckoutPaths, projectPath]);

  const setFollowingLatest = useCallback((following: boolean) => {
    isFollowingLatestRef.current = following;
    setIsFollowingLatest((current) => (current === following ? current : following));
  }, []);

  const scrollToEnd = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const scroll = transcriptRef.current;
      if (!scroll) return;
      scroll.scrollTo({ top: scroll.scrollHeight, behavior });
      previousScrollTopRef.current = scroll.scrollTop;
      setFollowingLatest(true);
    },
    [setFollowingLatest]
  );

  useLayoutEffect(() => {
    const threadId = selectedThread?.id ?? null;
    const items = selectedThread?.items ?? [];
    const requests = selectedThread?.requests ?? [];
    const previousThreadId = previousThreadIdRef.current;
    const previousItems = previousItemsRef.current;
    const previousRequestsKey = previousRequestsKeyRef.current;
    const previousStatus = previousStatusRef.current;
    const threadChanged = previousThreadId !== threadId;
    const gainedItems = items.length > previousItems.length;
    const previousItemsById = new Map(previousItems.map((item) => [item.id, item]));
    const updatedItemCount = threadChanged
      ? 0
      : items.filter((item) => {
          const previousItem = previousItemsById.get(item.id);
          return (
            previousItem !== undefined &&
            (item.text !== previousItem.text || item.status !== previousItem.status)
          );
        }).length;
    const requestsKey = JSON.stringify(
      requests.map((request) => [request.id, request.method, request.title, request.params])
    );
    const requestsChanged =
      !threadChanged && selectedThread !== null && requestsKey !== previousRequestsKey;
    const statusChanged =
      !threadChanged && selectedThread !== null && previousStatus !== selectedThread.status;
    const hasActivity = gainedItems || updatedItemCount > 0 || requestsChanged || statusChanged;

    if (threadChanged) {
      isFollowingLatestRef.current = true;
      previousScrollTopRef.current = 0;
    }
    const shouldScroll = threadChanged || (isFollowingLatestRef.current && hasActivity);
    const frame = window.requestAnimationFrame(() => {
      if (shouldScroll) scrollToEnd('auto');
    });

    previousThreadIdRef.current = threadId;
    previousItemsRef.current = items;
    previousRequestsKeyRef.current = requestsKey;
    previousStatusRef.current = selectedThread?.status ?? null;
    return () => window.cancelAnimationFrame(frame);
  }, [selectedThread, scrollToEnd, setFollowingLatest]);

  const updateModel = (modelId: string) => {
    if (!activeId) return;
    const model = snapshot.models.find((candidate) => candidate.id === modelId);
    setAgentChatThreadSettings(projectPath, activeId, {
      modelId,
      reasoningEffort: model?.defaultReasoningEffort ?? null,
      autoAcceptMode: selectedSettings?.autoAcceptMode ?? autoAcceptMode,
    });
  };

  const updateReasoningEffort = (effort: string) => {
    if (!activeId || !selectedSettings) return;
    setAgentChatThreadSettings(projectPath, activeId, {
      ...selectedSettings,
      reasoningEffort: effort || null,
      autoAcceptMode: selectedSettings.autoAcceptMode ?? autoAcceptMode,
    });
  };

  const handleSend = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!activeId || sendDisabled) return;
    if (!currentDraft.trim() && selectedAttachments.length === 0) return;
    if (selectedThread) {
      void sendTurn(selectedThread.id, currentDraft);
      return;
    }
    void sendAgentChatDraftTurn(
      projectPath,
      activeId,
      activeCheckoutPath,
      currentDraft,
      effectiveAutoAcceptMode
    ).catch(() => undefined);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      if (sendDisabled) return;
      event.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const containsImage = Array.from(event.clipboardData.items).some((item) =>
      item.type.startsWith('image/')
    );
    if (!containsImage) return;
    event.preventDefault();
    const target = getAgentChatCaptureTarget(projectPath);
    if (!target) {
      setCaptureHint('Select a conversation before attaching an image.');
      return;
    }
    setCaptureHint(null);
    void stageClipboardImage()
      .then((path) => {
        if (path) return stagePaths(target, [path]);
        setCaptureHint('The clipboard did not contain an image.');
        return null;
      })
      .catch((error: unknown) => {
        setCaptureHint(
          error instanceof Error ? error.message : 'Could not read the clipboard image.'
        );
      });
  };

  const handlePickFiles = async () => {
    const target = getAgentChatCaptureTarget(projectPath);
    if (!target) {
      setCaptureHint('Select a conversation before attaching files.');
      return;
    }
    try {
      const paths = await openDialog({ multiple: true, title: 'Attach files to conversation' });
      if (!paths) return;
      const selectedPaths = Array.isArray(paths) ? paths : [paths];
      if (selectedPaths.length > 0) {
        setCaptureHint(null);
        await stagePaths(target, selectedPaths);
      }
    } catch (error) {
      setCaptureHint(error instanceof Error ? error.message : 'Could not open the file picker.');
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let mounted = true;
    const installDropListener = async () => {
      const remove = await listen<{
        paths: string[];
        position: { x: number; y: number };
      }>('tauri://drag-drop', (event) => {
        const panel = panelRef.current;
        if (
          !panel ||
          panel.offsetParent === null ||
          getComputedStyle(panel).visibility !== 'visible'
        )
          return;
        const point = dropPointToLogical(
          event.payload.position,
          isWindows(),
          window.devicePixelRatio
        );
        if (
          !isPointInRect(point, panel.getBoundingClientRect()) ||
          event.payload.paths.length === 0
        )
          return;
        const target = getAgentChatCaptureTarget(projectPath);
        if (!target) {
          setCaptureHint('Select a conversation before dropping files.');
          return;
        }
        setCaptureHint(null);
        void stagePaths(target, event.payload.paths);
      });
      if (!mounted) remove();
      else unlisten = remove;
    };
    void installDropListener().catch((error: unknown) => {
      if (mounted) {
        setCaptureHint(error instanceof Error ? error.message : 'File drop is unavailable here.');
      }
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [projectPath, stagePaths]);

  const handleNewWorktree = () => {
    setCaptureHint('Create a worktree, then select it here for a new conversation.');
    onCreateWorktree();
  };

  const handleDiscard = async () => {
    if (!discardTargetThreadId) return;
    const result = await discardThread(discardTargetThreadId);
    if (result) setDiscardTargetThreadId(null);
  };

  const handleDeleteDraft = async () => {
    if (!deleteTargetDraftId) return;
    const result = await deleteDraft(deleteTargetDraftId);
    if (result) setDeleteTargetDraftId(null);
  };

  const availableWorktrees = useMemo(() => {
    const byPath = new Map<string, WorktreeInfo>();
    worktrees.forEach((worktree) => byPath.set(worktree.path, worktree));
    return [...byPath.values()];
  }, [worktrees]);
  const requestItems = selectedThread?.requests ?? [];
  const discardTargetThread =
    snapshot.threads.find((thread) => thread.id === discardTargetThreadId) ?? null;
  const deleteTargetDraft =
    snapshot.savedDrafts.find((draft) => draft.draftId === deleteTargetDraftId) ?? null;
  const visibleItems = visibleTranscriptItems(selectedThread?.items ?? []);
  const transcriptGroups = groupActivityItems(visibleItems);
  const commandCountsByTurn = new Map<string, number>();
  const firstCommandGroupByTurn = new Map<string, number>();
  transcriptGroups.forEach((group, groupIndex) => {
    if (group.kind !== 'activity') return;
    for (const item of group.items) {
      if (item.kind !== 'tool' || item.turnId === null) continue;
      commandCountsByTurn.set(item.turnId, (commandCountsByTurn.get(item.turnId) ?? 0) + 1);
      if (!firstCommandGroupByTurn.has(item.turnId)) {
        firstCommandGroupByTurn.set(item.turnId, groupIndex);
      }
    }
  });
  const summariesBeforeGroup = new Map<
    number,
    Array<{ turnId: string; durationMs: number; commandCount: number }>
  >();
  for (const [turnId, groupIndex] of firstCommandGroupByTurn) {
    if (threadIsActive && selectedThread?.turnId === turnId) continue;
    const durationMs = selectedThread
      ? completedTurnDurations.get(turnDurationKey(selectedThread.id, turnId))
      : undefined;
    const commandCount = commandCountsByTurn.get(turnId) ?? 0;
    if (durationMs === undefined || commandCount === 0) continue;
    const summaries = summariesBeforeGroup.get(groupIndex) ?? [];
    summaries.push({ turnId, durationMs, commandCount });
    summariesBeforeGroup.set(groupIndex, summaries);
  }
  const sendIsAllowed =
    !sendDisabled && (Boolean(currentDraft.trim()) || selectedAttachments.length > 0);

  const composer = (
    <form
      className={`agent-chat__composer${selectedThread ? ' agent-chat__composer--thread' : ' agent-chat__composer--welcome'}`}
      onSubmit={handleSend}
    >
      {currentError && (
        <div className="agent-chat__send-error" role="alert">
          <AlertIcon size={14} />
          <span>{currentError}</span>
        </div>
      )}
      {snapshot.error && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          {snapshot.error}
        </p>
      )}
      {modelUnavailable && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          The saved model is unavailable. Choose a discovered model before sending; the stored model
          will not be substituted silently.
        </p>
      )}
      {effortUnavailable && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          The saved reasoning effort is unavailable for this model. Choose a supported effort or
          Default effort.
        </p>
      )}
      {unavailableAttachments && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          One or more saved attachments are unavailable. Remove them and attach the files again
          before sending.
        </p>
      )}
      {!unavailableAttachments &&
        unverifiedAttachments &&
        attachmentAvailability === 'checking' && (
          <p className="agent-chat__notice" role="status">
            Checking saved attachment availability… Sending will be enabled after the files are
            verified.
          </p>
        )}
      {!unavailableAttachments &&
        unverifiedAttachments &&
        attachmentAvailability !== 'checking' && (
          <p className="agent-chat__notice" role="status">
            Saved attachment availability could not be confirmed. Sending is paused; reload this
            draft to retry.
          </p>
        )}
      {sendSafety && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          {sendSafety.message}
          <Button
            size="compact"
            variant="secondary"
            onClick={() => createAgentChatDraft(projectPath, activeCheckoutPath)}
          >
            Start new conversation
          </Button>
        </p>
      )}
      {historyCheckError && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          {historyCheckError.message}
        </p>
      )}
      {captureHint && (
        <p className="agent-chat__notice" role="status">
          {captureHint}
        </p>
      )}
      {stagingError && (
        <p className="agent-chat__notice agent-chat__notice--error" role="alert">
          {stagingError.message}
        </p>
      )}

      {selectedAttachments.length > 0 && (
        <div
          className="agent-chat__staged-attachments"
          role="group"
          aria-label="Attachments to send"
        >
          {selectedAttachments.map((attachment) => {
            const previewKind = attachmentPreviewKind(attachment);
            const removeButton = (
              <IconButton
                icon={<CloseIcon size={12} />}
                aria-label={`Remove ${attachment.name}`}
                title={`Remove ${attachment.name}`}
                variant="ghost"
                size="compact"
                onClick={() =>
                  removeStagedAgentChatAttachment(projectPath, activeId ?? '', attachment.id)
                }
              />
            );
            return (
              <figure
                className="agent-chat__staged-card"
                data-preview={previewKind}
                key={attachment.id}
              >
                <figcaption className="agent-chat__staged-card-header">
                  <span title={attachment.name}>{attachment.name}</span>
                  {removeButton}
                </figcaption>
                <div className="agent-chat__staged-preview">
                  <AttachmentMedia attachment={attachment} previewKind={previewKind} />
                </div>
              </figure>
            );
          })}
        </div>
      )}

      <TextArea
        className="agent-chat__input"
        value={currentDraft}
        rows={3}
        autoFocus={!selectedThread}
        placeholder="Ask for changes, send a follow-up, or attach an image"
        aria-label="Message Codex"
        onChange={(event) => {
          if (activeId) setAgentChatDraft(projectPath, activeId, event.target.value);
        }}
        onKeyDown={handleComposerKeyDown}
        onPaste={handlePaste}
      />

      <div className="agent-chat__composer-toolbar">
        <div className="agent-chat__composer-settings">
          <Dropdown
            align="left"
            side="top"
            portal
            menuClassName="agent-chat__setting-menu"
            trigger={(triggerProps) => (
              <MenuButton
                ref={triggerProps.ref}
                onClick={triggerProps.onClick}
                expanded={triggerProps['aria-expanded']}
                size="compact"
                variant="ghost"
                className="agent-chat__setting-trigger"
                rightIcon={<ChevronIcon size={12} />}
                aria-label="Model"
                disabled={!activeId || snapshot.models.length === 0}
                title={selectedModel?.description ?? undefined}
              >
                <span>
                  {modelUnavailable
                    ? `Unavailable: ${selectedSettings?.modelId}`
                    : (selectedModel?.label ??
                      (snapshot.models.length === 0 ? 'Models unavailable' : 'Model'))}
                </span>
              </MenuButton>
            )}
          >
            {modelUnavailable && (
              <DropdownItem disabled onSelect={() => undefined}>
                Saved model unavailable: {selectedSettings?.modelId}
              </DropdownItem>
            )}
            {snapshot.models.map((model) => (
              <DropdownItem
                key={model.id}
                active={selectedModel?.id === model.id}
                onSelect={() => updateModel(model.id)}
                disabled={!activeId}
              >
                {model.label}
              </DropdownItem>
            ))}
          </Dropdown>
          <Dropdown
            align="left"
            side="top"
            portal
            menuClassName="agent-chat__setting-menu"
            trigger={(triggerProps) => (
              <MenuButton
                ref={triggerProps.ref}
                onClick={triggerProps.onClick}
                expanded={triggerProps['aria-expanded']}
                size="compact"
                variant="ghost"
                className="agent-chat__setting-trigger agent-chat__setting-trigger--effort"
                rightIcon={<ChevronIcon size={12} />}
                aria-label="Reasoning effort"
                disabled={!selectedModel || selectedModel.reasoningEfforts.length === 0}
              >
                <span>
                  {effortUnavailable
                    ? `Unavailable: ${selectedSettings?.reasoningEffort}`
                    : (selectedSettings?.reasoningEffort ?? 'Default effort')}
                </span>
              </MenuButton>
            )}
          >
            {effortUnavailable && (
              <DropdownItem disabled onSelect={() => undefined}>
                Saved effort unavailable: {selectedSettings?.reasoningEffort}
              </DropdownItem>
            )}
            <DropdownItem
              active={!selectedSettings?.reasoningEffort}
              onSelect={() => updateReasoningEffort('')}
              disabled={!selectedModel}
            >
              Default effort
            </DropdownItem>
            {selectedModel?.reasoningEfforts.map((effort) => (
              <DropdownItem
                key={effort}
                active={selectedSettings?.reasoningEffort === effort}
                onSelect={() => updateReasoningEffort(effort)}
              >
                {effort}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
        <div className="agent-chat__composer-actions">
          <IconButton
            icon={<PlusIcon size={16} />}
            aria-label="Attach files"
            title="Attach files"
            variant="ghost"
            size="compact"
            className="agent-chat__attach-button"
            disabled={isStaging}
            onClick={() => void handlePickFiles()}
          />
          <IconButton
            icon={<PushIcon size={16} />}
            aria-label="Send message"
            title="Send message"
            variant="primary"
            size="compact"
            className="agent-chat__send-button"
            type="submit"
            disabled={!sendIsAllowed}
          />
        </div>
      </div>
    </form>
  );

  return (
    <section className="agent-chat" ref={panelRef} aria-label="Agent chat">
      <AgentChatInbox
        projectPath={projectPath}
        threads={snapshot.threads}
        savedDrafts={snapshot.savedDrafts}
        drafts={snapshot.drafts}
        stagedAttachments={snapshot.stagedAttachments}
        selectedThreadId={selectedThread?.id ?? null}
        selectedDraftId={snapshot.selectedDraftId}
        selectedCheckoutPath={snapshot.selectedCheckoutPath}
        draftCheckoutPaths={snapshot.draftCheckoutPaths}
        draftThreadIds={snapshot.draftThreadIds}
        threadErrors={snapshot.threadErrors}
        draftPageOffsets={snapshot.draftPageOffsets}
        loadingDraftCheckouts={snapshot.loadingDraftCheckouts}
        draftPageErrors={snapshot.draftPageErrors}
        onRequestDiscard={(threadId) => {
          resetDiscard();
          setDiscardTargetThreadId(threadId);
        }}
        onRequestDeleteDraft={(draftId) => {
          resetDeleteDraft();
          setDeleteTargetDraftId(draftId);
        }}
      />

      {snapshot.storageStatus && !snapshot.storageStatus.available && (
        <div className="agent-chat__recovery agent-chat__recovery--error" role="alert">
          <strong>Saved Chat storage is unavailable</strong>
          <span>
            {snapshot.storageStatus.error ?? 'Ship Studio could not read its Agent Chat database.'}
          </span>
          <span>Your saved conversations were not cleared.</span>
        </div>
      )}

      {snapshot.unlinkedProjects.map((unlinked) => (
        <div className="agent-chat__recovery" key={unlinked.id}>
          <strong>Saved conversations need a project link</strong>
          <span>Previously linked path: {unlinked.lastPath || 'Unavailable'}</span>
          <span>
            {unlinked.threadCount} saved conversation{unlinked.threadCount === 1 ? '' : 's'}
          </span>
          <span>
            History is preserved. Link this saved project identity to the open repository only if it
            is the same project.
          </span>
          <Button
            size="compact"
            variant="secondary"
            disabled={isRelinkingProject}
            onClick={() => void relinkProject(unlinked.id)}
          >
            {isRelinkingProject ? 'Linking…' : 'Link saved conversations here'}
          </Button>
        </div>
      ))}

      {selectedThread &&
        (selectedThread.checkoutStatus !== 'available' ||
          selectedThread.resumeStatus !== 'available' ||
          selectedThread.providerStatus === 'active' ||
          selectedThread.providerStatus === 'unknown' ||
          selectedThread.providerStatus === 'notLoaded' ||
          selectedThread.providerStatus === 'systemError' ||
          Boolean(sendSafety)) && (
          <div className="agent-chat__recovery" role="status">
            <strong>Saved history is available in Ship Studio.</strong>
            {selectedThread.checkoutStatus !== 'available' && (
              <>
                <span>
                  This conversation is still linked to {selectedThread.checkoutPath}; its checkout
                  is {selectedThread.checkoutStatus}.
                </span>
                <CheckoutRelinkMenu
                  worktrees={availableWorktrees}
                  projectPath={projectPath}
                  disabled={
                    isRelinkingCheckout ||
                    selectedThread.providerStatus === 'active' ||
                    ['starting', 'running', 'waiting'].includes(selectedThread.status)
                  }
                  onSelect={(path) => void relinkCheckout(selectedThread.id, path)}
                  onCreateWorktree={handleNewWorktree}
                />
              </>
            )}
            {selectedThread.providerStatus === 'active' ? (
              <span>
                Codex still reports an active turn. Wait for it to finish, then check its status
                before continuing.
              </span>
            ) : selectedThread.providerStatus === 'unknown' ||
              selectedThread.providerStatus === 'notLoaded' ? (
              <span>
                Codex status is unconfirmed. Check its history before sending another prompt.
              </span>
            ) : selectedThread.resumeStatus === 'available' ? (
              <span>Codex reports that this provider conversation can resume.</span>
            ) : selectedThread.resumeStatus === 'unavailable' ? (
              <span>
                Codex cannot resume this provider conversation. The Ship Studio transcript remains
                readable; start a new conversation to continue.
              </span>
            ) : (
              <span>
                Codex resumability is unconfirmed. Ship Studio will not send another prompt until
                history is checked.
              </span>
            )}
            {resumeCheckNeeded && (
              <Button
                size="compact"
                variant="secondary"
                disabled={isCheckingHistory}
                onClick={() => void checkThreadHistory(selectedThread.id)}
              >
                {isCheckingHistory ? 'Checking Codex history…' : 'Check Codex history'}
              </Button>
            )}
          </div>
        )}

      {selectedThread && (
        <div className="agent-chat__thread-scope" aria-label="Conversation scope and resumability">
          <FolderIcon size={13} />
          <span>{checkoutLabel(selectedThread.checkoutPath, projectPath, availableWorktrees)}</span>
          <span aria-hidden="true">·</span>
          <span>
            {selectedThread.providerStatus === 'active'
              ? 'Codex turn still active'
              : selectedThread.providerStatus === 'unknown' ||
                  selectedThread.providerStatus === 'notLoaded'
                ? 'Codex status unconfirmed'
                : selectedThread.resumeStatus === 'available'
                  ? 'Codex resumable'
                  : selectedThread.resumeStatus === 'unavailable'
                    ? 'Saved history only'
                    : 'Resumability unconfirmed'}
          </span>
        </div>
      )}

      {selectedThread ? (
        <>
          <div
            className="agent-chat__transcript"
            ref={transcriptRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              const currentScrollTop = element.scrollTop;
              const movedUp = currentScrollTop < previousScrollTopRef.current;
              const isAtBottom =
                element.scrollHeight - currentScrollTop - element.clientHeight <= 2;
              if (movedUp) setFollowingLatest(false);
              else if (isAtBottom) setFollowingLatest(true);
              previousScrollTopRef.current = currentScrollTop;
            }}
            onWheel={(event) => {
              if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) {
                setFollowingLatest(false);
              }
            }}
            aria-live="polite"
            aria-relevant="additions text"
          >
            <div className="agent-chat__messages">
              {transcriptGroups.map((group, groupIndex) =>
                group.kind === 'activity' ? (
                  <div
                    className="agent-chat__activity-block"
                    key={`${selectedThread.id}:${group.items[0].id}`}
                  >
                    {summariesBeforeGroup.get(groupIndex)?.map((summary) => (
                      <div className="agent-chat__turn-summary" key={summary.turnId}>
                        Thought for {formatElapsedDuration(summary.durationMs)} and ran{' '}
                        {summary.commandCount} {summary.commandCount === 1 ? 'command' : 'commands'}
                      </div>
                    ))}
                    <ChatActivityGroup
                      items={group.items}
                      threadId={selectedThread.id}
                      isRunning={Boolean(threadIsActive)}
                    />
                  </div>
                ) : (
                  <ChatItemView
                    key={`${selectedThread.id}:${group.item.id}`}
                    item={group.item}
                    timerKey={`${selectedThread.id}:${group.item.id}`}
                  />
                )
              )}
              {requestItems.map((request) => (
                <AgentChatRequestCard
                  key={request.id}
                  projectPath={projectPath}
                  threadId={selectedThread.id}
                  request={request}
                />
              ))}
              {threadIsActive && (
                <div className="agent-chat__working" role="status">
                  <PixelLoaderWaves
                    size="md"
                    label={
                      selectedThread.status === 'waiting' ? 'Codex is waiting' : 'Codex is working'
                    }
                    aria-hidden="true"
                  />
                  <span className="agent-chat__working-label">
                    {selectedThread.status === 'waiting'
                      ? 'Codex is waiting for your response.'
                      : 'Codex is working.'}
                  </span>
                  <span
                    className="agent-chat__working-duration"
                    aria-label={`Elapsed working time ${formatElapsedDuration(workingElapsedMs ?? 0)}`}
                  >
                    {formatElapsedDuration(workingElapsedMs ?? 0)}
                  </span>
                  <Button
                    size="compact"
                    variant="ghost"
                    className="agent-chat__stop-button"
                    aria-label="Stop Codex"
                    onClick={() => void interruptThread(selectedThread.id)}
                  >
                    Stop
                  </Button>
                </div>
              )}
              {selectedThread.status === 'interrupted' && (
                <div className="agent-chat__working agent-chat__working--quiet" role="status">
                  <CheckIcon size={14} />
                  <span>This conversation was stopped. You can continue with a new message.</span>
                </div>
              )}
            </div>
          </div>

          {!isFollowingLatest && (
            <div className="agent-chat__follow-control">
              <IconButton
                icon={<ArrowDownIcon size={14} />}
                aria-label="Scroll to the latest message"
                title="Scroll to the latest message"
                variant="secondary"
                size="compact"
                className="agent-chat__follow-button"
                onClick={() => scrollToEnd('smooth')}
              />
            </div>
          )}
        </>
      ) : (
        <div className="agent-chat__empty-state" aria-hidden="true" />
      )}

      {!selectedThread && (
        <div className="agent-chat__empty-content">
          <h1>What would you like to Ship?</h1>
        </div>
      )}
      {composer}
      {!selectedThread && (
        <div className="agent-chat__checkout-row">
          <CheckoutSelector
            projectPath={projectPath}
            worktrees={availableWorktrees}
            checkoutPath={activeCheckoutPath}
            onSelect={(path) => selectAgentChatDraft(projectPath, path)}
            onCreateWorktree={handleNewWorktree}
          />
        </div>
      )}

      {deleteTargetDraft && (
        <ProjectActionConfirmModal
          title="Delete this saved draft?"
          body={
            <>
              This permanently deletes this Ship Studio draft and its Ship Studio-owned staged
              attachments. It does not create or delete a Codex conversation.
              {deleteDraftError && (
                <p className="agent-chat__modal-error" role="alert">
                  {deleteDraftError.message}
                </p>
              )}
            </>
          }
          hint="The draft cannot be restored after deletion."
          loading={isDeletingDraft}
          confirmLabel="Delete draft"
          loadingLabel="Deleting…"
          confirmVariant="danger"
          onCancel={() => {
            if (!isDeletingDraft) setDeleteTargetDraftId(null);
          }}
          onConfirm={() => void handleDeleteDraft()}
        />
      )}

      {discardTargetThread && (
        <ProjectActionConfirmModal
          title="Discard this conversation?"
          body={
            <>
              This deletes Ship Studio’s saved history, draft, and owned attachments for “
              {threadTitle(discardTargetThread)}”. Codex’s provider history and its checkout are not
              deleted.
              {discardError && (
                <p className="agent-chat__modal-error" role="alert">
                  {discardError.message}
                </p>
              )}
            </>
          }
          hint="This conversation cannot be restored in Ship Studio after discard."
          loading={isDiscarding}
          confirmLabel="Discard chat"
          loadingLabel="Discarding…"
          confirmVariant="danger"
          onCancel={() => setDiscardTargetThreadId(null)}
          onConfirm={() => void handleDiscard()}
        />
      )}
    </section>
  );
}

function CheckoutSelector({
  projectPath,
  worktrees,
  checkoutPath,
  onSelect,
  onCreateWorktree,
}: {
  projectPath: string;
  worktrees: WorktreeInfo[];
  checkoutPath: string;
  onSelect: (path: string) => void;
  onCreateWorktree: () => void;
}) {
  return (
    <Dropdown
      align="left"
      side="top"
      portal
      menuClassName="agent-chat__menu"
      trigger={(triggerProps) => (
        <MenuButton
          ref={triggerProps.ref}
          onClick={triggerProps.onClick}
          expanded={triggerProps['aria-expanded']}
          size="compact"
          variant="ghost"
          className="agent-chat__checkout-trigger"
          leftIcon={<FolderIcon size={14} />}
          rightIcon={<ChevronIcon size={13} />}
          title="Select the checkout for your next conversation."
          aria-label={`Select checkout for a new conversation. Current: ${checkoutLabel(checkoutPath, projectPath, worktrees)}`}
        >
          <span>{checkoutLabel(checkoutPath, projectPath, worktrees)}</span>
        </MenuButton>
      )}
    >
      <DropdownItem
        active={checkoutPath === projectPath}
        onSelect={() => onSelect(projectPath)}
        icon={<FolderIcon size={14} />}
      >
        Current checkout
      </DropdownItem>
      {worktrees
        .filter((worktree) => worktree.path !== projectPath)
        .map((worktree) => (
          <DropdownItem
            key={worktree.path}
            active={checkoutPath === worktree.path}
            onSelect={() => onSelect(worktree.path)}
            icon={<BranchIcon size={14} />}
          >
            {checkoutLabel(worktree.path, projectPath, worktrees)}
          </DropdownItem>
        ))}
      <DropdownDivider />
      <DropdownItem onSelect={onCreateWorktree} icon={<PlusIcon size={14} />}>
        New worktree…
      </DropdownItem>
    </Dropdown>
  );
}

function CheckoutRelinkMenu({
  projectPath,
  worktrees,
  disabled,
  onSelect,
  onCreateWorktree,
}: {
  projectPath: string;
  worktrees: WorktreeInfo[];
  disabled: boolean;
  onSelect: (path: string) => void;
  onCreateWorktree: () => void;
}) {
  const checkoutPaths = [projectPath, ...worktrees.map((worktree) => worktree.path)].filter(
    (path, index, paths) => paths.indexOf(path) === index
  );
  return (
    <Dropdown
      align="left"
      side="bottom"
      portal
      menuClassName="agent-chat__menu"
      trigger={(triggerProps) => (
        <MenuButton
          ref={triggerProps.ref}
          onClick={triggerProps.onClick}
          expanded={triggerProps['aria-expanded']}
          size="compact"
          variant="secondary"
          className="agent-chat__relink-trigger"
          leftIcon={<FolderIcon size={14} />}
          rightIcon={<ChevronIcon size={13} />}
          disabled={disabled}
        >
          {disabled ? 'Relinking…' : 'Relink checkout'}
        </MenuButton>
      )}
    >
      {checkoutPaths.map((path) => (
        <DropdownItem key={path} onSelect={() => onSelect(path)} icon={<FolderIcon size={14} />}>
          {checkoutLabel(path, projectPath, worktrees)}
        </DropdownItem>
      ))}
      <DropdownDivider />
      <DropdownItem onSelect={onCreateWorktree} icon={<PlusIcon size={14} />}>
        Create a worktree…
      </DropdownItem>
    </Dropdown>
  );
}
