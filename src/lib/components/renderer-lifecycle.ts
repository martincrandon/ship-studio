import { COMPONENT_CANVAS_MAX_LIVE_FRAMES, type ComponentCanvasNode } from './canvas';
import { selectLiveRendererFrames, type RendererScheduleCandidate } from './renderer-scheduler';

/** The UI state of a frame, kept separate from the frame's saved canvas data. */
export type RendererFrameStatus =
  | 'queued'
  | 'live'
  | 'cached'
  | 'placeholder'
  | 'error'
  | 'suspended';

export interface RendererLifecycleCandidate extends RendererScheduleCandidate {
  /** The exact snapshot key the current frame inputs require, if known. */
  snapshotKey?: string;
  /** A cache hit is valid only when this key equals snapshotKey. */
  cachedSnapshotKey?: string;
}

export interface RendererFrameState {
  nodeId: string;
  status: RendererFrameStatus;
  snapshotKey: string | null;
  failureCount: number;
  retryNonce: number;
  circuitOpen: boolean;
}

export interface RendererLifecycleSnapshot {
  activeFrameId: string | null;
  liveFrameIds: string[];
  queuedFrameIds: string[];
  frames: RendererFrameState[];
}

/**
 * A snapshot commit may outlive the scheduler's live slot only for normal
 * eviction. Retries, invalidation, and queued reloads must never publish the
 * pixels captured by the older renderer surface.
 */
export function rendererSnapshotCommitIsCurrent(
  state: RendererFrameState | null,
  snapshotKey: string,
  retryNonce: number
): boolean {
  return (
    state !== null &&
    state.snapshotKey === snapshotKey &&
    state.retryNonce === retryNonce &&
    (state.status === 'live' || state.status === 'suspended')
  );
}

export interface RendererFrameLifecycleOptions {
  liveLimit?: number;
  /** Keep already-live frames mounted while another frame is promoted. */
  retainLiveFrames?: boolean;
  failureThreshold?: number;
  circuitResetMs?: number;
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;

interface MutableFrameState extends RendererFrameState {
  lastFailureAt: number | null;
  requested: boolean;
}

/**
 * Coordinates frame scheduling without owning React state or DOM nodes.
 *
 * The canvas can therefore keep layout/preset persistence independent from
 * renderer churn. A request is considered live only after the host handshake
 * calls markLive; selecting a node merely queues it.
 */
export class RendererFrameLifecycle {
  private readonly liveLimit: number;
  private readonly retainLiveFrames: boolean;
  private readonly failureThreshold: number;
  private readonly circuitResetMs: number;
  private readonly now: () => number;
  private readonly frames = new Map<string, MutableFrameState>();
  private candidates = new Map<string, RendererLifecycleCandidate>();
  private cancelledRequestIds: string[] = [];
  private activeFrameId: string | null = null;

  constructor(options: RendererFrameLifecycleOptions = {}) {
    this.liveLimit = Math.max(
      1,
      Math.min(
        options.liveLimit ?? COMPONENT_CANVAS_MAX_LIVE_FRAMES,
        COMPONENT_CANVAS_MAX_LIVE_FRAMES
      )
    );
    this.retainLiveFrames = options.retainLiveFrames ?? false;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.circuitResetMs = Math.max(1, options.circuitResetMs ?? DEFAULT_CIRCUIT_RESET_MS);
    this.now = options.now ?? Date.now;
  }

  /** Recomputes the bounded live set and returns newly queued frame IDs. */
  setCandidates(candidates: readonly RendererLifecycleCandidate[]): string[] {
    const previousCandidates = this.candidates;
    const previouslyLiveIds = new Set(
      [...this.frames.values()]
        .filter((frame) => frame.status === 'live')
        .map((frame) => frame.nodeId)
    );
    this.candidates = new Map(candidates.map((candidate) => [candidate.node.id, candidate]));
    const liveIds = new Set(
      this.retainLiveFrames
        ? prioritizeRetainedCandidates(candidates, previouslyLiveIds)
            .slice(0, this.liveLimit)
            .map((candidate) => candidate.node.id)
        : selectLiveRendererFrames(candidates, this.liveLimit)
    );
    const queued: string[] = [];

    for (const [nodeId, candidate] of this.candidates) {
      const frame = this.ensureFrame(nodeId, candidate.snapshotKey ?? null);
      const previousCandidate = previousCandidates.get(nodeId);
      const revisionChanged =
        !!previousCandidate && previousCandidate.snapshotKey !== candidate.snapshotKey;
      if (revisionChanged && frame.requested) {
        this.recordCancellation(nodeId);
        frame.requested = false;
      }
      if (revisionChanged) {
        if (frame.status === 'live' || frame.status === 'error') frame.status = 'placeholder';
        // A failure belongs to the exact render inputs that produced it. A
        // source, props, or presentation change gets a clean render attempt.
        frame.failureCount = 0;
        frame.lastFailureAt = null;
        frame.circuitOpen = false;
      }
      frame.snapshotKey = candidate.snapshotKey ?? null;
      const circuitOpen = this.isCircuitOpen(frame);
      frame.circuitOpen = circuitOpen;

      if (circuitOpen) {
        frame.status = 'error';
        frame.requested = false;
        continue;
      }

      // An unsuccessful frame stays out of the live set until the user asks
      // for a retry or its render inputs change. Requeueing it here used to
      // produce a permanent loading card when the iframe handshake could not
      // be restarted with a new retry nonce.
      if (frame.status === 'error') {
        frame.requested = false;
        continue;
      }

      if (liveIds.has(nodeId)) {
        if (frame.status !== 'live') {
          frame.status = 'queued';
          if (!frame.requested) queued.push(nodeId);
          frame.requested = true;
        }
        continue;
      }

      this.evictFrame(frame, candidate);
    }

    for (const [nodeId, frame] of this.frames) {
      const nextCandidate = this.candidates.get(nodeId);
      if (nextCandidate) {
        continue;
      }
      this.evictFrame(frame, undefined);
    }

    return queued;
  }

  setActiveFrame(nodeId: string | null): { previous: string | null; active: string | null } {
    const previous = this.activeFrameId;
    this.activeFrameId = nodeId && this.candidates.has(nodeId) ? nodeId : null;
    if (previous && previous !== this.activeFrameId) {
      const previousFrame = this.frames.get(previous);
      if (previousFrame?.requested) {
        this.recordCancellation(previous);
        previousFrame.requested = false;
        if (previousFrame.status === 'queued') previousFrame.status = 'suspended';
      }
    }
    if (this.activeFrameId) {
      const frame = this.ensureFrame(
        this.activeFrameId,
        this.candidates.get(this.activeFrameId)?.snapshotKey ?? null
      );
      frame.requested = frame.status !== 'error';
      if (!frame.circuitOpen && frame.status !== 'live' && frame.status !== 'error') {
        frame.status = 'queued';
      }
      this.enforceBudget(this.activeFrameId);
    }
    return { previous, active: this.activeFrameId };
  }

  markLive(nodeId: string): boolean {
    const frame = this.frames.get(nodeId);
    // A handshake from an evicted request is stale. Accepting it would allow
    // an iframe to re-enter the live pool after the scheduler has freed its
    // slot, defeating the hard budget.
    if (
      !frame ||
      frame.circuitOpen ||
      !this.candidates.has(nodeId) ||
      (!frame.requested && frame.status !== 'live')
    )
      return false;
    this.enforceBudget(nodeId);
    if (!frame.requested && frame.status !== 'live') return false;
    frame.status = 'live';
    frame.requested = false;
    return true;
  }

  markSnapshot(nodeId: string, snapshotKey: string): boolean {
    const candidate = this.candidates.get(nodeId);
    const frame = this.frames.get(nodeId);
    if (!candidate || !frame || !candidate.snapshotKey || candidate.snapshotKey !== snapshotKey) {
      return false;
    }
    // Capturing a poster is orthogonal to renderer residency. If the selected
    // frame is still live (or has a live request in flight), changing it to
    // `cached` would hide its iframe without causing the publish effect to
    // reload it—the same publish key is already recorded. Let normal candidate
    // scheduling evict it only when it actually leaves the live set.
    if (frame.status === 'live' || frame.status === 'error' || frame.requested) return true;
    frame.status = 'cached';
    return true;
  }

  markError(nodeId: string): RendererFrameState | null {
    const frame = this.frames.get(nodeId);
    if (!frame) return null;
    frame.failureCount += 1;
    frame.lastFailureAt = this.now();
    frame.circuitOpen = frame.failureCount >= this.failureThreshold;
    frame.status = 'error';
    frame.requested = false;
    return this.readFrame(frame);
  }

  /** Clears a component/session circuit and queues one bounded retry. */
  retry(nodeId: string): boolean {
    const frame = this.frames.get(nodeId);
    if (!frame || !this.candidates.has(nodeId)) return false;
    frame.failureCount = 0;
    frame.lastFailureAt = null;
    frame.circuitOpen = false;
    frame.retryNonce += 1;
    frame.status = 'queued';
    frame.requested = true;
    this.enforceBudget(nodeId);
    return true;
  }

  cancel(nodeId: string): boolean {
    const frame = this.frames.get(nodeId);
    if (!frame) return false;
    if (frame.requested || frame.status === 'live') this.recordCancellation(nodeId);
    frame.requested = false;
    if (frame.status === 'queued' || frame.status === 'live') {
      const candidate = this.candidates.get(nodeId);
      frame.status = candidate && hasExactSnapshot(candidate) ? 'cached' : 'suspended';
    }
    return true;
  }

  /** Marks render results and editor selections stale without moving frames. */
  invalidate(nodeIds?: readonly string[]): void {
    const ids = nodeIds ?? [...this.frames.keys()];
    for (const nodeId of ids) {
      const frame = this.frames.get(nodeId);
      if (!frame || frame.status === 'error') continue;
      if (frame.requested || frame.status === 'live') this.recordCancellation(nodeId);
      frame.status = 'placeholder';
      frame.requested = false;
    }
  }

  /** Returns and clears queued request IDs cancelled by the latest state change. */
  consumeCancelledRequestIds(): string[] {
    const cancelled = [...this.cancelledRequestIds];
    this.cancelledRequestIds = [];
    return cancelled;
  }

  stateFor(nodeId: string): RendererFrameState | null {
    const frame = this.frames.get(nodeId);
    return frame ? this.readFrame(frame) : null;
  }

  snapshot(): RendererLifecycleSnapshot {
    const frames = [...this.frames.values()].map((frame) => this.readFrame(frame));
    return {
      activeFrameId: this.activeFrameId,
      liveFrameIds: frames.filter((frame) => frame.status === 'live').map((frame) => frame.nodeId),
      queuedFrameIds: frames
        .filter((frame) => frame.status === 'queued')
        .map((frame) => frame.nodeId),
      frames,
    };
  }

  private ensureFrame(nodeId: string, snapshotKey: string | null): MutableFrameState {
    const existing = this.frames.get(nodeId);
    if (existing) return existing;
    const frame: MutableFrameState = {
      nodeId,
      status: 'placeholder',
      snapshotKey,
      failureCount: 0,
      retryNonce: 0,
      circuitOpen: false,
      lastFailureAt: null,
      requested: false,
    };
    this.frames.set(nodeId, frame);
    return frame;
  }

  private isCircuitOpen(frame: MutableFrameState): boolean {
    if (!frame.circuitOpen) return false;
    if (frame.lastFailureAt !== null && this.now() - frame.lastFailureAt >= this.circuitResetMs) {
      frame.failureCount = 0;
      frame.lastFailureAt = null;
      frame.circuitOpen = false;
      return false;
    }
    return true;
  }

  private readFrame(frame: MutableFrameState): RendererFrameState {
    return {
      nodeId: frame.nodeId,
      status: frame.status,
      snapshotKey: frame.snapshotKey,
      failureCount: frame.failureCount,
      retryNonce: frame.retryNonce,
      circuitOpen: frame.circuitOpen,
    };
  }

  private recordCancellation(nodeId: string): void {
    if (this.cancelledRequestIds.includes(nodeId)) return;
    this.cancelledRequestIds.push(nodeId);
    if (this.cancelledRequestIds.length > COMPONENT_CANVAS_MAX_LIVE_FRAMES * 2) {
      this.cancelledRequestIds.shift();
    }
  }

  /** Evict a live/queued frame and release its iframe/request slot. */
  private evictFrame(
    frame: MutableFrameState,
    candidate: RendererLifecycleCandidate | undefined
  ): void {
    if (frame.requested || frame.status === 'live') this.recordCancellation(frame.nodeId);
    frame.requested = false;
    frame.status = candidate && hasExactSnapshot(candidate) ? 'cached' : 'suspended';
  }

  /**
   * Guard imperative paths (`setActiveFrame`, retry, and late handshakes) that
   * can otherwise add a request after the normal candidate reconciliation.
   */
  private enforceBudget(preferredNodeId: string | null = null): void {
    const occupying = [...this.frames.values()].filter(
      (frame) =>
        (frame.status === 'live' || (frame.status === 'queued' && frame.requested)) &&
        this.candidates.has(frame.nodeId)
    );
    if (occupying.length <= this.liveLimit) return;
    const ranked = occupying
      .map((frame) => ({ frame, candidate: this.candidates.get(frame.nodeId) }))
      .sort((left, right) => {
        if (left.frame.nodeId === preferredNodeId) return -1;
        if (right.frame.nodeId === preferredNodeId) return 1;
        if (left.frame.status !== right.frame.status) {
          // Keep live frames when possible; queued work is the first thing
          // evicted if an imperative request temporarily overfills the pool.
          return left.frame.status === 'live' ? -1 : 1;
        }
        return compareCandidates(left.candidate, right.candidate);
      });
    for (const entry of ranked.slice(this.liveLimit)) {
      this.evictFrame(entry.frame, entry.candidate);
    }
  }
}

function compareCandidates(
  left: RendererLifecycleCandidate | undefined,
  right: RendererLifecycleCandidate | undefined
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return (
    Number(right.selected) - Number(left.selected) ||
    right.recentlyUsedAt - left.recentlyUsedAt ||
    Number(right.needsSnapshot) - Number(left.needsSnapshot) ||
    Number(right.visible) - Number(left.visible) ||
    left.distanceToViewportCenter - right.distanceToViewportCenter ||
    left.node.id.localeCompare(right.node.id)
  );
}

function prioritizeRetainedCandidates(
  candidates: readonly RendererLifecycleCandidate[],
  previouslyLiveIds: ReadonlySet<string>
): RendererLifecycleCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      Number(right.selected) - Number(left.selected) ||
      right.recentlyUsedAt - left.recentlyUsedAt ||
      Number(right.needsSnapshot) - Number(left.needsSnapshot) ||
      Number(previouslyLiveIds.has(right.node.id)) - Number(previouslyLiveIds.has(left.node.id)) ||
      Number(right.visible) - Number(left.visible) ||
      left.distanceToViewportCenter - right.distanceToViewportCenter ||
      left.node.id.localeCompare(right.node.id)
  );
}

function hasExactSnapshot(candidate: RendererLifecycleCandidate): boolean {
  return (
    typeof candidate.snapshotKey === 'string' &&
    candidate.snapshotKey.length > 0 &&
    candidate.cachedSnapshotKey === candidate.snapshotKey
  );
}

/** Keeps the node import visible to consumers that build lifecycle candidates. */
export type RendererLifecycleNode = ComponentCanvasNode;
