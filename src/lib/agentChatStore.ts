/**
 * Process-wide, project-scoped mirror of Codex Chat state.
 *
 * Tauri events are subscribed before the first list call, so a panel can
 * unmount, remount, or change projects without losing activity from another
 * live thread. App-server state lives for this process in Phase 1; the last
 * model and reasoning preference is stored per project for future drafts.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  createAgentChatThreadCommand,
  deleteAgentChatProjectDraftCommand,
  discardAgentChatCommand,
  getAgentChatStorageStatusCommand,
  interruptAgentChatCommand,
  listAgentChatModels,
  listAgentChatDrafts,
  listUnlinkedAgentChatProjectsCommand,
  listAgentChatThreads,
  markAgentChatThreadReadCommand,
  relinkAgentChatCheckoutCommand,
  relinkAgentChatProjectCommand,
  renameAgentChatThreadCommand,
  promoteAgentChatDraftCommand,
  recheckAgentChatAttachmentsCommand,
  reopenAgentChatThreadCommand,
  resumeCheckAgentChatThreadCommand,
  respondAgentChatCommand,
  saveAgentChatDraftCommand,
  saveAgentChatProjectDraftCommand,
  saveAgentChatSettingsCommand,
  settleAgentChatThreadCommand,
  sendAgentChatCommand,
  stageAgentChatAttachmentCommand,
  type ChatAttachment,
  type ChatModel,
  type ChatResponse,
  type ChatStorageStatus,
  type ChatThread,
  type SavedChatDraft,
  type ChatUnlinkedProject,
} from './agentChat';

export interface AgentChatThreadSettings {
  modelId: string | null;
  reasoningEffort: string | null;
  autoAcceptMode?: boolean;
}

interface PendingSend {
  attemptId: string;
  text: string;
  attachmentIds: string[];
  reconciliation?: 'confirmedPresent' | 'confirmedAbsent' | 'ambiguous';
  providerTurnId?: string | null;
}

interface SendSafetyState {
  message: string;
  blockedText: string;
  blockedAttachmentIds: string[];
  reconciled: boolean;
}

interface PersistedLocalState {
  version: 5;
  projectId: string | null;
  selectedThreadId: string | null;
  selectedDraftId: string | null;
  selectedCheckoutPath: string;
  draftCheckoutPaths: Record<string, string>;
  draftThreadIds: Record<string, string>;
  activeDraftIdsByCheckout: Record<string, string>;
  drafts?: Record<string, string>;
  stagedAttachments?: Record<string, ChatAttachment[]>;
  threadSettings?: Record<string, AgentChatThreadSettings>;
  pendingSends: Record<string, PendingSend>;
}

export interface AgentChatProjectSnapshot {
  identityVerified: boolean;
  legacyDraftRecoveryAvailable: boolean;
  threads: ChatThread[];
  savedDrafts: SavedChatDraft[];
  models: ChatModel[];
  selectedThreadId: string | null;
  selectedDraftId: string | null;
  selectedCheckoutPath: string;
  draftCheckoutPaths: Record<string, string>;
  activeDraftIdsByCheckout: Record<string, string>;
  drafts: Record<string, string>;
  stagedAttachments: Record<string, ChatAttachment[]>;
  attachmentAvailability: Record<string, 'checking' | 'unknown'>;
  threadSettings: Record<string, AgentChatThreadSettings>;
  storageStatus: ChatStorageStatus | null;
  unlinkedProjects: ChatUnlinkedProject[];
  threadErrors: Record<string, string>;
  reconciliationRequired: Record<string, string>;
  sendSafety: Record<string, SendSafetyState>;
  sendingThreadIds: string[];
  sendingDraftIds: string[];
  draftPageOffsets: Record<string, number | null>;
  loadingDraftCheckouts: string[];
  draftPageErrors: Record<string, string>;
  draftThreadIds: Record<string, string>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export type AgentChatCaptureTarget =
  | {
      kind: 'thread';
      projectPath: string;
      threadId: string;
      checkoutPath: string;
    }
  | {
      kind: 'draft';
      projectPath: string;
      draftId: string;
      checkoutPath: string;
    };

interface ProjectRecord {
  snapshot: AgentChatProjectSnapshot;
  projectId: string | null;
  listeners: Set<() => void>;
  loadId: number;
  identityVersion: number;
  identityVerified: boolean;
  candidateLocalState: PersistedLocalState | null;
  legacyLocalState: PersistedLocalState | null;
  loadPromise: Promise<void> | null;
  chatVisible: boolean;
  readInFlight: Set<string>;
  discardedThreadIds: Set<string>;
  discardingThreadIds: Set<string>;
  lastThreadSettings: AgentChatThreadSettings | null;
  dirtyDrafts: Set<string>;
  dirtySettings: Set<string>;
  draftSaveTimers: Map<string, number>;
  persistenceQueues: Map<string, Promise<void>>;
  draftVersions: Map<string, number>;
  settingsVersions: Map<string, number>;
  loadedDraftCheckouts: Set<string>;
  draftPageOffsets: Map<string, number | null>;
  draftPageLoads: Map<string, Promise<void>>;
  pendingSends: Record<string, PendingSend>;
}

const projectRecords = new Map<string, ProjectRecord>();
let threadListenerPromise: Promise<UnlistenFn> | null = null;
const recentThreadEvents = new Map<string, Map<string, ChatThread>>();
const LAST_SETTINGS_KEY_PREFIX = 'shipstudio.agentChat.lastSettings:';
const LOCAL_STATE_KEY_PREFIX = 'shipstudio.agentChat.localState:';
const LEGACY_LOCAL_STATE_KEY_PREFIX = 'shipstudio.agentChat.legacyLocalState:';
const ATTACHMENTS_UNAVAILABLE_ERROR =
  'One or more saved attachments are unavailable. Remove them and attach the files again before sending.';
const ATTACHMENTS_CHECKING_ERROR = 'Saved attachment availability is still being checked.';
const ATTACHMENTS_UNKNOWN_ERROR =
  'Saved attachment availability could not be confirmed. Reload the draft before sending.';

function isAttachmentAvailabilityError(message: string | undefined): boolean {
  return (
    message === ATTACHMENTS_UNAVAILABLE_ERROR ||
    message === ATTACHMENTS_CHECKING_ERROR ||
    message === ATTACHMENTS_UNKNOWN_ERROR
  );
}

function localStateKey(projectPath: string): string {
  return `${LOCAL_STATE_KEY_PREFIX}${encodeURIComponent(projectPath)}`;
}

function readPersistedLocalState(projectPath: string): PersistedLocalState | null {
  return readPersistedLocalStateKey(localStateKey(projectPath));
}

function readPersistedLocalStateKey(key: string): PersistedLocalState | null {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (
      !value ||
      typeof value !== 'object' ||
      ![1, 2, 3, 4, 5].includes((value as { version?: number }).version ?? 0)
    )
      return null;
    const state = value as Partial<PersistedLocalState>;
    if (
      typeof state.selectedCheckoutPath !== 'string' ||
      !state.draftCheckoutPaths ||
      !state.activeDraftIdsByCheckout
    ) {
      return null;
    }
    const stagedAttachments = Object.fromEntries(
      Object.entries(state.stagedAttachments ?? {}).map(([draftId, attachments]) => [
        draftId,
        attachments.map((attachment) => ({ ...attachment, available: undefined })),
      ])
    );
    return {
      version: 5,
      projectId: typeof state.projectId === 'string' ? state.projectId : null,
      selectedThreadId: typeof state.selectedThreadId === 'string' ? state.selectedThreadId : null,
      selectedDraftId: typeof state.selectedDraftId === 'string' ? state.selectedDraftId : null,
      selectedCheckoutPath: state.selectedCheckoutPath,
      draftCheckoutPaths: state.draftCheckoutPaths,
      draftThreadIds: state.draftThreadIds ?? {},
      activeDraftIdsByCheckout: state.activeDraftIdsByCheckout,
      drafts: state.drafts ?? {},
      stagedAttachments,
      threadSettings: state.threadSettings ?? {},
      pendingSends: Object.fromEntries(
        Object.entries(state.pendingSends ?? {}).map(([id, pending]) => [
          id,
          {
            ...pending,
            // Earlier local states had no provider-correlatable send ID. Keep
            // them quarantined as ambiguous rather than guessing a match.
            attemptId: pending.attemptId ?? '',
            attachmentIds: pending.attachmentIds ?? [],
          },
        ])
      ),
    };
  } catch {
    return null;
  }
}

function lastSettingsKey(projectPath: string, projectId: string): string {
  return `${LAST_SETTINGS_KEY_PREFIX}${encodeURIComponent(projectPath)}:${encodeURIComponent(projectId)}`;
}

function readLastThreadSettings(
  projectPath: string,
  projectId: string
): AgentChatThreadSettings | null {
  const key = lastSettingsKey(projectPath, projectId);
  let stored: string | null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) return null;
    const settings = value as Record<string, unknown>;
    const hasModelId = settings.modelId === null || typeof settings.modelId === 'string';
    const hasReasoningEffort =
      settings.reasoningEffort === null || typeof settings.reasoningEffort === 'string';
    return hasModelId && hasReasoningEffort
      ? {
          modelId: settings.modelId as string | null,
          reasoningEffort: settings.reasoningEffort as string | null,
          ...(typeof settings.autoAcceptMode === 'boolean'
            ? { autoAcceptMode: settings.autoAcceptMode }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function normalizedThreadSettings(settings: AgentChatThreadSettings): AgentChatThreadSettings {
  return {
    modelId: settings.modelId,
    reasoningEffort: settings.reasoningEffort,
    autoAcceptMode: settings.autoAcceptMode ?? false,
  };
}

function persistLastThreadSettings(
  projectPath: string,
  projectId: string,
  settings: AgentChatThreadSettings
): void {
  try {
    localStorage.setItem(
      lastSettingsKey(projectPath, projectId),
      JSON.stringify(normalizedThreadSettings(settings))
    );
  } catch {
    // The current draft and its backend save remain authoritative if storage is unavailable.
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function normalizePersistedDraftIds(saved: PersistedLocalState | null): PersistedLocalState | null {
  if (!saved) return null;
  const remap = new Map<string, string>();
  Object.keys(saved.draftCheckoutPaths).forEach((draftId) => {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftId);
    remap.set(draftId, isUuid ? draftId : newDraftId());
  });
  if (saved.selectedDraftId && !saved.selectedThreadId && !remap.has(saved.selectedDraftId)) {
    remap.set(saved.selectedDraftId, newDraftId());
  }
  const remapKeys = <T>(source: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(source).map(([id, value]) => [remap.get(id) ?? id, value]));
  return {
    ...saved,
    selectedDraftId: saved.selectedDraftId
      ? (remap.get(saved.selectedDraftId) ?? saved.selectedDraftId)
      : null,
    draftCheckoutPaths: remapKeys(saved.draftCheckoutPaths),
    draftThreadIds: remapKeys(saved.draftThreadIds),
    activeDraftIdsByCheckout: Object.fromEntries(
      Object.entries(saved.activeDraftIdsByCheckout).map(([checkoutPath, id]) => [
        checkoutPath,
        remap.get(id) ?? id,
      ])
    ),
    drafts: remapKeys(saved.drafts ?? {}),
    stagedAttachments: remapKeys(saved.stagedAttachments ?? {}),
    threadSettings: remapKeys(saved.threadSettings ?? {}),
  };
}

function emptySnapshot(
  projectPath: string,
  saved: PersistedLocalState | null = null
): AgentChatProjectSnapshot {
  const draftId = saved?.selectedDraftId ?? newDraftId();
  const stagedAttachments = saved?.stagedAttachments ?? {};
  return {
    identityVerified: false,
    legacyDraftRecoveryAvailable: false,
    threads: [],
    savedDrafts: [],
    models: [],
    selectedThreadId: saved?.selectedThreadId ?? null,
    selectedDraftId: draftId,
    selectedCheckoutPath: saved?.selectedCheckoutPath ?? projectPath,
    draftCheckoutPaths: saved?.draftCheckoutPaths ?? { [draftId]: projectPath },
    draftThreadIds: saved?.draftThreadIds ?? {},
    activeDraftIdsByCheckout: saved?.activeDraftIdsByCheckout ?? { [projectPath]: draftId },
    drafts: saved?.drafts ?? {},
    stagedAttachments,
    attachmentAvailability: Object.fromEntries(
      Object.entries(stagedAttachments)
        .filter(([, attachments]) => attachments.length > 0)
        .map(([id]) => [id, 'checking' as const])
    ),
    threadSettings: saved?.threadSettings ?? {},
    storageStatus: null,
    unlinkedProjects: [],
    threadErrors: {},
    reconciliationRequired: Object.fromEntries(
      Object.entries(saved?.pendingSends ?? {})
        .filter(([, pending]) => pending.reconciliation !== 'confirmedPresent')
        .map(([id]) => [
          id,
          'The previous send to this conversation was interrupted before its result was saved. Check Codex history before sending again.',
        ])
    ),
    sendSafety: Object.fromEntries(
      Object.entries(saved?.pendingSends ?? {}).map(([id, pending]) => [
        id,
        {
          message:
            pending.reconciliation === 'confirmedPresent'
              ? pending.attachmentIds.length > 0
                ? 'Codex history confirms this prompt text was accepted. It cannot confirm whether the attachments were accepted; edit the prompt or attachment selection before sending again.'
                : 'Codex history confirms this prompt was accepted. Edit it before sending again to avoid a duplicate.'
              : 'This send did not finish before Ship Studio closed. Check Codex history before sending again.',
          blockedText: pending.text,
          blockedAttachmentIds: pending.attachmentIds,
          reconciled: pending.reconciliation === 'confirmedPresent',
        },
      ])
    ),
    sendingThreadIds: [],
    sendingDraftIds: [],
    draftPageOffsets: {},
    loadingDraftCheckouts: [],
    draftPageErrors: {},
    loading: false,
    loaded: false,
    error: null,
  };
}

function ensureRecord(projectPath: string): ProjectRecord {
  let record = projectRecords.get(projectPath);
  if (!record) {
    const saved = normalizePersistedDraftIds(readPersistedLocalState(projectPath));
    const savedLegacy = normalizePersistedDraftIds(
      readPersistedLocalStateKey(legacyLocalStateKey(projectPath))
    );
    const snapshot = emptySnapshot(projectPath);
    record = {
      snapshot,
      projectId: saved?.projectId ?? null,
      listeners: new Set(),
      loadId: 0,
      identityVersion: 0,
      identityVerified: false,
      candidateLocalState: saved,
      legacyLocalState: savedLegacy,
      loadPromise: null,
      chatVisible: false,
      readInFlight: new Set(),
      discardedThreadIds: new Set(),
      discardingThreadIds: new Set(),
      lastThreadSettings: null,
      dirtyDrafts: new Set(),
      dirtySettings: new Set(),
      draftSaveTimers: new Map(),
      persistenceQueues: new Map(),
      draftVersions: new Map(),
      settingsVersions: new Map(),
      loadedDraftCheckouts: new Set(),
      draftPageOffsets: new Map(),
      draftPageLoads: new Map(),
      pendingSends: {},
    };
    projectRecords.set(projectPath, record);
  }
  return record;
}

function resetProjectIdentity(projectPath: string, record: ProjectRecord, projectId: string): void {
  const { storageStatus, unlinkedProjects } = record.snapshot;
  const previousProjectId = record.projectId;
  record.draftSaveTimers.forEach((timer) => window.clearTimeout(timer));
  record.draftSaveTimers.clear();
  try {
    localStorage.removeItem(localStateKey(projectPath));
    if (previousProjectId) {
      localStorage.removeItem(lastSettingsKey(projectPath, previousProjectId));
    }
  } catch {
    // The in-memory snapshot is still reset if local storage cannot be updated.
  }
  record.projectId = projectId;
  record.identityVerified = false;
  record.candidateLocalState = null;
  record.identityVersion += 1;
  record.lastThreadSettings = null;
  record.pendingSends = {};
  record.dirtyDrafts.clear();
  record.dirtySettings.clear();
  record.persistenceQueues.clear();
  record.draftVersions.clear();
  record.settingsVersions.clear();
  record.loadedDraftCheckouts.clear();
  record.draftPageOffsets.clear();
  record.draftPageLoads.clear();
  record.readInFlight.clear();
  record.discardedThreadIds.clear();
  record.discardingThreadIds.clear();
  record.snapshot = {
    ...emptySnapshot(projectPath),
    storageStatus,
    unlinkedProjects,
  };
  record.listeners.forEach((listener) => listener());
}

function legacyLocalStateKey(projectPath: string): string {
  return `${LEGACY_LOCAL_STATE_KEY_PREFIX}${encodeURIComponent(projectPath)}`;
}

function hasLocalComposerState(saved: PersistedLocalState): boolean {
  return (
    Object.values(saved.drafts ?? {}).some((draft) => draft.length > 0) ||
    Object.values(saved.stagedAttachments ?? {}).some((attachments) => attachments.length > 0)
  );
}

function restoreVerifiedLocalState(
  projectPath: string,
  record: ProjectRecord,
  saved: PersistedLocalState
): void {
  record.pendingSends = saved.pendingSends ?? {};
  record.dirtyDrafts = new Set(Object.keys(saved.drafts ?? {}));
  record.dirtySettings = new Set(Object.keys(saved.threadSettings ?? {}));
  record.lastThreadSettings = record.projectId
    ? readLastThreadSettings(projectPath, record.projectId)
    : null;
  const current = record.snapshot;
  record.snapshot = {
    ...emptySnapshot(projectPath, saved),
    identityVerified: true,
    models: current.models,
    storageStatus: current.storageStatus,
    unlinkedProjects: current.unlinkedProjects,
    loading: current.loading,
    loaded: current.loaded,
    error: current.error,
  };
  record.listeners.forEach((listener) => listener());
}

function quarantineLegacyLocalState(
  projectPath: string,
  record: ProjectRecord,
  saved: PersistedLocalState
): void {
  record.legacyLocalState = saved;
  try {
    localStorage.setItem(legacyLocalStateKey(projectPath), JSON.stringify(saved));
    localStorage.removeItem(localStateKey(projectPath));
  } catch {
    // Keep the source and in-memory copy if durable quarantine is unavailable.
  }
  record.snapshot = {
    ...record.snapshot,
    identityVerified: true,
    legacyDraftRecoveryAvailable: hasLocalComposerState(saved),
  };
}

/** Copy quarantined composer content into new drafts only after identity verification. */
export function recoverLegacyAgentChatDrafts(projectPath: string): string[] {
  const record = ensureRecord(projectPath);
  const legacy = record.legacyLocalState;
  if (!record.identityVerified || !record.projectId || !legacy) return [];

  const sourceIds = [
    ...new Set([
      ...Object.keys(legacy.drafts ?? {}),
      ...Object.keys(legacy.stagedAttachments ?? {}),
    ]),
  ].filter(
    (sourceId) =>
      (legacy.drafts?.[sourceId] ?? '').length > 0 ||
      (legacy.stagedAttachments?.[sourceId] ?? []).length > 0
  );
  if (sourceIds.length === 0) return [];

  const snapshot = record.snapshot;
  const ids = sourceIds.map(() => newDraftId());
  const drafts = { ...snapshot.drafts };
  const stagedAttachments = { ...snapshot.stagedAttachments };
  const threadSettings = { ...snapshot.threadSettings };
  const draftCheckoutPaths = { ...snapshot.draftCheckoutPaths };
  const activeDraftIdsByCheckout = { ...snapshot.activeDraftIdsByCheckout };
  sourceIds.forEach((sourceId, index) => {
    const draftId = ids[index];
    drafts[draftId] = legacy.drafts?.[sourceId] ?? '';
    stagedAttachments[draftId] = (legacy.stagedAttachments?.[sourceId] ?? []).map((attachment) => ({
      ...attachment,
      available: undefined,
    }));
    threadSettings[draftId] =
      legacy.threadSettings?.[sourceId] ?? defaultThreadSettings(snapshot.models);
    draftCheckoutPaths[draftId] = projectPath;
    record.dirtyDrafts.add(draftId);
    record.dirtySettings.add(draftId);
    record.draftVersions.set(draftId, 1);
    record.settingsVersions.set(draftId, 1);
  });
  activeDraftIdsByCheckout[projectPath] = ids[0];
  record.legacyLocalState = null;
  try {
    localStorage.removeItem(legacyLocalStateKey(projectPath));
  } catch {
    // The recovered composer remains available in memory for this session.
  }
  record.snapshot = {
    ...snapshot,
    selectedThreadId: null,
    selectedDraftId: ids[0],
    selectedCheckoutPath: projectPath,
    legacyDraftRecoveryAvailable: false,
    drafts,
    stagedAttachments,
    threadSettings,
    draftCheckoutPaths,
    activeDraftIdsByCheckout,
  };
  record.listeners.forEach((listener) => listener());
  void reconcileRestoredAttachmentAvailability(projectPath);
  ids.forEach((draftId) => void saveProjectDraftNow(projectPath, draftId).catch(() => undefined));
  persistLocalState(projectPath);
  return ids;
}

function persistLocalState(projectPath: string): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  const snapshot = record.snapshot;
  const unsavedDrafts: Record<string, string> = {};
  const unsavedAttachments: Record<string, ChatAttachment[]> = {};
  const unsavedSettings: Record<string, AgentChatThreadSettings> = {};
  record.dirtyDrafts.forEach((draftId) => {
    const draft = snapshot.drafts[draftId];
    const attachments = snapshot.stagedAttachments[draftId];
    if (draft !== undefined) unsavedDrafts[draftId] = draft;
    if (attachments !== undefined) unsavedAttachments[draftId] = attachments;
  });
  record.dirtySettings.forEach((draftId) => {
    const settings = snapshot.threadSettings[draftId];
    if (settings !== undefined) unsavedSettings[draftId] = settings;
  });
  const hasUnsavedComposerState =
    Object.keys(unsavedDrafts).length > 0 ||
    Object.keys(unsavedAttachments).length > 0 ||
    Object.keys(unsavedSettings).length > 0;
  try {
    localStorage.setItem(
      localStateKey(projectPath),
      JSON.stringify({
        version: 5,
        projectId: record.projectId,
        selectedThreadId: snapshot.selectedThreadId,
        selectedDraftId: snapshot.selectedDraftId ?? snapshot.activeDraftIdsByCheckout[projectPath],
        selectedCheckoutPath: snapshot.selectedCheckoutPath,
        draftCheckoutPaths: snapshot.draftCheckoutPaths,
        draftThreadIds: snapshot.draftThreadIds,
        activeDraftIdsByCheckout: snapshot.activeDraftIdsByCheckout,
        ...(hasUnsavedComposerState
          ? {
              ...(Object.keys(unsavedDrafts).length > 0 ? { drafts: unsavedDrafts } : {}),
              ...(Object.keys(unsavedAttachments).length > 0
                ? { stagedAttachments: unsavedAttachments }
                : {}),
              ...(Object.keys(unsavedSettings).length > 0
                ? { threadSettings: unsavedSettings }
                : {}),
            }
          : {}),
        pendingSends: record.pendingSends,
      } satisfies PersistedLocalState)
    );
  } catch {
    publish(projectPath, (current) => ({
      ...current,
      error:
        'This draft could not be saved on this device. Keep this window open and copy your text before closing.',
    }));
  }
}

function publish(
  projectPath: string,
  update: (snapshot: AgentChatProjectSnapshot) => AgentChatProjectSnapshot
) {
  const record = ensureRecord(projectPath);
  const next = update(record.snapshot);
  if (next === record.snapshot) return;
  record.snapshot = next;
  record.listeners.forEach((listener) => listener());
}

function clearThreadError(
  errors: Record<string, string>,
  threadId: string
): Record<string, string> {
  if (!(threadId in errors)) return errors;
  const next = { ...errors };
  delete next[threadId];
  return next;
}

export function getAgentChatSnapshot(projectPath: string): AgentChatProjectSnapshot {
  return ensureRecord(projectPath).snapshot;
}

export function subscribeAgentChat(projectPath: string, listener: () => void): () => void {
  const listeners = ensureRecord(projectPath).listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Keep inbox cursors current only while the Chat surface is visible. */
export function setAgentChatPanelVisible(projectPath: string, visible: boolean): void {
  const record = ensureRecord(projectPath);
  record.chatVisible = visible;
  if (!visible) return;
  const snapshot = record.snapshot;
  const selected = snapshot.threads.find((thread) => thread.id === snapshot.selectedThreadId);
  if (selected?.unread) void markAgentChatThreadRead(projectPath, selected.id);
}

function mergeThread(projectPath: string, thread: ChatThread, forceDraft = false): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || record.projectId !== thread.projectId) return;
  if (record.discardedThreadIds.has(thread.id) || record.discardingThreadIds.has(thread.id)) return;

  publish(projectPath, (snapshot) => {
    const index = snapshot.threads.findIndex((candidate) => candidate.id === thread.id);
    if (index >= 0 && snapshot.threads[index].revision >= thread.revision) return snapshot;

    const threads = [...snapshot.threads];
    if (index >= 0) threads[index] = thread;
    else threads.push(thread);

    const selectedThreadId =
      snapshot.selectedThreadId ??
      (snapshot.selectedDraftId || thread.status === 'closed' ? null : thread.id);
    const draftMatches =
      snapshot.drafts[thread.id] === (thread.draft?.text ?? '') &&
      JSON.stringify(snapshot.stagedAttachments[thread.id] ?? []) ===
        JSON.stringify(thread.draft?.attachments ?? []);
    if (draftMatches) record.dirtyDrafts.delete(thread.id);
    const sendInFlight = Boolean(record.pendingSends[thread.id]);
    // Save acknowledgements can clear dirty state before a send resolves; keep
    // the current composer until that send's own response reconciles it.
    const keepLocalDraft = !forceDraft && (record.dirtyDrafts.has(thread.id) || sendInFlight);
    const drafts = keepLocalDraft
      ? snapshot.drafts
      : { ...snapshot.drafts, [thread.id]: thread.draft?.text ?? '' };
    const stagedAttachments = keepLocalDraft
      ? snapshot.stagedAttachments
      : { ...snapshot.stagedAttachments, [thread.id]: thread.draft?.attachments ?? [] };
    const localSettings = snapshot.threadSettings[thread.id];
    const settingsMatch =
      localSettings?.modelId === (thread.settings?.modelId ?? null) &&
      localSettings?.reasoningEffort === (thread.settings?.reasoningEffort ?? null) &&
      localSettings?.autoAcceptMode === (thread.settings?.autoAcceptMode ?? false);
    if (settingsMatch) record.dirtySettings.delete(thread.id);
    const keepLocalSettings = record.dirtySettings.has(thread.id) || sendInFlight;
    const threadSettings = keepLocalSettings
      ? snapshot.threadSettings
      : {
          ...snapshot.threadSettings,
          [thread.id]: {
            modelId: thread.settings?.modelId ?? null,
            reasoningEffort: thread.settings?.reasoningEffort ?? null,
            autoAcceptMode: thread.settings?.autoAcceptMode ?? false,
          },
        };

    return {
      ...snapshot,
      threads,
      selectedThreadId,
      drafts,
      stagedAttachments,
      threadSettings,
    };
  });
  const current = getAgentChatSnapshot(projectPath).threads.find(
    (candidate) => candidate.id === thread.id
  );
  if (
    current?.unread &&
    record.chatVisible &&
    getAgentChatSnapshot(projectPath).selectedThreadId === thread.id
  ) {
    void markAgentChatThreadRead(projectPath, thread.id);
  }
  void reconcileRestoredAttachmentAvailability(projectPath, false);
}

function sameAttachmentSource(left: ChatAttachment, right: ChatAttachment): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.path === right.path &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.kind === right.kind
  );
}

function attachmentOwnerSnapshot(
  snapshot: AgentChatProjectSnapshot,
  draftOrThreadId: string
): ChatAttachment[] {
  const thread = snapshot.threads.find((candidate) => candidate.id === draftOrThreadId);
  const savedDraft = snapshot.savedDrafts.find(
    (candidate) => candidate.draftId === draftOrThreadId
  );
  const promotedThreadId =
    snapshot.draftThreadIds[draftOrThreadId] ?? savedDraft?.promotedThreadId ?? null;
  if (thread) {
    return [...thread.draft.attachments, ...thread.items.flatMap((item) => item.attachments)];
  }
  if (promotedThreadId) {
    const promotedThread = snapshot.threads.find((candidate) => candidate.id === promotedThreadId);
    return promotedThread
      ? [
          ...promotedThread.draft.attachments,
          ...promotedThread.items.flatMap((item) => item.attachments),
        ]
      : [];
  }
  return savedDraft?.draft.attachments ?? [];
}

/**
 * Local storage keeps attachment descriptors for unsaved edits, but its cached
 * availability is not evidence that the app-owned bytes still exist. Refresh
 * only the availability bit from an exact saved owner or validated recheck.
 */
function applyAttachmentAvailability(
  projectPath: string,
  checkedAttachments: ChatAttachment[],
  unresolvedState: 'checking' | 'unknown'
): ChatAttachment[] {
  const snapshot = getAgentChatSnapshot(projectPath);
  const checkedByDescriptor = checkedAttachments.filter(
    (attachment) => typeof attachment.available === 'boolean'
  );
  let changed = false;
  let attachmentValuesChanged = false;
  const stagedAttachments = { ...snapshot.stagedAttachments };
  const attachmentAvailability = { ...snapshot.attachmentAvailability };
  const unresolved: ChatAttachment[] = [];
  const threadErrors = { ...snapshot.threadErrors };

  for (const [draftOrThreadId, attachments] of Object.entries(snapshot.stagedAttachments)) {
    const owners = attachmentOwnerSnapshot(snapshot, draftOrThreadId);
    const nextAttachments = attachments.map((attachment) => {
      const owner = owners.find((candidate) => sameAttachmentSource(candidate, attachment));
      const checked = checkedByDescriptor.find((candidate) =>
        sameAttachmentSource(candidate, attachment)
      );
      const knownAvailability =
        typeof owner?.available === 'boolean'
          ? owner.available
          : typeof checked?.available === 'boolean'
            ? checked.available
            : attachment.available;
      if (typeof knownAvailability !== 'boolean') unresolved.push(attachment);
      if (attachment.available === knownAvailability) return attachment;
      changed = true;
      attachmentValuesChanged = true;
      return { ...attachment, available: knownAvailability };
    });
    stagedAttachments[draftOrThreadId] = nextAttachments;

    if (
      nextAttachments.length === 0 ||
      nextAttachments.every((attachment) => typeof attachment.available === 'boolean')
    ) {
      delete attachmentAvailability[draftOrThreadId];
      if (nextAttachments.every((attachment) => attachment.available === true)) {
        if (isAttachmentAvailabilityError(threadErrors[draftOrThreadId])) {
          delete threadErrors[draftOrThreadId];
          changed = true;
        }
      }
    } else if (attachmentAvailability[draftOrThreadId] !== unresolvedState) {
      attachmentAvailability[draftOrThreadId] = unresolvedState;
      changed = true;
    }
  }

  for (const id of Object.keys(attachmentAvailability)) {
    if (!(id in snapshot.stagedAttachments)) {
      delete attachmentAvailability[id];
      changed = true;
    }
  }

  if (changed || attachmentValuesChanged) {
    publish(projectPath, (current) => ({
      ...current,
      stagedAttachments,
      attachmentAvailability,
      threadErrors,
    }));
    if (attachmentValuesChanged) persistLocalState(projectPath);
  }

  return unresolved;
}

async function reconcileRestoredAttachmentAvailability(
  projectPath: string,
  recheckUnowned = true
): Promise<void> {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  const identityVersion = record.identityVersion;
  const projectId = record.projectId;
  const unresolved = applyAttachmentAvailability(projectPath, [], 'checking');
  if (!recheckUnowned || unresolved.length === 0) return;

  try {
    const checked = await recheckAgentChatAttachmentsCommand(projectPath, unresolved);
    if (
      record.identityVersion !== identityVersion ||
      !record.identityVerified ||
      record.projectId !== projectId
    )
      return;
    applyAttachmentAvailability(projectPath, checked, 'unknown');
  } catch {
    if (record.identityVersion !== identityVersion) return;
    // Older native builds may not expose recheck yet. Keep these descriptors
    // unknown and gated; a saved-draft owner can still confirm them afterward.
    applyAttachmentAvailability(projectPath, [], 'unknown');
  }
}

function defaultThreadSettings(models: ChatModel[]): AgentChatThreadSettings {
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  return {
    modelId: model?.id ?? null,
    reasoningEffort: model?.defaultReasoningEffort ?? null,
  };
}

function initialThreadSettings(projectPath: string, models: ChatModel[]): AgentChatThreadSettings {
  return ensureRecord(projectPath).lastThreadSettings ?? defaultThreadSettings(models);
}

function rememberThreadEvent(thread: ChatThread): void {
  if (!thread.projectId) return;
  let projectEvents = recentThreadEvents.get(thread.projectId);
  if (!projectEvents) {
    projectEvents = new Map();
    recentThreadEvents.set(thread.projectId, projectEvents);
  }
  const previous = projectEvents.get(thread.id);
  if (!previous || thread.revision > previous.revision) projectEvents.set(thread.id, thread);
  while (projectEvents.size > 128) {
    const oldestId = projectEvents.keys().next().value;
    if (!oldestId) break;
    projectEvents.delete(oldestId);
  }
}

function replayRecentThreadEvents(projectPath: string, projectId: string): void {
  recentThreadEvents.get(projectId)?.forEach((thread) => mergeThread(projectPath, thread));
}

async function ensureThreadListener(): Promise<void> {
  if (!threadListenerPromise) {
    threadListenerPromise = listen<ChatThread>('agent-chat://thread', (event) => {
      const thread = event.payload;
      if (!thread?.projectPath || !thread.id || !Number.isFinite(thread.revision)) return;
      rememberThreadEvent(thread);
      const matchingProjects = [...projectRecords.entries()]
        .filter(([, record]) => record.identityVerified && record.projectId === thread.projectId)
        .map(([projectPath]) => projectPath);
      matchingProjects.forEach((projectPath) => mergeThread(projectPath, thread));
    }).catch((error: unknown) => {
      threadListenerPromise = null;
      throw error;
    });
  }
  await threadListenerPromise;
}

/** Attach the process-wide event listener first, then reconcile thread/model snapshots. */
export function loadAgentChatProject(projectPath: string, force = false): Promise<void> {
  const record = ensureRecord(projectPath);
  if (!force && record.snapshot.loaded) return Promise.resolve();
  if (!force && record.loadPromise) return record.loadPromise;

  const loadId = ++record.loadId;
  publish(projectPath, (snapshot) => ({ ...snapshot, loading: true, error: null }));
  const loadPromise = (async () => {
    try {
      await ensureThreadListener();
      const [threadsResult, modelsResult, storageResult, unlinkedResult] = await Promise.allSettled(
        [
          listAgentChatThreads(projectPath),
          listAgentChatModels(projectPath),
          getAgentChatStorageStatusCommand(),
          listUnlinkedAgentChatProjectsCommand(),
        ]
      );
      if (record.loadId !== loadId) return;

      if (storageResult.status === 'fulfilled') {
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          storageStatus: storageResult.value,
          error: storageResult.value.available
            ? snapshot.error
            : (storageResult.value.error ?? 'Agent Chat storage is unavailable.'),
        }));
      } else {
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          error:
            snapshot.error ?? `Storage status is unavailable: ${messageOf(storageResult.reason)}`,
        }));
      }
      if (unlinkedResult.status === 'fulfilled') {
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          unlinkedProjects: unlinkedResult.value,
        }));
      } else {
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          error:
            snapshot.error ??
            `Saved project links are unavailable: ${messageOf(unlinkedResult.reason)}`,
        }));
      }

      if (threadsResult.status === 'rejected') {
        throw threadsResult.reason;
      }

      const listedProjectId = threadsResult.value.projectId;
      if (!listedProjectId) {
        throw new Error('Agent Chat did not return a project identity. Drafts remain locked.');
      }
      const candidateBeforeIdentityChange = record.candidateLocalState;
      const identityChanged = Boolean(
        listedProjectId && record.projectId && listedProjectId !== record.projectId
      );
      if (listedProjectId && identityChanged) {
        resetProjectIdentity(projectPath, record, listedProjectId);
        if (candidateBeforeIdentityChange && hasLocalComposerState(candidateBeforeIdentityChange)) {
          quarantineLegacyLocalState(projectPath, record, candidateBeforeIdentityChange);
        }
      }
      if (!record.identityVerified) {
        const candidate = record.candidateLocalState;
        record.projectId = listedProjectId;
        record.identityVerified = true;
        record.identityVersion += 1;
        record.candidateLocalState = null;
        if (candidate?.projectId === listedProjectId) {
          restoreVerifiedLocalState(projectPath, record, candidate);
        } else {
          if (candidate && candidate.projectId == null && hasLocalComposerState(candidate)) {
            quarantineLegacyLocalState(projectPath, record, candidate);
          } else {
            if (candidate?.projectId) {
              try {
                localStorage.removeItem(localStateKey(projectPath));
                localStorage.removeItem(lastSettingsKey(projectPath, candidate.projectId));
              } catch {
                // The active snapshot below is still isolated in memory.
              }
            }
            record.snapshot = { ...record.snapshot, identityVerified: true };
          }
          if (record.legacyLocalState) {
            record.snapshot = {
              ...record.snapshot,
              legacyDraftRecoveryAvailable: hasLocalComposerState(record.legacyLocalState),
            };
          }
        }
      } else if (record.projectId !== listedProjectId) {
        resetProjectIdentity(projectPath, record, listedProjectId);
        record.identityVerified = true;
        record.snapshot = { ...record.snapshot, identityVerified: true };
      }
      if (record.legacyLocalState && hasLocalComposerState(record.legacyLocalState)) {
        record.snapshot = { ...record.snapshot, legacyDraftRecoveryAvailable: true };
      }
      for (const thread of threadsResult.value.threads) mergeThread(projectPath, thread);
      if (record.projectId) replayRecentThreadEvents(projectPath, record.projectId);
      void reconcileRestoredAttachmentAvailability(projectPath, false);

      if (modelsResult.status === 'fulfilled') {
        publish(projectPath, (snapshot) => {
          const threadSettings = { ...snapshot.threadSettings };
          Object.keys(snapshot.draftCheckoutPaths).forEach((draftId) => {
            if (!threadSettings[draftId]) {
              threadSettings[draftId] = initialThreadSettings(projectPath, modelsResult.value);
            }
          });
          return {
            ...snapshot,
            models: modelsResult.value,
            threadSettings,
            loaded: true,
            loading: false,
            error: snapshot.error,
          };
        });
      } else {
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          loaded: false,
          loading: false,
          error: snapshot.error ?? `Models are unavailable: ${messageOf(modelsResult.reason)}`,
        }));
      }

      publish(projectPath, (snapshot) => {
        if (
          snapshot.selectedThreadId &&
          snapshot.threads.some((thread) => thread.id === snapshot.selectedThreadId)
        ) {
          return snapshot;
        }
        const selectedDraftId = snapshot.selectedDraftId;
        const draftHasContent = Boolean(
          selectedDraftId &&
          ((snapshot.drafts[selectedDraftId] ?? '').length > 0 ||
            (snapshot.stagedAttachments[selectedDraftId] ?? []).length > 0)
        );
        if (draftHasContent) {
          return snapshot.selectedThreadId === null
            ? snapshot
            : { ...snapshot, selectedThreadId: null };
        }
        const firstOpenThread = snapshot.threads.find(
          (thread) => thread.disposition === 'active' && thread.status !== 'closed'
        );
        const nextThread = firstOpenThread ?? snapshot.threads[0];
        if (!nextThread) return snapshot;
        return {
          ...snapshot,
          selectedThreadId: nextThread.id,
          selectedDraftId: null,
          selectedCheckoutPath: nextThread.checkoutPath,
        };
      });
      await loadAgentChatDrafts(projectPath, record.snapshot.selectedCheckoutPath);
      record.dirtyDrafts.forEach((threadId) => {
        if (record.snapshot.threads.some((thread) => thread.id === threadId)) {
          queueDraftSave(projectPath, threadId);
        }
      });
      record.dirtySettings.forEach((threadId) => {
        if (record.snapshot.threads.some((thread) => thread.id === threadId)) {
          void queueSettingsSave(projectPath, threadId).catch(() => undefined);
        }
      });
      persistLocalState(projectPath);
    } catch (error) {
      if (record.loadId !== loadId) return;
      applyAttachmentAvailability(projectPath, [], 'unknown');
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        loading: false,
        loaded: false,
        error: messageOf(error),
      }));
    } finally {
      if (record.loadId === loadId) record.loadPromise = null;
    }
  })();
  record.loadPromise = loadPromise;
  return loadPromise;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftSettingsFor(
  projectPath: string,
  draftId: string,
  snapshot = getAgentChatSnapshot(projectPath)
): SavedChatDraft['settings'] {
  const settings = snapshot.threadSettings[draftId] ?? defaultThreadSettings(snapshot.models);
  return {
    modelId: settings.modelId,
    reasoningEffort: settings.reasoningEffort,
    autoAcceptMode: settings.autoAcceptMode ?? false,
  };
}

function mergeSavedDraft(projectPath: string, savedDraft: SavedChatDraft): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || savedDraft.projectId !== record.projectId) return;
  const snapshot = record.snapshot;
  if (
    savedDraft.state === 'draft' &&
    snapshot.selectedDraftId === savedDraft.draftId &&
    !record.dirtySettings.has(savedDraft.draftId)
  ) {
    record.lastThreadSettings = normalizedThreadSettings(savedDraft.settings);
    persistLastThreadSettings(projectPath, record.projectId, record.lastThreadSettings);
  }
  publish(projectPath, (snapshot) => {
    const savedDrafts = [
      ...snapshot.savedDrafts.filter((draft) => draft.draftId !== savedDraft.draftId),
      savedDraft,
    ].sort((left, right) => right.savedAt - left.savedAt);
    const draftCheckoutPaths = {
      ...snapshot.draftCheckoutPaths,
      [savedDraft.draftId]: savedDraft.checkoutPath,
    };
    if (savedDraft.state === 'promoted') {
      const promotedThreadId = savedDraft.promotedThreadId;
      const wasSelected = snapshot.selectedDraftId === savedDraft.draftId;
      return {
        ...snapshot,
        savedDrafts,
        draftCheckoutPaths,
        draftThreadIds: promotedThreadId
          ? { ...snapshot.draftThreadIds, [savedDraft.draftId]: promotedThreadId }
          : snapshot.draftThreadIds,
        selectedThreadId:
          wasSelected && promotedThreadId ? promotedThreadId : snapshot.selectedThreadId,
        selectedDraftId: wasSelected && promotedThreadId ? null : snapshot.selectedDraftId,
        selectedCheckoutPath: wasSelected ? savedDraft.checkoutPath : snapshot.selectedCheckoutPath,
      };
    }

    const keepLocalDraft = record.dirtyDrafts.has(savedDraft.draftId);
    const keepLocalSettings = record.dirtySettings.has(savedDraft.draftId);
    const drafts = keepLocalDraft
      ? snapshot.drafts
      : { ...snapshot.drafts, [savedDraft.draftId]: savedDraft.draft.text };
    const stagedAttachments = keepLocalDraft
      ? snapshot.stagedAttachments
      : { ...snapshot.stagedAttachments, [savedDraft.draftId]: savedDraft.draft.attachments };
    const threadSettings = keepLocalSettings
      ? snapshot.threadSettings
      : {
          ...snapshot.threadSettings,
          [savedDraft.draftId]: { ...savedDraft.settings },
        };
    const activeDraftIdsByCheckout = snapshot.activeDraftIdsByCheckout[savedDraft.checkoutPath]
      ? snapshot.activeDraftIdsByCheckout
      : { ...snapshot.activeDraftIdsByCheckout, [savedDraft.checkoutPath]: savedDraft.draftId };
    return {
      ...snapshot,
      savedDrafts,
      draftCheckoutPaths,
      drafts,
      stagedAttachments,
      threadSettings,
      activeDraftIdsByCheckout,
    };
  });
  void reconcileRestoredAttachmentAvailability(projectPath, false);
}

/** Load one bounded page of provider-free drafts for an exact current checkout. */
export function loadAgentChatDrafts(
  projectPath: string,
  checkoutPath: string,
  loadMore = false
): Promise<void> {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return Promise.resolve();
  const existingLoad = record.draftPageLoads.get(checkoutPath);
  if (existingLoad) return existingLoad;
  if (!loadMore && record.loadedDraftCheckouts.has(checkoutPath)) return Promise.resolve();
  const offset = loadMore ? (record.draftPageOffsets.get(checkoutPath) ?? null) : 0;
  if (offset === null) return Promise.resolve();
  const identityVersion = record.identityVersion;
  const projectId = record.projectId;

  publish(projectPath, (snapshot) => ({
    ...snapshot,
    loadingDraftCheckouts: snapshot.loadingDraftCheckouts.includes(checkoutPath)
      ? snapshot.loadingDraftCheckouts
      : [...snapshot.loadingDraftCheckouts, checkoutPath],
    draftPageErrors: Object.fromEntries(
      Object.entries(snapshot.draftPageErrors).filter(([path]) => path !== checkoutPath)
    ),
  }));

  const loading = (async () => {
    try {
      const page = await listAgentChatDrafts(projectPath, projectId, checkoutPath, 50, offset);
      if (
        record.identityVersion !== identityVersion ||
        !record.identityVerified ||
        record.projectId !== projectId
      )
        return;
      page.drafts.forEach((draft) => mergeSavedDraft(projectPath, draft));
      await reconcileRestoredAttachmentAvailability(projectPath);
      record.loadedDraftCheckouts.add(checkoutPath);
      record.draftPageOffsets.set(checkoutPath, page.nextOffset);
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        draftPageOffsets: { ...snapshot.draftPageOffsets, [checkoutPath]: page.nextOffset },
      }));

      const current = getAgentChatSnapshot(projectPath);
      const knownIds = new Set(current.savedDrafts.map((draft) => draft.draftId));
      const localDraftIds = Object.keys(current.draftCheckoutPaths).filter(
        (draftId) =>
          current.draftCheckoutPaths[draftId] === checkoutPath &&
          !current.draftThreadIds[draftId] &&
          !knownIds.has(draftId) &&
          (record.dirtyDrafts.has(draftId) || record.dirtySettings.has(draftId))
      );
      if (
        current.selectedDraftId &&
        current.selectedCheckoutPath === checkoutPath &&
        !current.draftThreadIds[current.selectedDraftId] &&
        !knownIds.has(current.selectedDraftId) &&
        (record.dirtyDrafts.has(current.selectedDraftId) ||
          record.dirtySettings.has(current.selectedDraftId)) &&
        !localDraftIds.includes(current.selectedDraftId)
      ) {
        localDraftIds.push(current.selectedDraftId);
      }
      localDraftIds.forEach((draftId) => {
        record.dirtyDrafts.add(draftId);
        record.dirtySettings.add(draftId);
        void saveProjectDraftNow(projectPath, draftId).catch(() => undefined);
      });
      persistLocalState(projectPath);
    } catch (error) {
      if (record.identityVersion !== identityVersion) return;
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        draftPageErrors: {
          ...snapshot.draftPageErrors,
          [checkoutPath]: `Saved drafts could not be loaded: ${messageOf(error)}`,
        },
      }));
      await reconcileRestoredAttachmentAvailability(projectPath);
    } finally {
      if (record.identityVersion === identityVersion) {
        record.draftPageLoads.delete(checkoutPath);
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          loadingDraftCheckouts: snapshot.loadingDraftCheckouts.filter(
            (path) => path !== checkoutPath
          ),
        }));
      }
    }
  })();
  record.draftPageLoads.set(checkoutPath, loading);
  return loading;
}

export function loadMoreAgentChatDrafts(projectPath: string, checkoutPath: string): Promise<void> {
  return loadAgentChatDrafts(projectPath, checkoutPath, true);
}

function enqueuePersistence<T>(
  projectPath: string,
  threadId: string,
  operation: () => Promise<T>
): Promise<T> {
  const record = ensureRecord(projectPath);
  const previous = record.persistenceQueues.get(threadId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const marker = next.then(
    () => undefined,
    () => undefined
  );
  record.persistenceQueues.set(threadId, marker);
  const cleanup = () => {
    if (record.persistenceQueues.get(threadId) === marker) {
      record.persistenceQueues.delete(threadId);
    }
  };
  void marker.then(cleanup);
  return next;
}

function queueDraftSave(projectPath: string, threadId: string): void {
  const record = ensureRecord(projectPath);
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
  const existing = record.draftSaveTimers.get(threadId);
  if (existing !== undefined) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    record.draftSaveTimers.delete(threadId);
    const boundThreadId = getAgentChatSnapshot(projectPath).draftThreadIds[threadId];
    const thread = record.snapshot.threads.find((candidate) => candidate.id === threadId);
    const save = thread
      ? saveThreadDraftNow(projectPath, threadId)
      : boundThreadId
        ? saveThreadDraftNow(projectPath, boundThreadId)
        : saveProjectDraftNow(projectPath, threadId);
    void save.catch(() => undefined);
  }, 350);
  record.draftSaveTimers.set(threadId, timer);
}

interface DraftSaveCapture {
  draft: { text: string; attachments: ChatAttachment[] };
  settings: SavedChatDraft['settings'];
  draftVersion: number;
  settingsVersion: number;
}

function saveProjectDraftNow(
  projectPath: string,
  draftId: string,
  captured?: DraftSaveCapture
): Promise<void> {
  const record = ensureRecord(projectPath);
  if (
    !record.identityVerified ||
    !record.projectId ||
    record.discardingThreadIds.has(draftId) ||
    record.discardedThreadIds.has(draftId)
  ) {
    return Promise.resolve();
  }
  const projectId = record.projectId;
  const identityVersion = record.identityVersion;
  const initial = getAgentChatSnapshot(projectPath);
  const checkoutPath = initial.draftCheckoutPaths[draftId];
  if (!checkoutPath) return Promise.resolve();
  const capturedState: DraftSaveCapture = captured ?? {
    draft: {
      text: initial.drafts[draftId] ?? '',
      attachments: initial.stagedAttachments[draftId] ?? [],
    },
    settings: draftSettingsFor(projectPath, draftId, initial),
    draftVersion: record.draftVersions.get(draftId) ?? 0,
    settingsVersion: record.settingsVersions.get(draftId) ?? 0,
  };

  return enqueuePersistence(projectPath, draftId, async () => {
    if (
      record.identityVersion !== identityVersion ||
      !record.identityVerified ||
      record.projectId !== projectId ||
      record.discardingThreadIds.has(draftId) ||
      record.discardedThreadIds.has(draftId)
    )
      return;
    const current = getAgentChatSnapshot(projectPath);
    const boundThreadId = current.draftThreadIds[draftId];
    if (boundThreadId && !captured) {
      const threadDraft = {
        text: current.drafts[boundThreadId] ?? '',
        attachments: current.stagedAttachments[boundThreadId] ?? [],
      };
      const selectedSettings = current.threadSettings[boundThreadId] ??
        current.threadSettings[draftId] ?? {
          modelId: null,
          reasoningEffort: null,
          autoAcceptMode: false,
        };
      const threadSettings = {
        modelId: selectedSettings.modelId,
        reasoningEffort: selectedSettings.reasoningEffort,
        autoAcceptMode: selectedSettings.autoAcceptMode ?? false,
      };
      const draftVersion = record.draftVersions.get(boundThreadId) ?? 0;
      const settingsVersion = record.settingsVersions.get(boundThreadId) ?? 0;
      try {
        if (record.identityVersion !== identityVersion || record.projectId !== projectId) return;
        let savedThread = await saveAgentChatDraftCommand(projectPath, boundThreadId, threadDraft);
        if (record.identityVersion !== identityVersion || record.projectId !== projectId) return;
        mergeThread(projectPath, savedThread);
        savedThread = await saveAgentChatSettingsCommand(
          projectPath,
          boundThreadId,
          threadSettings
        );
        if (record.identityVersion !== identityVersion || record.projectId !== projectId) return;
        mergeThread(projectPath, savedThread);
        const latest = getAgentChatSnapshot(projectPath);
        const latestDraftMatches =
          (latest.drafts[boundThreadId] ?? '') === threadDraft.text &&
          JSON.stringify(latest.stagedAttachments[boundThreadId] ?? []) ===
            JSON.stringify(threadDraft.attachments);
        const latestSettings = latest.threadSettings[boundThreadId] ?? threadSettings;
        const latestSettingsMatch =
          latestSettings.modelId === threadSettings.modelId &&
          latestSettings.reasoningEffort === threadSettings.reasoningEffort &&
          (latestSettings.autoAcceptMode ?? false) === threadSettings.autoAcceptMode;
        if (
          record.draftVersions.get(boundThreadId) === draftVersion &&
          latestDraftMatches &&
          savedThread.draft.text === threadDraft.text &&
          JSON.stringify(savedThread.draft.attachments) === JSON.stringify(threadDraft.attachments)
        ) {
          record.dirtyDrafts.delete(boundThreadId);
          record.dirtyDrafts.delete(draftId);
        }
        if (
          record.settingsVersions.get(boundThreadId) === settingsVersion &&
          latestSettingsMatch &&
          savedThread.settings.modelId === threadSettings.modelId &&
          savedThread.settings.reasoningEffort === threadSettings.reasoningEffort &&
          savedThread.settings.autoAcceptMode === threadSettings.autoAcceptMode
        ) {
          record.dirtySettings.delete(boundThreadId);
          record.dirtySettings.delete(draftId);
        }
        persistLocalState(projectPath);
        if (
          record.draftVersions.get(boundThreadId) !== draftVersion ||
          record.settingsVersions.get(boundThreadId) !== settingsVersion
        ) {
          queueDraftSave(projectPath, boundThreadId);
        }
        return;
      } catch (error) {
        if (record.identityVersion !== identityVersion) return;
        publish(projectPath, (snapshot) => ({
          ...snapshot,
          threadErrors: {
            ...snapshot.threadErrors,
            [boundThreadId]: `Draft save failed: ${messageOf(error)}`,
          },
        }));
        throw error;
      }
    }
    try {
      const savedDraft = await saveAgentChatProjectDraftCommand(
        projectPath,
        projectId,
        checkoutPath,
        draftId,
        capturedState.draft,
        capturedState.settings
      );
      if (
        record.identityVersion !== identityVersion ||
        !record.identityVerified ||
        record.projectId !== projectId
      )
        return;
      mergeSavedDraft(projectPath, savedDraft);
      const latest = getAgentChatSnapshot(projectPath);
      const draftMatches =
        (latest.drafts[draftId] ?? '') === capturedState.draft.text &&
        JSON.stringify(latest.stagedAttachments[draftId] ?? []) ===
          JSON.stringify(capturedState.draft.attachments);
      const settings = draftSettingsFor(projectPath, draftId, latest);
      const settingsMatch =
        settings.modelId === capturedState.settings.modelId &&
        settings.reasoningEffort === capturedState.settings.reasoningEffort &&
        settings.autoAcceptMode === capturedState.settings.autoAcceptMode;
      if (
        (record.draftVersions.get(draftId) ?? 0) === capturedState.draftVersion &&
        draftMatches &&
        savedDraft.draft.text === capturedState.draft.text &&
        JSON.stringify(savedDraft.draft.attachments) ===
          JSON.stringify(capturedState.draft.attachments)
      ) {
        record.dirtyDrafts.delete(draftId);
      }
      if (
        (record.settingsVersions.get(draftId) ?? 0) === capturedState.settingsVersion &&
        settingsMatch &&
        savedDraft.settings.modelId === capturedState.settings.modelId &&
        savedDraft.settings.reasoningEffort === capturedState.settings.reasoningEffort &&
        savedDraft.settings.autoAcceptMode === capturedState.settings.autoAcceptMode
      ) {
        record.dirtySettings.delete(draftId);
      }
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        threadErrors:
          record.dirtyDrafts.has(draftId) || record.dirtySettings.has(draftId)
            ? {
                ...snapshot.threadErrors,
                [draftId]:
                  'The saved draft changed while this update was in flight. Your newer edits are preserved and will be saved next.',
              }
            : clearThreadError(
                clearThreadError(snapshot.threadErrors, draftId),
                savedDraft.promotedThreadId ?? ''
              ),
      }));
      persistLocalState(projectPath);
      if (
        record.draftVersions.get(draftId) !== capturedState.draftVersion ||
        record.settingsVersions.get(draftId) !== capturedState.settingsVersion
      ) {
        queueDraftSave(projectPath, draftId);
      }
    } catch (error) {
      if (record.identityVersion !== identityVersion) return;
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        threadErrors: {
          ...snapshot.threadErrors,
          [draftId]: `Draft save failed: ${messageOf(error)}`,
        },
      }));
      persistLocalState(projectPath);
      throw error;
    }
  });
}

function saveThreadDraftNow(projectPath: string, threadId: string): Promise<void> {
  const record = ensureRecord(projectPath);
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) {
    return Promise.resolve();
  }
  const snapshot = getAgentChatSnapshot(projectPath);
  if (!snapshot.threads.some((thread) => thread.id === threadId)) return Promise.resolve();
  const version = record.draftVersions.get(threadId) ?? 0;
  const draft = {
    text: snapshot.drafts[threadId] ?? '',
    attachments: snapshot.stagedAttachments[threadId] ?? [],
  };
  return enqueuePersistence(projectPath, threadId, async () => {
    if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
    try {
      const savedThread = await saveAgentChatDraftCommand(projectPath, threadId, draft);
      mergeThread(projectPath, savedThread);
      const currentThread = getAgentChatSnapshot(projectPath).threads.find(
        (thread) => thread.id === threadId
      );
      const savedDraftMatches =
        savedThread.draft.text === draft.text &&
        JSON.stringify(savedThread.draft.attachments) === JSON.stringify(draft.attachments);
      const newerThreadConflicts = Boolean(
        currentThread &&
        currentThread.revision > savedThread.revision &&
        (currentThread.draft.text !== draft.text ||
          JSON.stringify(currentThread.draft.attachments) !== JSON.stringify(draft.attachments))
      );
      if (
        record.draftVersions.get(threadId) === version &&
        savedDraftMatches &&
        !newerThreadConflicts
      ) {
        record.dirtyDrafts.delete(threadId);
      }
      const saveWasSuperseded = record.dirtyDrafts.has(threadId);
      publish(projectPath, (current) => ({
        ...current,
        threadErrors: saveWasSuperseded
          ? {
              ...current.threadErrors,
              [threadId]:
                'The saved draft changed while this update was in flight. Your local draft is preserved; edit it to retry saving.',
            }
          : clearThreadError(current.threadErrors, threadId),
      }));
      persistLocalState(projectPath);
      if (
        !record.discardingThreadIds.has(threadId) &&
        !record.discardedThreadIds.has(threadId) &&
        record.draftVersions.get(threadId) !== version
      ) {
        queueDraftSave(projectPath, threadId);
      }
    } catch (error) {
      publish(projectPath, (current) => ({
        ...current,
        threadErrors: {
          ...current.threadErrors,
          [threadId]: `Draft save failed: ${messageOf(error)}`,
        },
      }));
      throw error;
    }
  });
}

function queueSettingsSave(projectPath: string, threadId: string): Promise<void> {
  const record = ensureRecord(projectPath);
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) {
    return Promise.resolve();
  }
  const snapshot = getAgentChatSnapshot(projectPath);
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    if (snapshot.draftCheckoutPaths[threadId]) return saveProjectDraftNow(projectPath, threadId);
    return Promise.resolve();
  }
  const version = record.settingsVersions.get(threadId) ?? 0;
  const selected = snapshot.threadSettings[threadId] ?? {
    modelId: thread.settings.modelId,
    reasoningEffort: thread.settings.reasoningEffort,
    autoAcceptMode: thread.settings.autoAcceptMode,
  };
  const settings = {
    ...selected,
    autoAcceptMode: selected.autoAcceptMode ?? thread.settings.autoAcceptMode,
  };
  return enqueuePersistence(projectPath, threadId, async () => {
    if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
    try {
      const savedThread = await saveAgentChatSettingsCommand(projectPath, threadId, settings);
      mergeThread(projectPath, savedThread);
      const currentThread = getAgentChatSnapshot(projectPath).threads.find(
        (candidate) => candidate.id === threadId
      );
      const savedSettingsMatch =
        savedThread.settings.modelId === settings.modelId &&
        savedThread.settings.reasoningEffort === settings.reasoningEffort &&
        savedThread.settings.autoAcceptMode === settings.autoAcceptMode;
      const newerThreadConflicts = Boolean(
        currentThread &&
        currentThread.revision > savedThread.revision &&
        (currentThread.settings.modelId !== settings.modelId ||
          currentThread.settings.reasoningEffort !== settings.reasoningEffort ||
          currentThread.settings.autoAcceptMode !== settings.autoAcceptMode)
      );
      if (
        record.settingsVersions.get(threadId) === version &&
        savedSettingsMatch &&
        !newerThreadConflicts
      ) {
        record.dirtySettings.delete(threadId);
      }
      const saveWasSuperseded = record.dirtySettings.has(threadId);
      publish(projectPath, (current) => ({
        ...current,
        threadErrors: saveWasSuperseded
          ? {
              ...current.threadErrors,
              [threadId]:
                'The saved settings changed while this update was in flight. Your local selection is preserved; change a setting to retry saving.',
            }
          : clearThreadError(current.threadErrors, threadId),
      }));
      persistLocalState(projectPath);
      if (
        !record.discardingThreadIds.has(threadId) &&
        !record.discardedThreadIds.has(threadId) &&
        record.settingsVersions.get(threadId) !== version
      ) {
        void queueSettingsSave(projectPath, threadId).catch(() => undefined);
      }
    } catch (error) {
      publish(projectPath, (current) => ({
        ...current,
        threadErrors: {
          ...current.threadErrors,
          [threadId]: `Settings save failed: ${messageOf(error)}`,
        },
      }));
      throw error;
    }
  });
}

function touchDraft(projectPath: string, threadId: string, saveImmediately = false): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
  record.draftVersions.set(threadId, (record.draftVersions.get(threadId) ?? 0) + 1);
  record.dirtyDrafts.add(threadId);
  persistLocalState(projectPath);
  if (saveImmediately) {
    const timer = record.draftSaveTimers.get(threadId);
    if (timer !== undefined) window.clearTimeout(timer);
    record.draftSaveTimers.delete(threadId);
    const boundThreadId = record.snapshot.draftThreadIds[threadId];
    const isThread = record.snapshot.threads.some((thread) => thread.id === threadId);
    const save = isThread
      ? saveThreadDraftNow(projectPath, threadId)
      : boundThreadId
        ? saveThreadDraftNow(projectPath, boundThreadId)
        : saveProjectDraftNow(projectPath, threadId);
    void save.catch(() => undefined);
  } else {
    queueDraftSave(projectPath, threadId);
  }
}

async function flushThreadSaves(projectPath: string, threadId: string): Promise<void> {
  const record = ensureRecord(projectPath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pendingTimer = record.draftSaveTimers.get(threadId);
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      record.draftSaveTimers.delete(threadId);
    }
    if (record.dirtyDrafts.has(threadId)) await saveThreadDraftNow(projectPath, threadId);
    if (record.dirtySettings.has(threadId)) await queueSettingsSave(projectPath, threadId);
    await (record.persistenceQueues.get(threadId) ?? Promise.resolve());
    if (!record.dirtyDrafts.has(threadId) && !record.dirtySettings.has(threadId)) return;
  }
  const message =
    'Draft or settings changes are still saving. Try Send again when the save finishes.';
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    threadErrors: { ...snapshot.threadErrors, [threadId]: message },
  }));
  throw new Error(message);
}

export function selectAgentChatThread(projectPath: string, threadId: string): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  const snapshot = getAgentChatSnapshot(projectPath);
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.status === 'closed') return;
  publish(projectPath, (current) => ({
    ...current,
    selectedThreadId: threadId,
    selectedDraftId: null,
    selectedCheckoutPath: thread.checkoutPath,
    threadSettings:
      current.models.length > 0 && !current.threadSettings[threadId]
        ? {
            ...current.threadSettings,
            [threadId]: {
              modelId: thread.settings.modelId,
              reasoningEffort: thread.settings.reasoningEffort,
              autoAcceptMode: thread.settings.autoAcceptMode,
            },
          }
        : current.threadSettings,
  }));
  persistLocalState(projectPath);
  if (thread.unread && ensureRecord(projectPath).chatVisible) {
    void markAgentChatThreadRead(projectPath, threadId).catch(() => undefined);
  }
}

/** Create a fresh provider-free draft, preserving every older saved draft. */
export function createAgentChatDraft(projectPath: string, checkoutPath = projectPath): string {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return '';
  const current = getAgentChatSnapshot(projectPath);
  const draftId = newDraftId();
  const selectedId = current.selectedThreadId ?? current.selectedDraftId;
  const selectedThread = current.threads.find((thread) => thread.id === selectedId);
  const selectedSettings = selectedId ? current.threadSettings[selectedId] : null;
  const inheritedSettings =
    (selectedId ? current.threadSettings[selectedId] : null) ??
    record.lastThreadSettings ??
    defaultThreadSettings(current.models);
  const draftSettings = {
    ...inheritedSettings,
    autoAcceptMode:
      selectedSettings?.autoAcceptMode ??
      selectedThread?.settings.autoAcceptMode ??
      inheritedSettings.autoAcceptMode ??
      false,
  };
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    selectedThreadId: null,
    selectedDraftId: draftId,
    selectedCheckoutPath: checkoutPath,
    draftCheckoutPaths: { ...snapshot.draftCheckoutPaths, [draftId]: checkoutPath },
    activeDraftIdsByCheckout: { ...snapshot.activeDraftIdsByCheckout, [checkoutPath]: draftId },
    drafts: { ...snapshot.drafts, [draftId]: '' },
    stagedAttachments: { ...snapshot.stagedAttachments, [draftId]: [] },
    threadSettings:
      snapshot.models.length > 0
        ? {
            ...snapshot.threadSettings,
            [draftId]: draftSettings,
          }
        : snapshot.threadSettings,
  }));
  record.dirtyDrafts.add(draftId);
  record.dirtySettings.add(draftId);
  record.draftVersions.set(draftId, 1);
  record.settingsVersions.set(draftId, 1);
  persistLocalState(projectPath);
  void saveProjectDraftNow(projectPath, draftId).catch(() => undefined);
  return draftId;
}

/** Select the current editable draft for a checkout, or create one if it has none. */
export function selectAgentChatDraft(projectPath: string, checkoutPath = projectPath): string {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return '';
  const current = getAgentChatSnapshot(projectPath);
  const activeDraftId = current.activeDraftIdsByCheckout[checkoutPath];
  const canReuse = Boolean(
    activeDraftId &&
    current.draftCheckoutPaths[activeDraftId] === checkoutPath &&
    !current.draftThreadIds[activeDraftId] &&
    !current.sendingDraftIds.includes(activeDraftId)
  );
  if (!canReuse || !activeDraftId) return createAgentChatDraft(projectPath, checkoutPath);
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    selectedThreadId: null,
    selectedDraftId: activeDraftId,
    selectedCheckoutPath: checkoutPath,
    drafts: Object.prototype.hasOwnProperty.call(snapshot.drafts, activeDraftId)
      ? snapshot.drafts
      : { ...snapshot.drafts, [activeDraftId]: '' },
    stagedAttachments: Object.prototype.hasOwnProperty.call(
      snapshot.stagedAttachments,
      activeDraftId
    )
      ? snapshot.stagedAttachments
      : { ...snapshot.stagedAttachments, [activeDraftId]: [] },
  }));
  persistLocalState(projectPath);
  if (!current.savedDrafts.some((draft) => draft.draftId === activeDraftId)) {
    void saveProjectDraftNow(projectPath, activeDraftId).catch(() => undefined);
  }
  return activeDraftId;
}

export function selectAgentChatSavedDraft(projectPath: string, draftId: string): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  const snapshot = getAgentChatSnapshot(projectPath);
  const savedDraft = snapshot.savedDrafts.find(
    (draft) => draft.draftId === draftId && draft.state === 'draft'
  );
  const checkoutPath = savedDraft?.checkoutPath ?? snapshot.draftCheckoutPaths[draftId];
  if (!checkoutPath || snapshot.draftThreadIds[draftId]) return;
  if (savedDraft && !record.dirtySettings.has(draftId)) {
    record.lastThreadSettings = normalizedThreadSettings(savedDraft.settings);
    persistLastThreadSettings(projectPath, record.projectId, record.lastThreadSettings);
  }
  publish(projectPath, (current) => ({
    ...current,
    selectedThreadId: null,
    selectedDraftId: draftId,
    selectedCheckoutPath: checkoutPath,
    draftCheckoutPaths: { ...current.draftCheckoutPaths, [draftId]: checkoutPath },
  }));
  persistLocalState(projectPath);
  void loadAgentChatDrafts(projectPath, checkoutPath);
}

export function getAgentChatDraftId(
  projectPath: string,
  checkoutPath = projectPath
): string | null {
  const snapshot = getAgentChatSnapshot(projectPath);
  const id = snapshot.activeDraftIdsByCheckout[checkoutPath];
  return id && !snapshot.draftThreadIds[id] && !snapshot.sendingDraftIds.includes(id) ? id : null;
}

export function setAgentChatDraft(projectPath: string, threadId: string, draft: string): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    drafts: { ...snapshot.drafts, [threadId]: draft },
  }));
  touchDraft(projectPath, threadId);
}

export function setAgentChatThreadSettings(
  projectPath: string,
  threadId: string,
  settings: AgentChatThreadSettings
): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
  record.lastThreadSettings = normalizedThreadSettings(settings);
  persistLastThreadSettings(projectPath, record.projectId, record.lastThreadSettings);
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    threadSettings: { ...snapshot.threadSettings, [threadId]: settings },
  }));
  record.settingsVersions.set(threadId, (record.settingsVersions.get(threadId) ?? 0) + 1);
  record.dirtySettings.add(threadId);
  persistLocalState(projectPath);
  if (record.snapshot.threads.some((thread) => thread.id === threadId)) {
    void queueSettingsSave(projectPath, threadId).catch(() => undefined);
  } else if (record.snapshot.draftCheckoutPaths[threadId]) {
    const timer = record.draftSaveTimers.get(threadId);
    if (timer !== undefined) window.clearTimeout(timer);
    record.draftSaveTimers.delete(threadId);
    void saveProjectDraftNow(projectPath, threadId).catch(() => undefined);
  }
}

export async function createAgentChatThread(
  projectPath: string,
  checkoutPath = projectPath
): Promise<ChatThread> {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) {
    throw new Error('Wait for this project’s Agent Chat identity to load before creating a chat.');
  }
  const projectId = record.projectId;
  const identityVersion = record.identityVersion;
  await ensureThreadListener();
  const thread = await createAgentChatThreadCommand(projectPath, projectId, checkoutPath, 'codex');
  if (record.identityVersion !== identityVersion || record.projectId !== projectId) return thread;
  mergeThread(projectPath, thread);
  selectAgentChatThread(projectPath, thread.id);
  return thread;
}

export async function sendAgentChatTurn(
  projectPath: string,
  threadId: string,
  text: string,
  autoAcceptMode: boolean,
  captured?: {
    attachments: ChatAttachment[];
    modelId: string | null;
    reasoningEffort: string | null;
    draftVersion?: number;
    settingsVersion?: number;
  }
): Promise<ChatThread> {
  const record = ensureRecord(projectPath);
  const initial = getAgentChatSnapshot(projectPath);
  const initialThread = initial.threads.find((thread) => thread.id === threadId);
  const rejectSend = (message: string): never => {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: message },
    }));
    throw new Error(message);
  };
  if (!record.identityVerified || !record.projectId) {
    rejectSend('Wait for this project’s Agent Chat identity to load before sending.');
  }
  const identityVersionAtStart = record.identityVersion;
  const projectIdAtStart = record.projectId!;
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) {
    rejectSend('This conversation is being discarded. Start a new chat to continue.');
  }
  if (!initialThread) {
    rejectSend('This conversation is no longer available. Start a new chat to continue.');
  }
  if (initial.sendingThreadIds.includes(threadId)) {
    rejectSend('A send is already starting for this conversation.');
  }
  if (initialThread && ['starting', 'running', 'waiting'].includes(initialThread.status)) {
    rejectSend('Wait for this conversation to finish before sending another message.');
  }
  if (initialThread?.providerStatus === 'active') {
    rejectSend(
      'Codex still reports an active saved turn. Check its status before sending another message.'
    );
  }
  if (initialThread?.status === 'closed') {
    rejectSend('This conversation has ended. Start a new chat to continue.');
  }
  if (initialThread?.checkoutStatus === 'missing') {
    rejectSend(
      'This conversation’s checkout is missing. Relink it to an available checkout before continuing.'
    );
  }
  if (initialThread?.resumeStatus === 'unavailable') {
    rejectSend(
      'Codex cannot resume this conversation. Its saved history is still available; start a new conversation to continue.'
    );
  }
  if (
    initialThread &&
    (initialThread.resumeStatus === 'unknown' ||
      initialThread.providerStatus === 'unknown' ||
      initialThread.providerStatus === 'systemError' ||
      initialThread.providerStatus === 'notLoaded')
  ) {
    rejectSend('Check Codex history before continuing this saved conversation.');
  }
  const settings = initial.threadSettings[threadId] ?? defaultThreadSettings(initial.models);
  const attachments = captured?.attachments ?? initial.stagedAttachments[threadId] ?? [];
  const modelId = captured ? captured.modelId : settings.modelId;
  const reasoningEffort = captured ? captured.reasoningEffort : settings.reasoningEffort;
  const validateModelSettings = (models: ChatModel[]): void => {
    if (modelId && !models.some((model) => model.id === modelId)) {
      rejectSend(
        `The saved model “${modelId}” is unavailable. Choose an available model before sending.`
      );
    }
    const selectedModel = models.find((model) => model.id === modelId);
    if (reasoningEffort && !selectedModel) {
      rejectSend(
        `The saved reasoning effort “${reasoningEffort}” cannot be sent without an available model.`
      );
    }
    if (
      reasoningEffort &&
      selectedModel &&
      !selectedModel.reasoningEfforts.includes(reasoningEffort)
    ) {
      rejectSend(
        `The saved reasoning effort “${reasoningEffort}” is unavailable for this model. Choose a supported effort before sending.`
      );
    }
  };
  if (attachments.some((attachment) => attachment.available !== true)) {
    const message = attachments.some((attachment) => attachment.available === false)
      ? ATTACHMENTS_UNAVAILABLE_ERROR
      : initial.attachmentAvailability[threadId] === 'checking'
        ? ATTACHMENTS_CHECKING_ERROR
        : ATTACHMENTS_UNKNOWN_ERROR;
    rejectSend(message);
  }
  validateModelSettings(initial.models);
  const safety = initial.sendSafety[threadId];
  const sameBlockedPrompt = (candidate: SendSafetyState | undefined): boolean =>
    Boolean(
      candidate &&
      candidate.blockedText === text &&
      candidate.blockedAttachmentIds.length === attachments.length &&
      candidate.blockedAttachmentIds.every((id, index) => attachments[index]?.id === id)
    );
  if (safety && (!safety.reconciled || sameBlockedPrompt(safety))) rejectSend(safety.message);

  const draftVersionAtSend = captured?.draftVersion ?? record.draftVersions.get(threadId) ?? 0;
  const settingsVersionAtSend =
    captured?.settingsVersion ?? record.settingsVersions.get(threadId) ?? 0;
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    error: null,
    threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    sendingThreadIds: [...snapshot.sendingThreadIds, threadId],
  }));

  let sendCommandStarted = false;
  try {
    if (!captured) await flushThreadSaves(projectPath, threadId);
    if (
      !record.identityVerified ||
      record.projectId !== projectIdAtStart ||
      record.identityVersion !== identityVersionAtStart
    ) {
      rejectSend('This project changed while Agent Chat was open. Reload before sending.');
    }
    if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) {
      throw new Error('This conversation is being discarded. Start a new chat to continue.');
    }
    const latest = getAgentChatSnapshot(projectPath);
    const latestThread = latest.threads.find((thread) => thread.id === threadId);
    if (!latestThread)
      rejectSend('This conversation is no longer available. Start a new chat to continue.');
    if (latestThread?.status === 'closed') {
      rejectSend('This conversation has ended. Start a new chat to continue.');
    }
    if (latestThread && ['starting', 'running', 'waiting'].includes(latestThread.status)) {
      rejectSend('Wait for this conversation to finish before sending another message.');
    }
    if (latestThread?.providerStatus === 'active') {
      rejectSend(
        'Codex still reports an active saved turn. Check its status before sending another message.'
      );
    }
    if (
      latestThread?.providerStatus === 'unknown' ||
      latestThread?.providerStatus === 'systemError' ||
      latestThread?.providerStatus === 'notLoaded'
    ) {
      rejectSend('Check Codex history before continuing this saved conversation.');
    }
    if (latestThread?.resumeStatus !== 'available') {
      rejectSend('Check Codex history before continuing this saved conversation.');
    }
    if (latestThread?.checkoutStatus !== 'available') {
      rejectSend(
        'This conversation’s checkout is missing. Relink it to an available checkout before continuing.'
      );
    }
    const latestSafety = latest.sendSafety[threadId];
    if (latestSafety && (!latestSafety.reconciled || sameBlockedPrompt(latestSafety))) {
      rejectSend(latestSafety.message);
    }
    validateModelSettings(latest.models);

    const sendAttemptId = newDraftId();
    record.pendingSends[threadId] = {
      attemptId: sendAttemptId,
      text,
      attachmentIds: attachments.map((attachment) => attachment.id),
    };
    persistLocalState(projectPath);
    sendCommandStarted = true;
    const thread = await sendAgentChatCommand(
      projectPath,
      projectIdAtStart,
      threadId,
      text,
      attachments,
      modelId,
      reasoningEffort,
      autoAcceptMode,
      sendAttemptId
    );
    if (
      record.identityVersion !== identityVersionAtStart ||
      record.projectId !== projectIdAtStart
    ) {
      throw new Error('This project changed while Agent Chat was open. Reload before continuing.');
    }
    if (record.discardedThreadIds.has(threadId)) {
      delete record.pendingSends[threadId];
      persistLocalState(projectPath);
      return thread;
    }
    const unchangedSinceSend = (record.draftVersions.get(threadId) ?? 0) === draftVersionAtSend;
    mergeThread(projectPath, thread, unchangedSinceSend);
    delete record.pendingSends[threadId];
    publish(projectPath, (snapshot) => {
      const staged = (snapshot.stagedAttachments[threadId] ?? []).filter(
        (attachment) => !attachments.some((sentAttachment) => sentAttachment.id === attachment.id)
      );
      const drafts = { ...snapshot.drafts };
      if (unchangedSinceSend && drafts[threadId] === text) drafts[threadId] = '';
      return {
        ...snapshot,
        drafts,
        stagedAttachments: { ...snapshot.stagedAttachments, [threadId]: staged },
        error: null,
        threadErrors: clearThreadError(snapshot.threadErrors, threadId),
        sendSafety: Object.fromEntries(
          Object.entries(snapshot.sendSafety).filter(([id]) => id !== threadId)
        ),
      };
    });
    if (sendCommandStarted) {
      if ((record.draftVersions.get(threadId) ?? 0) !== draftVersionAtSend) {
        record.dirtyDrafts.add(threadId);
      }
      if ((record.settingsVersions.get(threadId) ?? 0) !== settingsVersionAtSend) {
        record.dirtySettings.add(threadId);
      }
      if (record.dirtyDrafts.has(threadId)) {
        const timer = record.draftSaveTimers.get(threadId);
        if (timer !== undefined) window.clearTimeout(timer);
        record.draftSaveTimers.delete(threadId);
        void saveThreadDraftNow(projectPath, threadId).catch(() => undefined);
      }
      if (record.dirtySettings.has(threadId)) {
        void queueSettingsSave(projectPath, threadId).catch(() => undefined);
      }
    }
    persistLocalState(projectPath);
    return thread;
  } catch (error) {
    const message = messageOf(error);
    if (
      record.identityVersion !== identityVersionAtStart ||
      record.projectId !== projectIdAtStart
    ) {
      throw error;
    }
    if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) {
      delete record.pendingSends[threadId];
      persistLocalState(projectPath);
      throw error;
    }
    if (sendCommandStarted) {
      if ((record.draftVersions.get(threadId) ?? 0) === draftVersionAtSend) {
        publish(projectPath, (snapshot) => {
          const existing = snapshot.stagedAttachments[threadId] ?? [];
          const restored = [...existing];
          for (const attachment of attachments) {
            if (!restored.some((candidate) => candidate.id === attachment.id)) {
              restored.push(attachment);
            }
          }
          return {
            ...snapshot,
            drafts: { ...snapshot.drafts, [threadId]: text },
            stagedAttachments: { ...snapshot.stagedAttachments, [threadId]: restored },
          };
        });
        record.draftVersions.set(threadId, draftVersionAtSend + 1);
        record.dirtyDrafts.add(threadId);
      }
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        threadErrors: { ...snapshot.threadErrors, [threadId]: message },
        sendSafety: {
          ...snapshot.sendSafety,
          [threadId]: {
            message:
              'Check Codex history before sending this prompt again. The previous send may have been accepted.',
            blockedText: text,
            blockedAttachmentIds: attachments.map((attachment) => attachment.id),
            reconciled: false,
          },
        },
      }));
    } else {
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        threadErrors: { ...snapshot.threadErrors, [threadId]: message },
      }));
    }
    if (sendCommandStarted) {
      if ((record.draftVersions.get(threadId) ?? 0) !== draftVersionAtSend) {
        record.dirtyDrafts.add(threadId);
      }
      if ((record.settingsVersions.get(threadId) ?? 0) !== settingsVersionAtSend) {
        record.dirtySettings.add(threadId);
      }
      if (record.dirtyDrafts.has(threadId)) {
        const timer = record.draftSaveTimers.get(threadId);
        if (timer !== undefined) window.clearTimeout(timer);
        record.draftSaveTimers.delete(threadId);
        void saveThreadDraftNow(projectPath, threadId).catch(() => undefined);
      }
      if (record.dirtySettings.has(threadId)) {
        void queueSettingsSave(projectPath, threadId).catch(() => undefined);
      }
    }
    persistLocalState(projectPath);
    throw error;
  } finally {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      sendingThreadIds: snapshot.sendingThreadIds.filter((id) => id !== threadId),
    }));
  }
}

/** Persist the captured composer, idempotently promote its draft, then send once. */
export async function sendAgentChatDraftTurn(
  projectPath: string,
  draftId: string,
  checkoutPath: string,
  text: string,
  autoAcceptMode: boolean
): Promise<ChatThread> {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) {
    throw new Error('Wait for this project’s Agent Chat identity to load before sending.');
  }
  const projectIdAtStart = record.projectId;
  const identityVersionAtStart = record.identityVersion;
  const initial = getAgentChatSnapshot(projectPath);
  const rejectDraftSend = (message: string): never => {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [draftId]: message },
    }));
    throw new Error(message);
  };
  if (record.discardingThreadIds.has(draftId) || record.discardedThreadIds.has(draftId)) {
    rejectDraftSend('This draft is no longer available. Start a new chat to continue.');
  }
  if (initial.draftCheckoutPaths[draftId] !== checkoutPath) {
    rejectDraftSend('This draft no longer matches its checkout. Select a checkout and try again.');
  }
  if (record.snapshot.sendingDraftIds.includes(draftId)) {
    rejectDraftSend('A send is already starting for this draft.');
  }

  const existingThreadId = initial.draftThreadIds[draftId];
  if (existingThreadId) {
    return sendAgentChatTurn(projectPath, existingThreadId, text, autoAcceptMode);
  }

  const selectedSettings = initial.threadSettings[draftId] ?? defaultThreadSettings(initial.models);
  const settings: SavedChatDraft['settings'] = {
    modelId: selectedSettings.modelId,
    reasoningEffort: selectedSettings.reasoningEffort,
    autoAcceptMode,
  };
  const draftVersionAtSend = record.draftVersions.get(draftId) ?? 0;
  const settingsVersionAtSend = record.settingsVersions.get(draftId) ?? 0;
  const capturedAttachments = initial.stagedAttachments[draftId] ?? [];
  const captured: DraftSaveCapture = {
    draft: { text, attachments: capturedAttachments },
    settings,
    draftVersion: draftVersionAtSend,
    settingsVersion: settingsVersionAtSend,
  };
  if (capturedAttachments.some((attachment) => attachment.available !== true)) {
    const message = capturedAttachments.some((attachment) => attachment.available === false)
      ? ATTACHMENTS_UNAVAILABLE_ERROR
      : initial.attachmentAvailability[draftId] === 'checking'
        ? ATTACHMENTS_CHECKING_ERROR
        : ATTACHMENTS_UNKNOWN_ERROR;
    rejectDraftSend(message);
  }
  if (settings.modelId && !initial.models.some((model) => model.id === settings.modelId)) {
    rejectDraftSend(
      `The saved model “${settings.modelId}” is unavailable. Choose an available model before sending.`
    );
  }
  const draftModel = initial.models.find((model) => model.id === settings.modelId);
  if (settings.reasoningEffort && !draftModel) {
    rejectDraftSend(
      `The saved reasoning effort “${settings.reasoningEffort}” cannot be sent without an available model.`
    );
  }
  if (
    settings.reasoningEffort &&
    draftModel &&
    !draftModel.reasoningEfforts.includes(settings.reasoningEffort)
  ) {
    rejectDraftSend(
      `The saved reasoning effort “${settings.reasoningEffort}” is unavailable for this model. Choose a supported effort before sending.`
    );
  }
  publish(projectPath, (snapshot) => ({
    ...snapshot,
    error: null,
    threadErrors: clearThreadError(snapshot.threadErrors, draftId),
    sendingDraftIds: snapshot.sendingDraftIds.includes(draftId)
      ? snapshot.sendingDraftIds
      : [...snapshot.sendingDraftIds, draftId],
  }));

  try {
    await ensureThreadListener();
    await saveProjectDraftNow(projectPath, draftId, captured);
    if (
      record.identityVersion !== identityVersionAtStart ||
      record.projectId !== projectIdAtStart ||
      !record.identityVerified
    )
      throw new Error('This project changed while Agent Chat was open. Reload before sending.');
    const thread = await enqueuePersistence(projectPath, draftId, () =>
      promoteAgentChatDraftCommand(projectPath, projectIdAtStart, checkoutPath, draftId, 'codex')
    );
    if (
      record.identityVersion !== identityVersionAtStart ||
      record.projectId !== projectIdAtStart ||
      !record.identityVerified
    )
      throw new Error('This project changed while Agent Chat was open. Reload before sending.');
    if (thread.projectPath !== projectPath || thread.checkoutPath !== checkoutPath) {
      throw new Error('Codex promoted a draft for a different project or checkout.');
    }
    mergeThread(projectPath, thread);
    const latest = getAgentChatSnapshot(projectPath);
    const latestDraft = {
      text: latest.drafts[draftId] ?? thread.draft.text,
      attachments: latest.stagedAttachments[draftId] ?? thread.draft.attachments,
    };
    const latestSettings = latest.threadSettings[draftId] ?? settings;
    const latestDraftVersion = record.draftVersions.get(draftId) ?? draftVersionAtSend;
    const latestSettingsVersion = record.settingsVersions.get(draftId) ?? settingsVersionAtSend;
    record.draftVersions.set(thread.id, latestDraftVersion);
    record.settingsVersions.set(thread.id, latestSettingsVersion);
    if (record.dirtyDrafts.has(draftId)) record.dirtyDrafts.add(thread.id);
    if (record.dirtySettings.has(draftId)) record.dirtySettings.add(thread.id);
    publish(projectPath, (snapshot) => {
      const activeDraftIdsByCheckout = { ...snapshot.activeDraftIdsByCheckout };
      if (activeDraftIdsByCheckout[checkoutPath] === draftId) {
        delete activeDraftIdsByCheckout[checkoutPath];
      }
      return {
        ...snapshot,
        selectedThreadId:
          snapshot.selectedDraftId === draftId ? thread.id : snapshot.selectedThreadId,
        selectedDraftId: snapshot.selectedDraftId === draftId ? null : snapshot.selectedDraftId,
        selectedCheckoutPath:
          snapshot.selectedDraftId === draftId ? checkoutPath : snapshot.selectedCheckoutPath,
        drafts: { ...snapshot.drafts, [thread.id]: latestDraft.text },
        stagedAttachments: { ...snapshot.stagedAttachments, [thread.id]: latestDraft.attachments },
        threadSettings: { ...snapshot.threadSettings, [thread.id]: latestSettings },
        threadErrors: clearThreadError(snapshot.threadErrors, draftId),
        activeDraftIdsByCheckout,
        draftThreadIds: { ...snapshot.draftThreadIds, [draftId]: thread.id },
      };
    });
    persistLocalState(projectPath);

    if (
      !thread.providerThreadId ||
      thread.status !== 'idle' ||
      thread.resumeStatus !== 'available' ||
      thread.providerStatus !== 'idle'
    ) {
      const reason =
        thread.error ??
        'Codex could not confirm that this conversation is ready. Your draft and attachments are saved; start a new conversation to avoid sending into an uncertain thread.';
      publish(projectPath, (snapshot) => ({
        ...snapshot,
        threadErrors: { ...snapshot.threadErrors, [thread.id]: reason },
      }));
      throw new Error(reason);
    }

    return await sendAgentChatTurn(projectPath, thread.id, text, autoAcceptMode, {
      attachments: capturedAttachments,
      modelId: settings.modelId,
      reasoningEffort: settings.reasoningEffort,
      draftVersion: draftVersionAtSend,
      settingsVersion: settingsVersionAtSend,
    });
  } catch (error) {
    if (
      record.identityVersion !== identityVersionAtStart ||
      record.projectId !== projectIdAtStart
    ) {
      throw error;
    }
    const createdThreadId = getAgentChatSnapshot(projectPath).draftThreadIds[draftId];
    if (createdThreadId && record.discardedThreadIds.has(createdThreadId)) throw error;
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: {
        ...snapshot.threadErrors,
        [createdThreadId ?? draftId]: messageOf(error),
      },
    }));
    throw error;
  } finally {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      sendingDraftIds: snapshot.sendingDraftIds.filter((id) => id !== draftId),
    }));
  }
}

export async function interruptAgentChatThread(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  try {
    const thread = await interruptAgentChatCommand(projectPath, threadId);
    mergeThread(projectPath, thread);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
    return thread;
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: messageOf(error) },
    }));
    throw error;
  }
}

export async function interruptSelectedAgentChatThread(
  projectPath: string
): Promise<ChatThread | null> {
  const snapshot = getAgentChatSnapshot(projectPath);
  const threadId = snapshot.selectedThreadId;
  if (!threadId) return null;
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread || !['starting', 'running', 'waiting'].includes(thread.status)) return null;
  return interruptAgentChatThread(projectPath, threadId);
}

export async function respondToAgentChatRequest(
  projectPath: string,
  threadId: string,
  requestId: string,
  response: ChatResponse
): Promise<ChatThread> {
  try {
    const thread = await respondAgentChatCommand(projectPath, threadId, requestId, response);
    mergeThread(projectPath, thread);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
    return thread;
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: messageOf(error) },
    }));
    throw error;
  }
}

export async function renameAgentChatThread(
  projectPath: string,
  threadId: string,
  title: string
): Promise<void> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error('Enter a title for this conversation.');
  if (normalizedTitle.length > 120)
    throw new Error('Conversation titles must be 120 characters or fewer.');
  try {
    const updated = await renameAgentChatThreadCommand(projectPath, threadId, normalizedTitle);
    mergeThread(projectPath, updated);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, title: normalizedTitle, titleSource: 'manual' }
          : thread
      ),
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: messageOf(error) },
    }));
    throw error;
  }
}

export async function settleAgentChatThread(projectPath: string, threadId: string): Promise<void> {
  const current = getAgentChatSnapshot(projectPath).threads.find(
    (thread) => thread.id === threadId
  );
  if (!current) throw new Error('This conversation is no longer available.');
  if (['starting', 'running', 'waiting'].includes(current.status)) {
    throw new Error('A conversation can only be settled after its turn has stopped.');
  }
  if (current.providerStatus === 'active') {
    throw new Error(
      'Codex still reports an active turn. Check its status before settling this conversation.'
    );
  }
  try {
    const updated = await settleAgentChatThreadCommand(projectPath, threadId);
    mergeThread(projectPath, updated);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
    persistLocalState(projectPath);
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: messageOf(error) },
    }));
    throw error;
  }
}

export async function reopenAgentChatThread(projectPath: string, threadId: string): Promise<void> {
  try {
    const updated = await reopenAgentChatThreadCommand(projectPath, threadId);
    mergeThread(projectPath, updated);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: messageOf(error) },
    }));
    throw error;
  }
}

export async function markAgentChatThreadRead(
  projectPath: string,
  threadId: string
): Promise<void> {
  const record = ensureRecord(projectPath);
  const current = getAgentChatSnapshot(projectPath).threads.find(
    (thread) => thread.id === threadId
  );
  if (!current || !current.unread || record.readInFlight.has(threadId)) return;
  const requestedCursor = current.activityCursor;
  record.readInFlight.add(threadId);
  try {
    const updated = await markAgentChatThreadReadCommand(projectPath, threadId);
    mergeThread(projectPath, updated);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: {
        ...snapshot.threadErrors,
        [threadId]: `Could not mark this conversation read: ${messageOf(error)}`,
      },
    }));
  } finally {
    record.readInFlight.delete(threadId);
    const latest = getAgentChatSnapshot(projectPath);
    if (
      record.chatVisible &&
      latest.selectedThreadId === threadId &&
      latest.threads.some(
        (thread) =>
          thread.id === threadId && thread.unread && thread.activityCursor > requestedCursor
      )
    ) {
      void markAgentChatThreadRead(projectPath, threadId);
    }
  }
}

export async function resumeCheckAgentChatThread(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) {
    throw new Error('Wait for this project’s Agent Chat identity to load before checking history.');
  }
  const identityVersion = record.identityVersion;
  const projectId = record.projectId;
  try {
    const updated = await resumeCheckAgentChatThreadCommand(projectPath, threadId);
    if (record.identityVersion !== identityVersion || record.projectId !== projectId)
      return updated;
    mergeThread(projectPath, updated);
    const pending = record.pendingSends[threadId];
    const providerAvailable = updated.resumeStatus === 'available';
    const attemptReconciliation = pending?.attemptId
      ? updated.turns.find((turn) => turn.id === pending.attemptId)?.reconciliation
      : null;
    const reconciliation =
      attemptReconciliation?.attemptId === pending?.attemptId ? attemptReconciliation : null;
    const outcome = reconciliation?.outcome ?? null;
    if (pending && outcome === 'confirmedPresent') {
      record.pendingSends[threadId] = {
        ...pending,
        reconciliation: 'confirmedPresent',
        providerTurnId: reconciliation?.providerTurnId ?? null,
      };
    } else if (pending && outcome === 'confirmedAbsent') {
      delete record.pendingSends[threadId];
    } else if (pending) {
      record.pendingSends[threadId] = { ...pending, reconciliation: 'ambiguous' };
    }
    publish(projectPath, (snapshot) => {
      const sendSafety = { ...snapshot.sendSafety };
      const reconciliationRequired = { ...snapshot.reconciliationRequired };
      if (pending && outcome === 'confirmedPresent') {
        sendSafety[threadId] = {
          message:
            pending.attachmentIds.length > 0
              ? 'Codex history confirms this prompt text was accepted. It cannot confirm whether the attachments were accepted; edit the prompt or attachment selection before sending again.'
              : 'Codex history confirms this prompt was accepted. Edit it before sending again to avoid a duplicate.',
          blockedText: pending.text,
          blockedAttachmentIds: pending.attachmentIds,
          reconciled: true,
        };
        delete reconciliationRequired[threadId];
      } else if (pending && outcome === 'confirmedAbsent' && updated.providerStatus === 'idle') {
        delete sendSafety[threadId];
        delete reconciliationRequired[threadId];
      } else if (pending && providerAvailable) {
        sendSafety[threadId] = {
          message:
            'Codex history could not tie this provider item to the saved send attempt. Keep the draft and check history again before continuing.',
          blockedText: pending.text,
          blockedAttachmentIds: pending.attachmentIds,
          reconciled: false,
        };
        reconciliationRequired[threadId] = sendSafety[threadId].message;
      } else if (providerAvailable && updated.providerStatus === 'idle' && !pending) {
        delete sendSafety[threadId];
        delete reconciliationRequired[threadId];
      } else {
        sendSafety[threadId] = {
          message:
            updated.providerStatus === 'systemError'
              ? 'Codex reports a system error for this saved conversation. Keep the draft and check its history again before continuing.'
              : pending
                ? 'Codex could not confirm this conversation. Keep the draft and check its history again before retrying.'
                : 'Codex could not confirm this conversation. Keep its saved history and check again before continuing.',
          blockedText: pending?.text ?? '',
          blockedAttachmentIds: pending?.attachmentIds ?? [],
          reconciled: false,
        };
        reconciliationRequired[threadId] = sendSafety[threadId].message;
      }
      return {
        ...snapshot,
        sendSafety,
        reconciliationRequired,
        threadErrors:
          providerAvailable && updated.providerStatus === 'idle'
            ? clearThreadError(snapshot.threadErrors, threadId)
            : {
                ...snapshot.threadErrors,
                [threadId]:
                  updated.providerStatus === 'active'
                    ? 'Codex still reports an active saved turn. Wait for it to finish before continuing.'
                    : updated.providerStatus === 'systemError'
                      ? 'Codex reports a system error for this saved conversation. Local history remains available.'
                      : 'Codex history is unavailable for this conversation. The local transcript remains saved.',
              },
      };
    });
    persistLocalState(projectPath);
    return updated;
  } catch (error) {
    if (record.identityVersion !== identityVersion || record.projectId !== projectId) throw error;
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: {
        ...snapshot.threadErrors,
        [threadId]: `History check failed: ${messageOf(error)}`,
      },
    }));
    throw error;
  }
}

export async function relinkAgentChatCheckout(
  projectPath: string,
  threadId: string,
  checkoutPath: string
): Promise<void> {
  try {
    const updated = await relinkAgentChatCheckoutCommand(projectPath, threadId, checkoutPath);
    mergeThread(projectPath, updated);
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: clearThreadError(snapshot.threadErrors, threadId),
    }));
  } catch (error) {
    publish(projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: { ...snapshot.threadErrors, [threadId]: messageOf(error) },
    }));
    throw error;
  }
}

export async function relinkUnlinkedAgentChatProject(
  projectPath: string,
  projectId: string
): Promise<void> {
  try {
    await relinkAgentChatProjectCommand(projectId, projectPath);
    await loadAgentChatProject(projectPath, true);
  } catch (error) {
    publish(projectPath, (snapshot) => ({ ...snapshot, error: messageOf(error) }));
    throw error;
  }
}

export async function deleteAgentChatDraft(projectPath: string, draftId: string): Promise<void> {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) {
    throw new Error('Wait for this project’s Agent Chat identity to load before deleting a draft.');
  }
  const projectId = record.projectId;
  const identityVersion = record.identityVersion;
  const snapshot = getAgentChatSnapshot(projectPath);
  const savedDraft = snapshot.savedDrafts.find((draft) => draft.draftId === draftId);
  const checkoutPath = savedDraft?.checkoutPath ?? snapshot.draftCheckoutPaths[draftId];
  if (!checkoutPath || savedDraft?.state === 'promoted') {
    throw new Error('This saved draft is no longer available.');
  }
  if (snapshot.draftThreadIds[draftId]) {
    throw new Error(
      'This draft has already become a conversation. Select that conversation instead.'
    );
  }
  if (snapshot.sendingDraftIds.includes(draftId)) {
    throw new Error('Wait for the first send to finish before deleting this draft.');
  }
  record.discardingThreadIds.add(draftId);
  const timer = record.draftSaveTimers.get(draftId);
  if (timer !== undefined) window.clearTimeout(timer);
  record.draftSaveTimers.delete(draftId);
  await (record.persistenceQueues.get(draftId) ?? Promise.resolve());
  if (record.identityVersion !== identityVersion || record.projectId !== projectId) {
    throw new Error('This project changed while Agent Chat was open. Reload before deleting.');
  }
  try {
    if (savedDraft) await deleteAgentChatProjectDraftCommand(projectPath, projectId, draftId);
    if (record.identityVersion !== identityVersion || record.projectId !== projectId) {
      throw new Error('This project changed while Agent Chat was open. Reload before deleting.');
    }
  } catch (error) {
    record.discardingThreadIds.delete(draftId);
    if (record.identityVersion !== identityVersion) throw error;
    publish(projectPath, (current) => ({
      ...current,
      threadErrors: {
        ...current.threadErrors,
        [draftId]: `Draft delete failed: ${messageOf(error)}`,
      },
    }));
    throw error;
  }
  record.discardingThreadIds.delete(draftId);
  record.discardedThreadIds.add(draftId);
  record.dirtyDrafts.delete(draftId);
  record.dirtySettings.delete(draftId);
  record.draftVersions.delete(draftId);
  record.settingsVersions.delete(draftId);
  const wasSelected = snapshot.selectedDraftId === draftId;
  publish(projectPath, (current) => {
    const draftCheckoutPaths = { ...current.draftCheckoutPaths };
    const draftThreadIds = { ...current.draftThreadIds };
    const activeDraftIdsByCheckout = { ...current.activeDraftIdsByCheckout };
    delete draftCheckoutPaths[draftId];
    delete draftThreadIds[draftId];
    if (activeDraftIdsByCheckout[checkoutPath] === draftId) {
      delete activeDraftIdsByCheckout[checkoutPath];
    }
    const drafts = { ...current.drafts };
    const stagedAttachments = { ...current.stagedAttachments };
    const threadSettings = { ...current.threadSettings };
    const threadErrors = { ...current.threadErrors };
    delete drafts[draftId];
    delete stagedAttachments[draftId];
    delete threadSettings[draftId];
    delete threadErrors[draftId];
    return {
      ...current,
      savedDrafts: current.savedDrafts.filter((draft) => draft.draftId !== draftId),
      selectedDraftId: wasSelected ? null : current.selectedDraftId,
      drafts,
      stagedAttachments,
      threadSettings,
      threadErrors,
      draftCheckoutPaths,
      draftThreadIds,
      activeDraftIdsByCheckout,
    };
  });
  persistLocalState(projectPath);
  if (wasSelected) createAgentChatDraft(projectPath, checkoutPath);
}

export async function discardAgentChatThread(projectPath: string, threadId: string): Promise<void> {
  // This store operation is only reached after the panel or reset palette's
  // explicit confirmation surface has been accepted.
  const record = ensureRecord(projectPath);
  record.discardingThreadIds.add(threadId);
  const beforeCleanup = getAgentChatSnapshot(projectPath);
  const pendingTimer = record.draftSaveTimers.get(threadId);
  if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
  record.draftSaveTimers.delete(threadId);
  await (record.persistenceQueues.get(threadId) ?? Promise.resolve()).catch(() => undefined);
  try {
    await discardAgentChatCommand(projectPath, threadId, true);
  } catch (error) {
    record.discardingThreadIds.delete(threadId);
    await loadAgentChatProject(projectPath, true).catch(() => undefined);
    throw error;
  }
  const boundDraftIds = Object.entries(beforeCleanup.draftThreadIds)
    .filter(([, boundThreadId]) => boundThreadId === threadId)
    .map(([draftId]) => draftId);
  record.pendingSends = Object.fromEntries(
    Object.entries(record.pendingSends).filter(([id]) => id !== threadId)
  );
  record.dirtyDrafts.delete(threadId);
  record.dirtySettings.delete(threadId);
  record.draftVersions.delete(threadId);
  record.settingsVersions.delete(threadId);
  for (const draftId of boundDraftIds) {
    const draftTimer = record.draftSaveTimers.get(draftId);
    if (draftTimer !== undefined) window.clearTimeout(draftTimer);
    record.draftSaveTimers.delete(draftId);
    record.dirtyDrafts.delete(draftId);
    record.dirtySettings.delete(draftId);
    record.draftVersions.delete(draftId);
    record.settingsVersions.delete(draftId);
  }
  record.discardedThreadIds.add(threadId);
  record.discardingThreadIds.delete(threadId);
  const removedSelectedThread = beforeCleanup.selectedThreadId === threadId;
  const nextThread = removedSelectedThread
    ? (beforeCleanup.threads.find(
        (thread) => thread.id !== threadId && thread.status !== 'closed'
      ) ?? null)
    : null;
  const fallbackDraftId =
    removedSelectedThread && !nextThread
      ? selectAgentChatDraft(projectPath, beforeCleanup.selectedCheckoutPath)
      : beforeCleanup.selectedDraftId;
  publish(projectPath, (snapshot) => {
    const threads = snapshot.threads.filter((thread) => thread.id !== threadId);
    const selectionStillRemoved = snapshot.selectedThreadId === threadId;
    const selectedThread = selectionStillRemoved ? nextThread : null;
    const drafts = { ...snapshot.drafts };
    const stagedAttachments = { ...snapshot.stagedAttachments };
    const threadSettings = { ...snapshot.threadSettings };
    const threadErrors = { ...snapshot.threadErrors };
    const reconciliationRequired = { ...snapshot.reconciliationRequired };
    const sendSafety = { ...snapshot.sendSafety };
    const draftThreadIds = { ...snapshot.draftThreadIds };
    const draftCheckoutPaths = { ...snapshot.draftCheckoutPaths };
    const activeDraftIdsByCheckout = { ...snapshot.activeDraftIdsByCheckout };
    for (const draftId of boundDraftIds) {
      delete drafts[draftId];
      delete stagedAttachments[draftId];
      delete threadSettings[draftId];
      delete threadErrors[draftId];
      delete draftThreadIds[draftId];
      delete draftCheckoutPaths[draftId];
      Object.entries(activeDraftIdsByCheckout).forEach(([checkoutPath, activeDraftId]) => {
        if (activeDraftId === draftId) delete activeDraftIdsByCheckout[checkoutPath];
      });
    }
    delete drafts[threadId];
    delete stagedAttachments[threadId];
    delete threadSettings[threadId];
    delete threadErrors[threadId];
    delete reconciliationRequired[threadId];
    delete sendSafety[threadId];
    return {
      ...snapshot,
      threads,
      selectedThreadId:
        selectedThread?.id ?? (selectionStillRemoved ? null : snapshot.selectedThreadId),
      selectedDraftId: selectedThread
        ? null
        : selectionStillRemoved
          ? fallbackDraftId
          : snapshot.selectedDraftId,
      selectedCheckoutPath: selectedThread?.checkoutPath ?? snapshot.selectedCheckoutPath,
      drafts,
      stagedAttachments,
      threadSettings,
      threadErrors,
      reconciliationRequired,
      sendSafety,
      draftThreadIds,
      draftCheckoutPaths,
      activeDraftIdsByCheckout,
    };
  });
  persistLocalState(projectPath);
}

export async function stageCapturedAttachment(
  target: AgentChatCaptureTarget,
  path: string
): Promise<ChatAttachment | null> {
  const record = ensureRecord(target.projectPath);
  if (!record.identityVerified || !record.projectId) return null;
  const projectId = record.projectId;
  const identityVersion = record.identityVersion;
  const before = getAgentChatSnapshot(target.projectPath);
  if (!isCaptureTargetAvailable(before, target)) return null;

  try {
    const attachment = await stageAgentChatAttachmentCommand(target.projectPath, path);
    if (
      record.identityVersion !== identityVersion ||
      !record.identityVerified ||
      record.projectId !== projectId
    )
      return null;
    let attached = false;
    let destinationId: string | null = null;
    publish(target.projectPath, (snapshot) => {
      destinationId = resolveCaptureDestinationId(snapshot, target);
      if (!destinationId) return snapshot;
      attached = true;
      const previous = snapshot.stagedAttachments[destinationId] ?? [];
      return {
        ...snapshot,
        error: null,
        threadErrors: clearThreadError(snapshot.threadErrors, destinationId),
        stagedAttachments: {
          ...snapshot.stagedAttachments,
          [destinationId]: [...previous, attachment],
        },
      };
    });
    if (attached && destinationId) touchDraft(target.projectPath, destinationId, true);
    return attached ? attachment : null;
  } catch (error) {
    publish(target.projectPath, (snapshot) => ({
      ...snapshot,
      threadErrors: {
        ...snapshot.threadErrors,
        [target.kind === 'thread' ? target.threadId : target.draftId]: messageOf(error),
      },
    }));
    throw error;
  }
}

export function removeStagedAgentChatAttachment(
  projectPath: string,
  threadId: string,
  attachmentId: string
): void {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return;
  if (record.discardingThreadIds.has(threadId) || record.discardedThreadIds.has(threadId)) return;
  publish(projectPath, (snapshot) => {
    const attachments = (snapshot.stagedAttachments[threadId] ?? []).filter(
      (attachment) => attachment.id !== attachmentId
    );
    const attachmentAvailability = { ...snapshot.attachmentAvailability };
    const threadErrors = { ...snapshot.threadErrors };
    if (attachments.every((attachment) => typeof attachment.available === 'boolean')) {
      delete attachmentAvailability[threadId];
      if (
        attachments.every((attachment) => attachment.available === true) &&
        isAttachmentAvailabilityError(threadErrors[threadId])
      ) {
        delete threadErrors[threadId];
      }
    }
    return {
      ...snapshot,
      stagedAttachments: { ...snapshot.stagedAttachments, [threadId]: attachments },
      attachmentAvailability,
      threadErrors,
    };
  });
  touchDraft(projectPath, threadId, true);
}

/** Capture callers should resolve this at initiation, then reuse it after awaits. */
export function getAgentChatCaptureTarget(projectPath: string): AgentChatCaptureTarget | null {
  const record = ensureRecord(projectPath);
  if (!record.identityVerified || !record.projectId) return null;
  const snapshot = getAgentChatSnapshot(projectPath);
  const threadId = snapshot.selectedThreadId;
  if (threadId) {
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread || thread.status === 'closed') return null;
    return { kind: 'thread', projectPath, threadId, checkoutPath: thread.checkoutPath };
  }
  if (!snapshot.selectedDraftId) return null;
  return {
    kind: 'draft',
    projectPath,
    draftId: snapshot.selectedDraftId,
    checkoutPath: snapshot.selectedCheckoutPath,
  };
}

/** Stage an existing send-to-agent prompt in the currently selected chat draft. */
export function stagePrompt(projectPath: string, text: string): boolean {
  const target = getAgentChatCaptureTarget(projectPath);
  if (!target) return false;
  const snapshot = getAgentChatSnapshot(projectPath);
  const id = target.kind === 'thread' ? target.threadId : target.draftId;
  const existing = snapshot.drafts[id] ?? '';
  setAgentChatDraft(projectPath, id, existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text);
  return true;
}

function resolveCaptureDestinationId(
  snapshot: AgentChatProjectSnapshot,
  target: AgentChatCaptureTarget
): string | null {
  const record = ensureRecord(target.projectPath);
  if (
    record.discardingThreadIds.has(target.kind === 'thread' ? target.threadId : target.draftId) ||
    record.discardedThreadIds.has(target.kind === 'thread' ? target.threadId : target.draftId)
  ) {
    return null;
  }
  if (target.kind === 'thread') {
    const thread = snapshot.threads.find((candidate) => candidate.id === target.threadId);
    return thread && thread.status !== 'closed' && thread.checkoutPath === target.checkoutPath
      ? thread.id
      : null;
  }
  if (snapshot.draftCheckoutPaths[target.draftId] !== target.checkoutPath) return null;
  const boundThreadId = snapshot.draftThreadIds[target.draftId];
  if (!boundThreadId) return target.draftId;
  if (
    record.discardingThreadIds.has(boundThreadId) ||
    record.discardedThreadIds.has(boundThreadId)
  ) {
    return null;
  }
  const thread = snapshot.threads.find((candidate) => candidate.id === boundThreadId);
  return thread && thread.status !== 'closed' && thread.checkoutPath === target.checkoutPath
    ? thread.id
    : null;
}

function isCaptureTargetAvailable(
  snapshot: AgentChatProjectSnapshot,
  target: AgentChatCaptureTarget
): boolean {
  return resolveCaptureDestinationId(snapshot, target) !== null;
}
