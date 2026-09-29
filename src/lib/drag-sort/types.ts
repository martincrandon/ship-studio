/** Framework-neutral types shared by the drag-sort engine and adapters. */

export type DragSortId = string | number;
export type DragSortInput = 'pointer' | 'keyboard';
export type DragSortAxis = 'vertical' | 'horizontal';
export type DragSortPlacement = 'before' | 'inside' | 'after';
export type DragSortActivation = 'handle' | 'item';
export type DragSortInsideHold = 'idle' | 'pending' | 'flashing' | 'ready';

export interface DragSortPosition {
  group: DragSortId;
  index: number;
  placement?: DragSortPlacement;
}

export interface DragSortMove {
  activeId: DragSortId;
  /** The live collision anchor at drop time, when there is one. */
  targetId?: DragSortId;
  from: DragSortPosition;
  to: DragSortPosition;
  input: DragSortInput;
  /** Source-group projection; cross-group adapters use `from`, `to`, and `activeId`. */
  projectedOrder?: readonly DragSortId[];
}

/** A DOMRect-shaped value that is easy to construct in browser and unit tests. */
export interface DragSortRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DragSortTarget {
  id: DragSortId;
  group: DragSortId;
  rect: DragSortRect;
  hidden?: boolean;
  disabled?: boolean;
  /** A locked item may not be lifted but can still be a drop target. */
  targetDisabled?: boolean;
  /** A drop surface that should not participate in projected ordering. */
  targetOnly?: boolean;
  /** Higher priority wins when nested target rectangles overlap. */
  priority?: number;
  type?: string;
  acceptedTypes?: readonly string[];
}

export interface DragSortRegistration {
  id: DragSortId;
  group?: DragSortId;
  index: number;
  element?: HTMLElement | null;
  handle?: HTMLElement | null;
  /** Start from the whole item when no dedicated handle is rendered. */
  activation?: DragSortActivation;
  target?: HTMLElement | null;
  label?: string;
  type?: string;
  acceptedTypes?: readonly string[];
  disabled?: boolean;
  /** A locked item may not be lifted but can still be a drop target. */
  targetDisabled?: boolean;
  /** A drop surface that should not participate in projected ordering. */
  targetOnly?: boolean;
  hidden?: boolean;
  collisionPriority?: number;
  /** Render an edge marker instead of a projected full-row placeholder. */
  showTargetIndicator?: boolean;
  /** Move a target-only layout follower when a cross-group placeholder enters its group. */
  crossGroupPlaceholderFollower?: boolean;
  /** Explicit React content supplied for the body-portaled overlay. */
  overlay?: unknown;
}

export interface DragSortValidationContext {
  active: DragSortRegistration;
  destination: DragSortPosition;
  target?: DragSortRegistration;
  input: DragSortInput;
}

export type DragSortValidation =
  | { allowed: true; destination?: DragSortPosition }
  | { allowed: false; reason: string };

export type DragSortValidator = (
  destination: DragSortPosition,
  context: DragSortValidationContext
) => DragSortValidation | boolean;

export interface DragSortAnnouncements {
  lift?: (label: string, position: DragSortPosition, total: number) => string;
  move?: (label: string, position: DragSortPosition, total: number, targetLabel?: string) => string;
  drop?: (label: string, position: DragSortPosition, total: number) => string;
  cancel?: (label: string) => string;
  invalid?: (label: string, reason: string) => string;
  error?: (label: string, reason: string) => string;
}

export interface DragSortPoint {
  x: number;
  y: number;
}

export interface DragSortOverlayRect extends DragSortRect {
  offsetX: number;
  offsetY: number;
}

export type DragSortPhase = 'idle' | 'pending' | 'dragging' | 'dropping' | 'cancelling';

export interface DragSortSnapshot {
  phase: DragSortPhase;
  activeId: DragSortId | null;
  input: DragSortInput | null;
  point: DragSortPoint | null;
  targetId: DragSortId | null;
  placement: DragSortPlacement | null;
  insideHold: DragSortInsideHold;
  projectedOrder: readonly DragSortId[] | null;
  overlayRect: DragSortOverlayRect | null;
  announcement: string;
  invalidReason: string | null;
  commitPending: boolean;
  error: string | null;
}

export const IDLE_DRAG_SORT_SNAPSHOT: DragSortSnapshot = Object.freeze({
  phase: 'idle',
  activeId: null,
  input: null,
  point: null,
  targetId: null,
  placement: null,
  insideHold: 'idle',
  projectedOrder: null,
  overlayRect: null,
  announcement: '',
  invalidReason: null,
  commitPending: false,
  error: null,
});
