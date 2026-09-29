import { AutoScrollLoop } from './autoScroll';
import { collisionAt, containsPoint, rectFromElement, type CollisionResult } from './collision';
import { projectFlatOrder } from './reorder';
import {
  IDLE_DRAG_SORT_SNAPSHOT,
  type DragSortAnnouncements,
  type DragSortAxis,
  type DragSortId,
  type DragSortInsideHold,
  type DragSortInput,
  type DragSortMove,
  type DragSortPlacement,
  type DragSortPoint,
  type DragSortRegistration,
  type DragSortSnapshot,
  type DragSortTarget,
  type DragSortValidator,
} from './types';

type Listener = () => void;
type PointerReleaseListener = (id: DragSortId) => void;
type PointerSource = HTMLElement;
const SETTLE_DURATION_MS = 250;
const INTERACTIVE_DESCENDANT_SELECTOR =
  'button, a, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]';

export interface DragSortManagerOptions {
  axis?: DragSortAxis;
  collision?: 'midpoint' | 'containment' | 'closest-center';
  /** Allow a drag to land on an item registered in another named group. */
  allowCrossGroup?: boolean;
  canMove?: DragSortValidator;
  onMove?: (move: DragSortMove) => void | Promise<void>;
  announcements?: DragSortAnnouncements;
  reducedMotion?: () => boolean;
  /** Feature adapters may provide zone-aware placement for a target. */
  placementForTarget?: (
    target: DragSortTarget,
    point: DragSortPoint,
    axis: DragSortAxis
  ) => DragSortPlacement;
  /** Feature adapters may project a nested order without mutating source state. */
  projectOrder?: (
    order: readonly DragSortId[],
    activeId: DragSortId,
    targetId: DragSortId,
    placement: DragSortPlacement
  ) => readonly DragSortId[];
  /** Report hierarchy changes that do not alter the adapter's flattened order. */
  hasProjectedMove?: (
    activeId: DragSortId,
    targetId: DragSortId,
    placement: DragSortPlacement
  ) => boolean;
  /** Nested adapters can let the parent transform carry its descendants. */
  isPartOfActiveMove?: (activeId: DragSortId, itemId: DragSortId) => boolean;
  /** Pointer users must hold over an inside zone before nesting is armed. */
  insideHoldDelayMs?: number;
  /** Short visual cue between the hold completing and the child slot appearing. */
  insideHoldFlashDurationMs?: number;
}

interface PendingPointer {
  id: DragSortId;
  pointerId: number;
  pointerType: string;
  start: DragSortPoint;
  point: DragSortPoint;
  source: PointerSource;
  timer: number | null;
}

interface ActiveOperation {
  token: number;
  id: DragSortId;
  pointerId: number | null;
  input: DragSortInput;
  source: PointerSource;
  handle: HTMLElement | null;
  fromGroup: DragSortId;
  fromIndex: number;
  sourceOrder: readonly DragSortId[];
  projectedOrder: readonly DragSortId[];
  rects: Map<string, ReturnType<typeof rectFromElement>>;
  sourceRect: ReturnType<typeof rectFromElement>;
  offsetX: number;
  offsetY: number;
  targetId: DragSortId | null;
  placement: DragSortPlacement | null;
}

function idKey(id: DragSortId): string {
  return `${typeof id}:${String(id)}`;
}

function sameId(a: DragSortId | null, b: DragSortId | null): boolean {
  return a !== null && b !== null && idKey(a) === idKey(b);
}

function pointFromEvent(event: PointerEvent): DragSortPoint {
  return { x: event.clientX, y: event.clientY };
}

function isPromise(value: unknown): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === 'function');
}

function defaultReducedMotion(): boolean {
  return Boolean(
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Framework-neutral sortable interaction manager.
 *
 * Registrations are DOM handles and targets; application order is projected
 * immutably and only handed to the feature adapter once a drop is accepted.
 */
export class DragSortManager {
  private options: DragSortManagerOptions;
  private registrations = new Map<string, DragSortRegistration>();
  private listeners = new Set<Listener>();
  private pointerReleaseListeners = new Set<PointerReleaseListener>();
  private itemListeners = new Map<string, Set<Listener>>();
  private snapshot: DragSortSnapshot = IDLE_DRAG_SORT_SNAPSHOT;
  private pending: PendingPointer | null = null;
  private active: ActiveOperation | null = null;
  private autoScroll: AutoScrollLoop | null = null;
  private settleTimer: number | null = null;
  private insideHoldTimer: number | null = null;
  private insideHoldTargetId: DragSortId | null = null;
  private insideHoldToken: number | null = null;
  private destroyed = false;
  private previousBodyCursor = '';
  private previousBodySelection = '';
  private suppressedClick: { key: string; expiresAt: number } | null = null;
  private transitionSuppressedIds = new Set<string>();
  private transitionReleaseFrame: number | null = null;
  /**
   * A settled visual operation can outlive its adapter promise. Keep the
   * promise's failure scoped to that operation so a rapid subsequent drag is
   * never interrupted by an older persistence result.
   */
  private pendingCommit: { token: number; handle: HTMLElement | null; label: string } | null = null;
  private operationToken = 0;

  constructor(options: DragSortManagerOptions = {}) {
    this.options = options;
  }

  setOptions(options: DragSortManagerOptions): void {
    this.options = { ...this.options, ...options };
  }

  getSnapshot = (): DragSortSnapshot => this.snapshot;

  subscribe = (listener: Listener, itemId?: DragSortId): (() => void) => {
    if (itemId === undefined) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    const key = idKey(itemId);
    const itemListeners = this.itemListeners.get(key) ?? new Set<Listener>();
    itemListeners.add(listener);
    this.itemListeners.set(key, itemListeners);
    return () => itemListeners.delete(listener);
  };

  /** Notify item hosts when a pointer drop has been accepted, before cleanup. */
  subscribePointerRelease = (listener: PointerReleaseListener): (() => void) => {
    this.pointerReleaseListeners.add(listener);
    return () => this.pointerReleaseListeners.delete(listener);
  };

  registerItem(registration: DragSortRegistration): () => void {
    // React StrictMode probes an effect by destroying and immediately
    // re-running it. Re-open this otherwise disposable manager when the probe
    // registers its items again; a real unmount has no references left to use.
    if (this.destroyed) this.destroyed = false;
    const key = idKey(registration.id);
    if (this.registrations.has(key)) {
      const error = new Error(`Drag-sort IDs must be unique: ${String(registration.id)}`);
      this.reportError(error.message);
      const isDevelopment = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);
      if (isDevelopment) throw error;
      return () => undefined;
    }
    this.registrations.set(key, { ...registration });
    return () => this.unregisterItem(registration.id);
  }

  updateItem(id: DragSortId, patch: Partial<DragSortRegistration>): void {
    const key = idKey(id);
    const current = this.registrations.get(key);
    if (!current) return;
    const next = { ...current, ...patch, id: current.id };
    const itemStateChanged = (Object.keys(patch) as Array<keyof DragSortRegistration>).some(
      (field) => field !== 'overlay' && !Object.is(current[field], next[field])
    );
    this.registrations.set(key, next);
    // Overlay nodes are presentation content, not item state. Updating one
    // must not fan out to every row (and an inline node may have a fresh
    // identity on each render), while geometry/eligibility changes still wake
    // this item's focused subscription.
    if (itemStateChanged) this.notifyItems([id]);
  }

  unregisterItem(id: DragSortId): void {
    const key = idKey(id);
    if (!this.registrations.delete(key)) return;
    this.itemListeners.delete(key);
    if (this.active && sameId(this.active.id, id)) this.cancel('item unmounted');
  }

  getItem(id: DragSortId): DragSortRegistration | undefined {
    return this.registrations.get(idKey(id));
  }

  /** Re-read live geometry after a consumer expands, scrolls, or resizes. */
  remeasure(): void {
    if (!this.active) return;
    const source = this.getItem(this.active.id)?.element ?? this.active.source;
    this.active.sourceRect = rectFromElement(source);
    this.active.rects = this.measureRects(
      this.active.fromGroup,
      Boolean(this.options.allowCrossGroup)
    );
    if (this.snapshot.point) this.updateActivePoint(this.snapshot.point);
    else {
      this.setSnapshot({ ...this.snapshot, overlayRect: this.overlayRectFromSource(this.active) }, [
        this.active.id,
      ]);
    }
  }

  getProjectedRect(id: DragSortId): ReturnType<typeof rectFromElement> | null {
    if (!this.active || !sameId(this.active.id, id)) return null;
    return this.projectedRects(this.active).get(idKey(id)) ?? null;
  }

  getCrossGroupPlaceholderRect(
    activeId: DragSortId,
    targetId: DragSortId,
    placement: DragSortPlacement
  ): ReturnType<typeof rectFromElement> | null {
    const active = this.active;
    if (!active || !sameId(active.id, activeId)) return null;
    const sourceRect = active.rects.get(idKey(activeId));
    const targetRect = active.rects.get(idKey(targetId));
    const target = this.getItem(targetId);
    if (!sourceRect || !targetRect || !target) return null;
    if (idKey(target.group ?? 'default') === idKey(active.fromGroup)) {
      return this.getProjectedRect(activeId);
    }

    const destinationOrder = this.orderFor(target.group, activeId);
    const destinationIndex = target.index + (placement === 'after' ? 1 : 0);
    const nextId = destinationOrder[destinationIndex];
    const previousId = destinationOrder[destinationIndex - 1];
    const nextRect = nextId === undefined ? undefined : active.rects.get(idKey(nextId));
    const previousRect = previousId === undefined ? undefined : active.rects.get(idKey(previousId));
    // Adjacent targets describe the same insertion index in two ways:
    // "after previous" and "before next". Anchor both to the next row's top
    // so there is only one stable slot between them, even with row gaps.
    const top =
      nextRect?.top ??
      previousRect?.bottom ??
      (target.targetOnly && placement === 'after' ? targetRect.bottom : targetRect.top);
    return {
      left: targetRect.left,
      top,
      right: targetRect.left + sourceRect.width,
      bottom: top + sourceRect.height,
      width: sourceRect.width,
      height: sourceRect.height,
    };
  }

  /**
   * Consume the click generated by a pointer drop. Native click dispatch can
   * happen after a reduced-motion commit has already returned the manager to
   * idle, so the primitive needs a short-lived, explicit signal rather than
   * reading the current phase alone.
   */
  consumeClick(id: DragSortId): boolean {
    const suppressed = this.suppressedClick;
    if (!suppressed) return false;
    if (suppressed.expiresAt < Date.now()) {
      this.suppressedClick = null;
      return false;
    }
    if (suppressed.key !== idKey(id)) return false;
    this.suppressedClick = null;
    return true;
  }

  getItemState(id: DragSortId): {
    isDragging: boolean;
    isTarget: boolean;
    isCrossGroupPlaceholderTarget: boolean;
    hasProjectedMove: boolean;
    projectedIndex: number | null;
    placement: DragSortPlacement | null;
    insideHold: DragSortInsideHold;
    insideSlotHeight: number | null;
    axis: DragSortAxis;
    transform: { x: number; y: number };
    suppressTransition: boolean;
  } {
    const active = this.active;
    const projectedIndex = active
      ? active.projectedOrder.findIndex((item) => sameId(item, id))
      : -1;
    const registration = this.getItem(id);
    const measured = registration ? active?.rects.get(idKey(id)) : undefined;
    const projectedRects = active ? this.projectedRects(active) : undefined;
    const projectedRect = projectedRects?.get(idKey(id));
    const isDragging = Boolean(active && sameId(active.id, id));
    const isCrossGroupPlaceholderTarget = Boolean(
      active &&
      this.snapshot.targetId !== null &&
      sameId(this.snapshot.targetId, id) &&
      idKey(registration?.group ?? 'default') !== idKey(active.fromGroup)
    );
    const isInsideTarget = Boolean(
      this.snapshot.targetId &&
      sameId(this.snapshot.targetId, id) &&
      this.snapshot.placement === 'inside'
    );
    const hasProjectedMove = Boolean(
      active &&
      active.projectedOrder.some((item, index) => !sameId(item, active.sourceOrder[index] ?? null))
    );
    const carriedByActiveParent =
      active && !isDragging && this.options.isPartOfActiveMove?.(active.id, id);
    const crossGroupTransform =
      active && registration ? this.crossGroupTransform(active, registration) : null;
    return {
      isDragging,
      isTarget: Boolean(this.snapshot.targetId && sameId(this.snapshot.targetId, id)),
      isCrossGroupPlaceholderTarget,
      hasProjectedMove,
      projectedIndex: projectedIndex >= 0 ? projectedIndex : null,
      placement:
        this.snapshot.targetId && sameId(this.snapshot.targetId, id)
          ? this.snapshot.placement
          : null,
      insideHold: isInsideTarget ? this.snapshot.insideHold : 'idle',
      insideSlotHeight: isInsideTarget
        ? (active?.rects.get(idKey(active.id))?.height ?? null)
        : null,
      axis: this.options.axis ?? 'vertical',
      suppressTransition: this.transitionSuppressedIds.has(idKey(id)),
      transform: carriedByActiveParent
        ? { x: 0, y: 0 }
        : (crossGroupTransform ?? {
            x:
              measured && projectedRect && this.options.axis === 'horizontal'
                ? projectedRect.left - measured.left
                : 0,
            y:
              measured && projectedRect && this.options.axis !== 'horizontal'
                ? projectedRect.top - measured.top
                : 0,
          }),
    };
  }

  private crossGroupTransform(
    active: ActiveOperation,
    registration: DragSortRegistration
  ): { x: number; y: number } | null {
    const targetId = this.snapshot.targetId;
    const placement = this.snapshot.placement;
    if (
      targetId === null ||
      placement === null ||
      this.snapshot.invalidReason !== null ||
      sameId(active.id, registration.id)
    ) {
      return null;
    }
    const target = this.getItem(targetId);
    if (
      !target ||
      (registration.targetOnly && !registration.crossGroupPlaceholderFollower) ||
      idKey(target.group ?? 'default') === idKey(active.fromGroup) ||
      idKey(registration.group ?? 'default') !== idKey(target.group ?? 'default')
    ) {
      return null;
    }

    const destinationOrder = this.orderFor(target.group, active.id);
    const destinationIndex = target.index + (placement === 'after' ? 1 : 0);
    const itemIndex = registration.crossGroupPlaceholderFollower
      ? registration.index
      : destinationOrder.findIndex((id) => sameId(id, registration.id));
    if (itemIndex < destinationIndex) return null;

    const axis = this.options.axis ?? 'vertical';
    const sourceRect = active.rects.get(idKey(active.id));
    if (!sourceRect) return null;
    const orderedRects = destinationOrder
      .map((id) => active.rects.get(idKey(id)))
      .filter((rect): rect is ReturnType<typeof rectFromElement> => Boolean(rect));
    const gapIndex = Math.min(Math.max(destinationIndex - 1, 0), orderedRects.length - 2);
    const previousRect = gapIndex >= 0 ? orderedRects[gapIndex] : undefined;
    const nextRect = gapIndex >= 0 ? orderedRects[gapIndex + 1] : undefined;
    const gap = Math.max(
      0,
      previousRect && nextRect
        ? axis === 'horizontal'
          ? nextRect.left - previousRect.right
          : nextRect.top - previousRect.bottom
        : 0
    );
    const offset = (axis === 'horizontal' ? sourceRect.width : sourceRect.height) + gap;
    return axis === 'horizontal' ? { x: offset, y: 0 } : { x: 0, y: offset };
  }

  private crossGroupProjectionIds(
    active: ActiveOperation,
    targetId: DragSortId | null
  ): DragSortId[] {
    if (targetId === null) return [];
    const target = this.getItem(targetId);
    if (!target || idKey(target.group ?? 'default') === idKey(active.fromGroup)) {
      return [];
    }
    return [...this.registrations.values()]
      .filter(
        (registration) =>
          idKey(registration.group ?? 'default') === idKey(target.group ?? 'default') &&
          !registration.hidden &&
          (!registration.targetOnly || registration.crossGroupPlaceholderFollower)
      )
      .map((registration) => registration.id);
  }

  private projectedRects(active: ActiveOperation): Map<string, ReturnType<typeof rectFromElement>> {
    const rects = new Map<string, ReturnType<typeof rectFromElement>>();
    const axis = this.options.axis ?? 'vertical';
    const sourceRects = active.sourceOrder
      .map((id) => active.rects.get(idKey(id)))
      .filter((rect): rect is ReturnType<typeof rectFromElement> => Boolean(rect));
    if (sourceRects.length === 0) return rects;
    const gaps = sourceRects.slice(1).map((rect, index) => {
      const previous = sourceRects[index];
      return axis === 'horizontal' ? rect.left - previous.right : rect.top - previous.bottom;
    });
    const first = sourceRects[0];
    let cursor = axis === 'horizontal' ? first.left : first.top;
    active.projectedOrder.forEach((id, index) => {
      const rect = active.rects.get(idKey(id));
      if (!rect) return;
      const next =
        axis === 'horizontal'
          ? {
              ...rect,
              left: cursor,
              right: cursor + rect.width,
            }
          : {
              ...rect,
              top: cursor,
              bottom: cursor + rect.height,
            };
      rects.set(idKey(id), next);
      const gap = gaps[Math.min(index, Math.max(gaps.length - 1, 0))] ?? 0;
      cursor += (axis === 'horizontal' ? rect.width : rect.height) + gap;
    });

    // Target-only registrations are structural surfaces (section headings,
    // action rows, and similar boundaries), not sortable rows. Keep projected
    // siblings on the same side of those surfaces; otherwise a cross-group
    // projection can translate an existing card above its section heading.
    const anchors = [...this.registrations.values()]
      .filter(
        (registration) =>
          idKey(registration.group ?? 'default') === idKey(active.fromGroup) &&
          !registration.hidden &&
          registration.targetOnly
      )
      .flatMap((registration) => {
        const rect = active.rects.get(idKey(registration.id));
        if (!rect) return [];
        const end = axis === 'horizontal' ? rect.right : rect.bottom;
        const firstFollowing = active.sourceOrder
          .map((id) => active.rects.get(idKey(id)))
          .filter((item): item is ReturnType<typeof rectFromElement> => Boolean(item))
          .filter((item) => (axis === 'horizontal' ? item.left : item.top) >= end)
          .sort(
            (a, b) =>
              (axis === 'horizontal' ? a.left : a.top) - (axis === 'horizontal' ? b.left : b.top)
          )[0];
        const firstStart = firstFollowing
          ? axis === 'horizontal'
            ? firstFollowing.left
            : firstFollowing.top
          : end;
        return [{ end, minimum: end + Math.max(0, firstStart - end) }];
      });

    for (const id of active.projectedOrder) {
      if (sameId(id, active.id)) continue;
      const sourceRect = active.rects.get(idKey(id));
      const projectedRect = rects.get(idKey(id));
      if (!sourceRect || !projectedRect) continue;
      const sourceStart = axis === 'horizontal' ? sourceRect.left : sourceRect.top;
      const minimums = anchors
        .filter((anchor) => sourceStart >= anchor.end)
        .map((anchor) => anchor.minimum);
      if (minimums.length === 0) continue;
      const minimum = Math.max(...minimums);
      const projectedStart = axis === 'horizontal' ? projectedRect.left : projectedRect.top;
      if (projectedStart >= minimum) continue;
      const delta = minimum - projectedStart;
      rects.set(
        idKey(id),
        axis === 'horizontal'
          ? {
              ...projectedRect,
              left: projectedRect.left + delta,
              right: projectedRect.right + delta,
            }
          : {
              ...projectedRect,
              top: projectedRect.top + delta,
              bottom: projectedRect.bottom + delta,
            }
      );
    }
    return rects;
  }

  private measureRects(
    group: DragSortId | undefined,
    allGroups = false
  ): Map<string, ReturnType<typeof rectFromElement>> {
    const rects = new Map<string, ReturnType<typeof rectFromElement>>();
    const groupKey = idKey(group ?? 'default');
    for (const registration of this.registrations.values()) {
      if (
        (!allGroups && idKey(registration.group ?? 'default') !== groupKey) ||
        registration.hidden
      )
        continue;
      // A sortable may expose a smaller drop target than its draggable item.
      // This is important for nested trees: the draggable wrapper contains the
      // whole subtree, but only the visible row should participate in collision
      // detection and projected geometry.
      const element = registration.target ?? registration.element;
      if (element) rects.set(idKey(registration.id), rectFromElement(element));
    }
    return rects;
  }

  pointerDown(id: DragSortId, event: PointerEvent, source?: PointerSource): void {
    if (
      this.destroyed ||
      this.pending ||
      this.active ||
      this.snapshot.commitPending ||
      this.pendingCommit
    )
      return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    const registration = this.getItem(id);
    if (!registration || registration.disabled || this.pendingCommit) return;
    const handle = registration.handle;
    if (registration.activation !== 'item' && !handle) return;
    const eventTarget = event.target instanceof Element ? event.target : null;
    if (
      eventTarget &&
      !this.isAllowedPointerTarget(
        eventTarget,
        source ?? registration.element ?? null,
        handle ?? null
      )
    ) {
      return;
    }
    const pointerType = event.pointerType || 'mouse';
    const start = pointFromEvent(event);
    const pending: PendingPointer = {
      id,
      pointerId: event.pointerId,
      pointerType,
      start,
      point: start,
      source:
        source ??
        (registration.activation === 'item'
          ? (registration.element ?? handle)
          : (handle ?? registration.element)) ??
        (event.currentTarget as PointerSource),
      timer: null,
    };
    this.pending = pending;
    this.installPointerListeners();
    if (pointerType === 'touch' || pointerType === 'pen' || pointerType === 'stylus') {
      pending.timer = window.setTimeout(
        () => this.activatePointer(pending.point),
        pointerType === 'touch' ? 250 : 200
      );
    }
    this.setSnapshot(
      {
        ...this.snapshot,
        phase: 'pending',
        activeId: id,
        input: 'pointer',
        point: start,
        error: null,
      },
      [id]
    );
  }

  pointerMove(event: PointerEvent): void {
    if (this.pending) {
      if (this.pending.pointerId !== event.pointerId) return;
      this.pending.point = pointFromEvent(event);
      const tolerance = this.pending.pointerType === 'mouse' ? 4 : 5;
      const distance = Math.hypot(
        this.pending.point.x - this.pending.start.x,
        this.pending.point.y - this.pending.start.y
      );
      if (this.pending.pointerType !== 'mouse' && distance > tolerance) {
        this.clearPending();
        this.resetSnapshot('');
        return;
      }
      if (this.pending.pointerType === 'mouse' && distance >= tolerance) {
        this.activatePointer(this.pending.point, event);
      }
      return;
    }
    if (!this.active || this.active.pointerId !== event.pointerId || this.snapshot.commitPending) {
      return;
    }
    this.updateActivePoint(pointFromEvent(event));
  }

  pointerUp(event: PointerEvent): void {
    if (this.pending && this.pending.pointerId === event.pointerId) {
      this.clearPending();
      this.resetSnapshot('');
      return;
    }
    if (this.active && this.active.pointerId === event.pointerId) this.drop();
  }

  pointerCancel(event?: PointerEvent): void {
    if (event && this.pending && event.pointerId !== this.pending.pointerId) return;
    if (event && this.active && event.pointerId !== this.active.pointerId) return;
    this.cancel('cancelled');
  }

  lostPointerCapture(event: PointerEvent): void {
    if (this.active && this.active.pointerId === event.pointerId) {
      this.cancel('lost pointer capture');
    }
  }

  keyDown(id: DragSortId, event: KeyboardEvent): void {
    const registration = this.getItem(id);
    if (!registration || registration.disabled || this.pendingCommit) return;
    if (!this.active) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      this.activateKeyboard(id);
      return;
    }
    if (!sameId(this.active.id, id) || this.snapshot.commitPending) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel('cancelled');
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.drop();
      return;
    }
    const axis = this.options.axis ?? 'vertical';
    const previous = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const next = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    const insideKey = axis === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const outKey = axis === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    if (
      event.key !== previous &&
      event.key !== next &&
      event.key !== insideKey &&
      event.key !== outKey &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    const order = this.active.projectedOrder;
    const currentIndex = order.findIndex((item) => sameId(item, id));
    if (currentIndex < 0) return;
    let destinationIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? order.length - 1
          : currentIndex + (event.key === next || event.key === insideKey ? 1 : -1);
    const direction = destinationIndex >= currentIndex ? 1 : -1;
    while (destinationIndex >= 0 && destinationIndex < order.length) {
      const targetId = order[destinationIndex];
      if (targetId !== undefined && !sameId(targetId, id)) {
        const target = this.getItem(targetId);
        const placement: DragSortPlacement =
          event.key === insideKey ? 'inside' : destinationIndex < currentIndex ? 'before' : 'after';
        if (this.projectTo(targetId, placement, this.active.input)) return;
        if (!target?.disabled && !target?.targetDisabled) return;
      }
      destinationIndex += direction;
    }
  }

  cancel(reason = 'cancelled'): void {
    if (this.snapshot.commitPending) return;
    const active = this.active;
    this.clearPending();
    this.clearInsideHold();
    this.stopAutoScroll();
    if (!active) {
      this.resetSnapshot('');
      return;
    }
    if (active.input === 'pointer') {
      this.suppressedClick = { key: idKey(active.id), expiresAt: Date.now() + 500 };
      for (const listener of this.pointerReleaseListeners) listener(active.id);
    }
    this.releaseCapture(active);
    this.restoreBodyStyles();
    this.removePointerListeners();
    const label = this.labelOf(active.id);
    const announcement = this.options.announcements?.cancel?.(label) ?? `${label} move cancelled`;
    const reducedMotion = this.isReducedMotion();
    this.setSnapshot(
      {
        ...this.snapshot,
        phase: reducedMotion ? 'idle' : 'cancelling',
        commitPending: !reducedMotion,
        overlayRect: this.overlayRectFromSource(active),
        announcement,
      },
      active.sourceOrder
    );
    if (reducedMotion) this.finishAfterCancel(announcement);
    else {
      this.clearSettleTimer();
      this.settleTimer = window.setTimeout(
        () => this.finishAfterCancel(announcement),
        SETTLE_DURATION_MS
      );
    }
    void reason;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearPending();
    this.clearInsideHold();
    this.clearSettleTimer();
    this.stopAutoScroll();
    if (this.active) this.releaseCapture(this.active);
    this.restoreBodyStyles();
    this.removePointerListeners();
    this.listeners.clear();
    this.pointerReleaseListeners.clear();
    this.itemListeners.clear();
    this.registrations.clear();
    this.active = null;
    this.suppressedClick = null;
    this.pendingCommit = null;
    this.clearTransitionSuppression();
  }

  private activateKeyboard(id: DragSortId): void {
    const registration = this.getItem(id);
    if (!registration) return;
    this.pendingCommit = null;
    const order = this.orderFor(registration.group, id);
    const sourceRect = registration.element
      ? rectFromElement(registration.element)
      : this.emptyRect();
    this.active = {
      token: ++this.operationToken,
      id,
      pointerId: null,
      input: 'keyboard',
      source: registration.element ?? registration.handle ?? document.body,
      handle: this.focusTargetFor(registration),
      fromGroup: registration.group ?? 'default',
      fromIndex: registration.index,
      sourceOrder: order,
      projectedOrder: order,
      rects: this.measureRects(registration.group, Boolean(this.options.allowCrossGroup)),
      sourceRect,
      offsetX: sourceRect.width / 2,
      offsetY: sourceRect.height / 2,
      targetId: null,
      placement: null,
    };
    this.setSnapshot(
      {
        ...this.snapshot,
        phase: 'dragging',
        activeId: id,
        input: 'keyboard',
        projectedOrder: order,
        overlayRect: this.overlayRectFromSource(this.active),
        announcement:
          this.options.announcements?.lift?.(
            this.labelOf(id),
            { group: registration.group ?? 'default', index: registration.index },
            order.length
          ) ?? `${this.labelOf(id)} lifted`,
        invalidReason: null,
        commitPending: false,
        error: null,
      },
      order
    );
  }

  private activatePointer(point: DragSortPoint, event?: PointerEvent): void {
    const pending = this.pending;
    if (!pending || this.active) return;
    const registration = this.getItem(pending.id);
    if (!registration) {
      this.clearPending();
      return;
    }
    this.pendingCommit = null;
    this.clearPendingTimerOnly();
    const source = pending.source;
    const sourceRect = registration.element
      ? rectFromElement(registration.element)
      : rectFromElement(source);
    this.active = {
      token: ++this.operationToken,
      id: pending.id,
      pointerId: pending.pointerId,
      input: 'pointer',
      source,
      handle: this.focusTargetFor(registration) ?? source,
      fromGroup: registration.group ?? 'default',
      fromIndex: registration.index,
      sourceOrder: this.orderFor(registration.group, pending.id),
      projectedOrder: this.orderFor(registration.group, pending.id),
      rects: this.measureRects(registration.group, Boolean(this.options.allowCrossGroup)),
      sourceRect,
      offsetX: pending.start.x - sourceRect.left,
      offsetY: pending.start.y - sourceRect.top,
      targetId: null,
      placement: null,
    };
    this.pending = null;
    try {
      source.setPointerCapture?.(pending.pointerId);
      source.addEventListener('lostpointercapture', this.handleLostCapture);
    } catch {
      // Pointer capture is best-effort in test DOMs and unusual embedded views.
    }
    event?.preventDefault();
    this.saveBodyStyles();
    this.startAutoScroll();
    const label = this.labelOf(pending.id);
    this.setSnapshot(
      {
        ...this.snapshot,
        phase: 'dragging',
        activeId: pending.id,
        input: 'pointer',
        point,
        projectedOrder: this.active.projectedOrder,
        overlayRect: this.overlayRect(point),
        announcement:
          this.options.announcements?.lift?.(
            label,
            { group: registration.group ?? 'default', index: registration.index },
            this.active.sourceOrder.length
          ) ?? `${label} lifted`,
        invalidReason: null,
        commitPending: false,
        error: null,
      },
      this.active.sourceOrder
    );
    this.updateActivePoint(point);
  }

  private updateActivePoint(point: DragSortPoint): void {
    const active = this.active;
    if (!active) return;
    const previousPoint = this.snapshot.point;
    this.setSnapshot({ ...this.snapshot, point, overlayRect: this.overlayRect(point) }, [
      active.id,
    ]);
    void previousPoint;
    const target = this.findCollision(point, active);
    if (!target) {
      const projectedChanged = active.projectedOrder.some(
        (item, index) => !sameId(item, active.sourceOrder[index] ?? null)
      );
      const hadTarget = active.targetId !== null || active.placement !== null;
      const previousCrossGroupItems = this.crossGroupProjectionIds(active, active.targetId);
      active.targetId = null;
      active.placement = null;
      active.projectedOrder = active.sourceOrder;
      this.clearInsideHold();
      if (!projectedChanged && !hadTarget) return;
      this.setSnapshot(
        {
          ...this.snapshot,
          targetId: null,
          placement: null,
          projectedOrder: active.sourceOrder,
          invalidReason: null,
          insideHold: 'idle',
        },
        [...active.sourceOrder, ...previousCrossGroupItems]
      );
      return;
    }
    this.projectTo(target.id, target.placement, active.input);
  }

  private projectTo(
    targetId: DragSortId,
    placement: DragSortPlacement,
    input: DragSortInput,
    bypassInsideHold = false
  ): boolean {
    const active = this.active;
    if (!active) return false;
    const target = this.getItem(targetId);
    if (!target) return false;
    const destination = {
      group: target.group ?? 'default',
      index: target.index + (placement === 'after' ? 1 : 0),
      placement,
    } as const;
    const source = this.getItem(active.id);
    if (!source) return false;
    const context = { active: source, destination, target, input };
    const validation = this.options.canMove?.(destination, context) ?? { allowed: true };
    if (validation === false || (typeof validation === 'object' && !validation.allowed)) {
      const reason =
        typeof validation === 'object' ? validation.reason : 'This destination is unavailable';
      this.clearInsideHold();
      // A candidate is either fully valid or fully invalid. Do not leave the
      // previous optimistic order attached to an invalid target: doing so
      // makes the UI show a valid-looking projection while `drop()` still has
      // enough state to commit the rejected destination.
      active.projectedOrder = active.sourceOrder;
      const changedTarget =
        !sameId(active.targetId, targetId) ||
        active.placement !== placement ||
        this.snapshot.invalidReason !== reason;
      const previousCrossGroupItems = this.crossGroupProjectionIds(active, active.targetId);
      active.targetId = targetId;
      active.placement = placement;
      if (changedTarget) {
        this.setSnapshot(
          {
            ...this.snapshot,
            targetId,
            placement,
            insideHold: 'idle',
            projectedOrder: active.sourceOrder,
            invalidReason: reason,
            announcement:
              this.options.announcements?.invalid?.(this.labelOf(active.id), reason) ??
              `${this.labelOf(active.id)} cannot move there: ${reason}`,
          },
          [active.id, targetId, ...previousCrossGroupItems]
        );
      }
      return false;
    }
    if (
      placement === 'inside' &&
      input === 'pointer' &&
      !bypassInsideHold &&
      (this.options.insideHoldDelayMs ?? 0) > 0
    ) {
      if (
        sameId(active.targetId, targetId) &&
        active.placement === 'inside' &&
        this.snapshot.insideHold !== 'idle'
      ) {
        return false;
      }
      this.beginInsideHold(targetId);
      return false;
    }
    const insideHold = placement === 'inside' && bypassInsideHold ? 'ready' : 'idle';
    this.clearInsideHold();
    const previousTargetId = active.targetId;
    const previousPlacement = active.placement;
    const previousCrossGroupItems = this.crossGroupProjectionIds(active, previousTargetId);
    const nextCrossGroupItems = this.crossGroupProjectionIds(active, targetId);
    const crossesGroup = idKey(destination.group) !== idKey(active.fromGroup);
    const projected =
      target.targetOnly || crossesGroup
        ? [...active.sourceOrder]
        : this.options.projectOrder
          ? [...this.options.projectOrder(active.sourceOrder, active.id, targetId, placement)]
          : projectFlatOrder(active.sourceOrder, active.id, targetId, placement, (item) => item);
    const sameOrder =
      projected.length === active.projectedOrder.length &&
      projected.every((item, index) => sameId(item, active.projectedOrder[index] ?? null));
    active.targetId = targetId;
    active.placement = placement;
    active.projectedOrder = projected;
    if (
      sameOrder &&
      sameId(previousTargetId, targetId) &&
      previousPlacement === placement &&
      this.snapshot.invalidReason === null
    ) {
      return false;
    }
    const index = crossesGroup
      ? destination.index
      : projected.findIndex((item) => sameId(item, active.id));
    const total = crossesGroup ? this.orderFor(destination.group).length + 1 : projected.length;
    const announcement =
      this.options.announcements?.move?.(
        this.labelOf(active.id),
        { group: destination.group, index, placement },
        total,
        this.labelOf(targetId)
      ) ?? `${this.labelOf(active.id)} moved to position ${index + 1} of ${total}`;
    this.setSnapshot(
      {
        ...this.snapshot,
        targetId,
        placement,
        insideHold,
        projectedOrder: projected,
        invalidReason: null,
        announcement,
      },
      [
        ...new Set([
          ...(sameOrder
            ? [active.id, targetId, ...(previousTargetId === null ? [] : [previousTargetId])]
            : active.sourceOrder),
          ...previousCrossGroupItems,
          ...nextCrossGroupItems,
        ]),
      ]
    );
    return !sameOrder;
  }

  private drop(): void {
    const active = this.active;
    if (!active || this.snapshot.commitPending) return;
    const changedOrder =
      active.sourceOrder.length !== active.projectedOrder.length ||
      active.sourceOrder.some((item, index) => !sameId(item, active.projectedOrder[index] ?? null));
    const confirmedInsidePlacement =
      active.placement === 'inside' &&
      this.snapshot.insideHold !== 'pending' &&
      this.snapshot.insideHold !== 'flashing';
    const targetOnly =
      active.targetId !== null && Boolean(this.getItem(active.targetId)?.targetOnly);
    const changedHierarchy =
      active.targetId !== null &&
      active.placement !== null &&
      (active.placement !== 'inside' || confirmedInsidePlacement) &&
      Boolean(this.options.hasProjectedMove?.(active.id, active.targetId, active.placement));
    const changedGroup = Boolean(
      active.targetId !== null &&
      idKey(this.getItem(active.targetId)?.group ?? 'default') !== idKey(active.fromGroup)
    );
    const changed =
      changedOrder || changedHierarchy || confirmedInsidePlacement || targetOnly || changedGroup;
    if (
      !changed ||
      this.snapshot.invalidReason !== null ||
      active.targetId === null ||
      active.placement === null
    ) {
      this.cancel('no valid destination');
      return;
    }
    const registration = this.getItem(active.id);
    if (!registration) {
      this.cancel('item unmounted');
      return;
    }
    const target = this.getItem(active.targetId);
    if (!target) {
      this.cancel('no valid destination');
      return;
    }
    const crossesGroup = idKey(target.group ?? 'default') !== idKey(active.fromGroup);
    const index = crossesGroup
      ? target.index + (active.placement === 'after' ? 1 : 0)
      : active.projectedOrder.findIndex((item) => sameId(item, active.id));
    const destinationTotal = crossesGroup
      ? this.orderFor(target.group).length + 1
      : active.projectedOrder.length;
    const move: DragSortMove = {
      activeId: active.id,
      targetId: active.targetId,
      from: { group: active.fromGroup, index: active.fromIndex },
      to: {
        group: target.group ?? 'default',
        index,
        placement: active.placement,
      },
      input: active.input,
      projectedOrder: active.projectedOrder,
    };
    if (active.input === 'pointer') {
      this.suppressedClick = { key: idKey(active.id), expiresAt: Date.now() + 500 };
      for (const listener of this.pointerReleaseListeners) listener(active.id);
    }
    const settleRect = this.destinationOverlayRect(active);
    this.setSnapshot(
      {
        ...this.snapshot,
        phase: 'dropping',
        commitPending: true,
        overlayRect: settleRect,
        announcement:
          this.options.announcements?.drop?.(this.labelOf(active.id), move.to, destinationTotal) ??
          `${this.labelOf(active.id)} dropped at position ${index + 1} of ${destinationTotal}`,
      },
      [active.id]
    );
    this.stopAutoScroll();
    this.releaseCapture(active);
    this.restoreBodyStyles();
    this.removePointerListeners();
    if (!this.isReducedMotion()) {
      this.clearSettleTimer();
      this.settleTimer = window.setTimeout(() => this.startCommit(move), SETTLE_DURATION_MS);
      return;
    }
    this.startCommit(move);
  }

  private startCommit(move: DragSortMove): void {
    const active = this.active;
    if (!active) return;
    const token = active.token;
    this.pendingCommit = { token, handle: active.handle, label: this.labelOf(active.id) };
    this.clearSettleTimer();
    // The active row is already visually projected into its destination. The
    // adapter now moves its real DOM node there and the manager resets its
    // transform to zero. Keep that layout handoff non-animated for one paint;
    // otherwise the normal reorder transition plays a second, duplicate drop
    // from the newly committed position.
    this.suppressTransitionsThroughCommit(active.sourceOrder);
    let result: void | Promise<void>;
    try {
      result = this.options.onMove?.(move);
    } catch (error) {
      this.commitFailed(error);
      return;
    }
    if (isPromise(result)) {
      // The adapter has already received the optimistic projected order. The
      // overlay's visual settle must finish independently of persistence, so
      // remove the active operation now and only report a later rejection.
      this.finishAfterCommit(this.snapshot.announcement, true);
      result
        .then(() => this.commitSucceeded(token))
        .catch((error: unknown) => this.commitFailedAfterCleanup(token, error));
    } else {
      this.commitSucceeded(token);
    }
  }

  private commitSucceeded(token?: number): void {
    if (token !== undefined && this.pendingCommit?.token !== token) return;
    if (token !== undefined) this.pendingCommit = null;
    if (!this.active) {
      this.setSnapshot({ ...this.snapshot, commitPending: false }, []);
      return;
    }
    this.finishAfterCommit(this.snapshot.announcement);
  }

  private commitFailed(error: unknown): void {
    const active = this.active;
    if (!active) return;
    this.pendingCommit = null;
    const reason = error instanceof Error ? error.message : String(error);
    const announcement =
      this.options.announcements?.error?.(this.labelOf(active.id), reason) ??
      `${this.labelOf(active.id)} could not be moved: ${reason}`;
    this.clearSettleTimer();
    this.active = null;
    this.stopAutoScroll();
    this.releaseCapture(active);
    this.restoreBodyStyles();
    this.removePointerListeners();
    active.handle?.focus({ preventScroll: true });
    this.setSnapshot({ ...IDLE_DRAG_SORT_SNAPSHOT, announcement, error: reason }, []);
  }

  private commitFailedAfterCleanup(token: number, error: unknown): void {
    const pending = this.pendingCommit;
    if (!pending || pending.token !== token) return;
    this.pendingCommit = null;
    const reason = error instanceof Error ? error.message : String(error);
    const announcement =
      this.options.announcements?.error?.(pending.label, reason) ??
      `${pending.label} could not be moved: ${reason}`;
    pending.handle?.focus({ preventScroll: true });
    this.setSnapshot({ ...this.snapshot, commitPending: false, announcement, error: reason }, []);
  }

  private finishAfterCommit(announcement: string, commitPending = false): void {
    const active = this.active;
    if (!active) return;
    this.clearSettleTimer();
    this.stopAutoScroll();
    this.releaseCapture(active);
    this.restoreBodyStyles();
    this.removePointerListeners();
    this.active = null;
    active.handle?.focus({ preventScroll: true });
    this.setSnapshot({ ...IDLE_DRAG_SORT_SNAPSHOT, commitPending, announcement }, []);
  }

  private finishAfterCancel(announcement: string): void {
    const active = this.active;
    if (!active) return;
    this.clearSettleTimer();
    this.active = null;
    active.handle?.focus({ preventScroll: true });
    this.setSnapshot({ ...IDLE_DRAG_SORT_SNAPSHOT, announcement }, []);
  }

  private findCollision(point: DragSortPoint, active: ActiveOperation): CollisionResult | null {
    const placeholderTarget = this.placeholderCollision(point, active);
    if (placeholderTarget) return placeholderTarget;

    const activeRegistration = this.getItem(active.id);
    const targets: DragSortTarget[] = [...this.registrations.values()]
      .filter(
        (registration) =>
          !sameId(registration.id, active.id) &&
          !this.isCarriedByActive(active.id, registration.id) &&
          (this.options.allowCrossGroup || (registration.group ?? 'default') === active.fromGroup)
      )
      .flatMap((registration) => {
        const element = registration.target ?? registration.element;
        const measured = active.rects.get(idKey(registration.id));
        return element
          ? [
              {
                id: registration.id,
                group: registration.group ?? 'default',
                // Collisions use the captured geometry. Reading a sibling's
                // already-transformed DOM rect would move the target zone
                // underneath the pointer as projection updates, causing
                // jitter and making quarter-zone thresholds non-deterministic.
                rect: measured ?? rectFromElement(element),
                ...(registration.hidden === undefined ? {} : { hidden: registration.hidden }),
                ...(registration.targetDisabled === undefined
                  ? {}
                  : { disabled: registration.targetDisabled }),
                ...(registration.targetOnly === undefined
                  ? {}
                  : { targetOnly: registration.targetOnly }),
                ...(registration.collisionPriority === undefined
                  ? {}
                  : { priority: registration.collisionPriority }),
                ...(registration.type === undefined ? {} : { type: registration.type }),
                ...(registration.acceptedTypes === undefined
                  ? {}
                  : { acceptedTypes: registration.acceptedTypes }),
              },
            ]
          : [];
      })
      .filter(
        (target) =>
          !target.acceptedTypes ||
          !activeRegistration?.type ||
          target.acceptedTypes.includes(activeRegistration.type)
      );
    if (targets.length === 0) return null;
    const crossAxis =
      this.options.axis === 'horizontal'
        ? targets.some(
            (target) => point.y >= target.rect.top - 24 && point.y <= target.rect.bottom + 24
          )
        : targets.some(
            (target) => point.x >= target.rect.left - 24 && point.x <= target.rect.right + 24
          );
    if (!crossAxis) return null;
    const result = collisionAt(
      targets,
      point,
      this.options.axis ?? 'vertical',
      this.options.collision ?? 'midpoint'
    );
    if (!result) return null;
    const resultTarget = targets.find((target) => sameId(target.id, result.id));
    if (resultTarget && this.options.placementForTarget) {
      result.placement = this.options.placementForTarget(
        resultTarget,
        point,
        this.options.axis ?? 'vertical'
      );
    }
    const axisCoordinate = this.options.axis === 'horizontal' ? point.x : point.y;
    const min =
      Math.min(
        ...targets.map((target) =>
          this.options.axis === 'horizontal' ? target.rect.left : target.rect.top
        )
      ) - 24;
    const max =
      Math.max(
        ...targets.map((target) =>
          this.options.axis === 'horizontal' ? target.rect.right : target.rect.bottom
        )
      ) + 24;
    return axisCoordinate < min || axisCoordinate > max ? null : result;
  }

  private beginInsideHold(targetId: DragSortId): void {
    const active = this.active;
    if (!active) return;
    this.clearInsideHold();
    active.targetId = targetId;
    active.placement = 'inside';
    active.projectedOrder = active.sourceOrder;
    this.insideHoldTargetId = targetId;
    this.insideHoldToken = active.token;
    this.setSnapshot(
      {
        ...this.snapshot,
        targetId,
        placement: 'inside',
        insideHold: 'pending',
        projectedOrder: active.sourceOrder,
        invalidReason: null,
        announcement: `Hold to place ${this.labelOf(active.id)} inside ${this.labelOf(targetId)}`,
      },
      active.sourceOrder
    );

    const delay = Math.max(0, this.options.insideHoldDelayMs ?? 0);
    this.insideHoldTimer = window.setTimeout(() => {
      if (!this.isCurrentInsideHold(active, targetId)) return;
      this.setSnapshot(
        {
          ...this.snapshot,
          insideHold: 'flashing',
          announcement: `Release to place ${this.labelOf(active.id)} inside ${this.labelOf(targetId)}`,
        },
        [active.id, targetId]
      );
      const flashDuration = Math.max(0, this.options.insideHoldFlashDurationMs ?? 150);
      this.insideHoldTimer = window.setTimeout(() => {
        if (!this.isCurrentInsideHold(active, targetId)) return;
        this.insideHoldTimer = null;
        this.insideHoldTargetId = null;
        this.insideHoldToken = null;
        this.setSnapshot(
          {
            ...this.snapshot,
            insideHold: 'ready',
          },
          [active.id, targetId]
        );
        this.projectTo(targetId, 'inside', active.input, true);
      }, flashDuration);
    }, delay);
  }

  private isCurrentInsideHold(active: ActiveOperation, targetId: DragSortId): boolean {
    return Boolean(
      this.active &&
      this.active.token === active.token &&
      sameId(this.active.id, active.id) &&
      sameId(this.insideHoldTargetId, targetId) &&
      this.insideHoldToken === active.token &&
      this.snapshot.phase === 'dragging'
    );
  }

  /**
   * Optimistic sorting moves the active row into the projected order, leaving
   * an empty row at its destination. Keep that slot as the active drop target
   * while the pointer is over it, just like dnd-kit's source-as-target model.
   * Otherwise collision detection still sees the captured pre-drag rows and
   * makes the pointer leave the visible drop zone before the move can stick.
   */
  private placeholderCollision(
    point: DragSortPoint,
    active: ActiveOperation
  ): CollisionResult | null {
    if (
      active.targetId === null ||
      active.placement === null ||
      this.snapshot.invalidReason !== null
    ) {
      return null;
    }
    const currentTarget = this.getItem(active.targetId);
    if (
      this.options.allowCrossGroup &&
      currentTarget &&
      idKey(currentTarget.group ?? 'default') !== idKey(active.fromGroup)
    ) {
      return null;
    }
    const hasProjectedMove = active.projectedOrder.some(
      (item, index) => !sameId(item, active.sourceOrder[index] ?? null)
    );
    if (!hasProjectedMove) return null;
    const projectedRect = this.projectedRects(active).get(idKey(active.id));
    if (!projectedRect || !containsPoint(projectedRect, point)) return null;
    return {
      id: active.targetId,
      placement: active.placement,
      distance: 0,
      priority: this.getItem(active.targetId)?.collisionPriority ?? 0,
    };
  }

  private orderFor(group: DragSortId | undefined, activeId?: DragSortId): readonly DragSortId[] {
    const groupKey = idKey(group ?? 'default');
    return [...this.registrations.values()]
      .filter(
        (registration) =>
          idKey(registration.group ?? 'default') === groupKey &&
          !registration.hidden &&
          !registration.targetOnly &&
          (activeId === undefined || !this.isCarriedByActive(activeId, registration.id))
      )
      .sort((a, b) => a.index - b.index)
      .map((registration) => registration.id);
  }

  /** Nested adapters can collapse a dragged subtree into its parent row. */
  private isCarriedByActive(activeId: DragSortId, itemId: DragSortId): boolean {
    return (
      !sameId(activeId, itemId) && Boolean(this.options.isPartOfActiveMove?.(activeId, itemId))
    );
  }

  private labelOf(id: DragSortId): string {
    return this.getItem(id)?.label ?? String(id);
  }

  private overlayRect(point: DragSortPoint) {
    const active = this.active;
    if (!active) return null;
    const { sourceRect, offsetX, offsetY } = active;
    return {
      left: point.x - offsetX,
      top: point.y - offsetY,
      right: point.x - offsetX + sourceRect.width,
      bottom: point.y - offsetY + sourceRect.height,
      width: sourceRect.width,
      height: sourceRect.height,
      offsetX,
      offsetY,
    };
  }

  private overlayRectFromSource(active: ActiveOperation) {
    return {
      ...active.sourceRect,
      offsetX: active.offsetX,
      offsetY: active.offsetY,
    };
  }

  private destinationOverlayRect(active: ActiveOperation) {
    const target = active.targetId === null ? undefined : this.getItem(active.targetId);
    if (
      target &&
      idKey(target.group ?? 'default') !== idKey(active.fromGroup) &&
      this.snapshot.overlayRect
    ) {
      return this.snapshot.overlayRect;
    }
    const destination = this.projectedRects(active).get(idKey(active.id));
    if (!destination) return this.snapshot.overlayRect ?? this.overlayRectFromSource(active);
    return {
      ...destination,
      offsetX: active.offsetX,
      offsetY: active.offsetY,
    };
  }

  private isReducedMotion(): boolean {
    return this.options.reducedMotion?.() ?? defaultReducedMotion();
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private suppressTransitionsThroughCommit(ids: readonly DragSortId[]): void {
    this.clearTransitionSuppression();
    for (const id of ids) this.transitionSuppressedIds.add(idKey(id));
    this.notifyItems(ids);
    this.transitionReleaseFrame = window.requestAnimationFrame(() => {
      this.transitionReleaseFrame = window.requestAnimationFrame(() => {
        this.transitionReleaseFrame = null;
        this.transitionSuppressedIds.clear();
        this.notifyItems(ids);
      });
    });
  }

  private clearTransitionSuppression(): void {
    if (this.transitionReleaseFrame !== null) {
      window.cancelAnimationFrame(this.transitionReleaseFrame);
      this.transitionReleaseFrame = null;
    }
    this.transitionSuppressedIds.clear();
  }

  private emptyRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  private isAllowedPointerTarget(
    target: Element,
    source: Element | null,
    handle: Element | null
  ): boolean {
    if (handle && (target === handle || handle.contains(target))) return true;
    if (source && target === source) return true;
    const interactiveTarget = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
    if (interactiveTarget && interactiveTarget !== source) {
      return false;
    }
    return Boolean(source?.contains(target));
  }

  /** The active item's focus target follows its activation variant. */
  private focusTargetFor(registration: DragSortRegistration): HTMLElement | null {
    return registration.activation === 'item'
      ? (registration.element ?? registration.handle ?? null)
      : (registration.handle ?? null);
  }

  private installPointerListeners(): void {
    window.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    window.addEventListener('blur', this.handleWindowBlur);
    window.addEventListener('resize', this.handleWindowResize);
  }

  private removePointerListeners(): void {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('blur', this.handleWindowBlur);
    window.removeEventListener('resize', this.handleWindowResize);
  }

  private handlePointerMove = (event: PointerEvent) => {
    this.pointerMove(event);
    if (this.active) event.preventDefault();
  };

  private handlePointerUp = (event: PointerEvent) => this.pointerUp(event);
  private handlePointerCancel = (event: PointerEvent) => this.pointerCancel(event);
  private handleLostCapture = (event: Event) => this.lostPointerCapture(event as PointerEvent);
  private handleWindowBlur = () => this.cancel('window blurred');
  private handleWindowResize = () => this.remeasure();

  private clearPendingTimerOnly(): void {
    if (!this.pending) return;
    if (this.pending.timer !== null) window.clearTimeout(this.pending.timer);
    this.pending.timer = null;
  }

  private clearInsideHold(): void {
    if (this.insideHoldTimer !== null) window.clearTimeout(this.insideHoldTimer);
    this.insideHoldTimer = null;
    this.insideHoldTargetId = null;
    this.insideHoldToken = null;
  }

  private clearPending(): void {
    this.clearPendingTimerOnly();
    this.pending = null;
  }

  private saveBodyStyles(): void {
    this.previousBodyCursor = document.body.style.cursor;
    this.previousBodySelection = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  private restoreBodyStyles(): void {
    document.body.style.cursor = this.previousBodyCursor;
    document.body.style.userSelect = this.previousBodySelection;
  }

  private releaseCapture(active: ActiveOperation): void {
    if (active.pointerId === null) return;
    try {
      active.source.removeEventListener('lostpointercapture', this.handleLostCapture);
      if (active.source.hasPointerCapture?.(active.pointerId)) {
        active.source.releasePointerCapture?.(active.pointerId);
      }
    } catch {
      // Embedded frames and jsdom can reject release after a cancelled pointer.
    }
  }

  private startAutoScroll(): void {
    if (!this.active) return;
    this.autoScroll = new AutoScrollLoop({
      getElement: () => this.active?.source ?? null,
      getPoint: () => this.snapshot.point,
      onScroll: () => {
        if (this.active && this.snapshot.point) {
          this.active.rects = this.measureRects(this.active.fromGroup);
          this.updateActivePoint(this.snapshot.point);
        }
      },
    });
    this.autoScroll.start();
  }

  private stopAutoScroll(): void {
    this.autoScroll?.stop();
    this.autoScroll = null;
  }

  private resetSnapshot(announcement: string): void {
    this.setSnapshot({ ...IDLE_DRAG_SORT_SNAPSHOT, announcement }, []);
    this.removePointerListeners();
  }

  reportError(message: string): void {
    this.setSnapshot({ ...IDLE_DRAG_SORT_SNAPSHOT, error: message, announcement: message }, []);
  }

  private setSnapshot(next: DragSortSnapshot, itemIds: readonly DragSortId[]): void {
    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) listener();
    const changed = new Set(itemIds.map(idKey));
    for (const [key, listeners] of this.itemListeners) {
      if (changed.size > 0 && !changed.has(key)) continue;
      for (const listener of listeners) listener();
    }
  }

  private notifyItems(ids: readonly DragSortId[]): void {
    const changed = new Set(ids.map(idKey));
    for (const [key, listeners] of this.itemListeners) {
      if (!changed.has(key)) continue;
      for (const listener of listeners) listener();
    }
  }
}
