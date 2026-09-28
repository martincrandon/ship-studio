import type { ComponentCanvasNode } from './canvas';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasSelectionMode = 'replace' | 'add' | 'toggle';
export type CanvasResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type CanvasGuideOrientation = 'horizontal' | 'vertical';
export type CanvasZOrderAction =
  | 'bring-forward'
  | 'send-backward'
  | 'bring-to-front'
  | 'send-to-back';

export interface CanvasGuide {
  id?: string;
  orientation: CanvasGuideOrientation;
  position: number;
  /** The alignment that produced the visible guide. */
  kind: 'grid' | 'edge' | 'center' | 'guide';
  nodeId?: string;
  /** The peer artboard that supplied an edge/centre alignment, when any. */
  peerNodeId?: string;
  /**
   * Finite world-axis range for rendering a cross-artboard guide. For a
   * vertical guide this is the y range; for a horizontal guide it is x.
   * Persisted user guides intentionally do not carry this ephemeral field.
   */
  segment?: { start: number; end: number };
  locked?: boolean;
}

export interface CanvasSnapOptions {
  /** Distance is in screen pixels and is converted through zoom. */
  threshold?: number;
  zoom?: number;
  gridSize?: number;
  ctrlKey?: boolean;
  guides?: readonly CanvasGuide[];
}

export interface CanvasSnapResult {
  rect: CanvasRect;
  guides: CanvasGuide[];
  snapped: boolean;
  disabled: boolean;
}

const DEFAULT_SNAP_THRESHOLD = 8;
const DEFAULT_GRID_SIZE = 8;
const MIN_RECT_SIZE = 1;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function rectFromNode(
  node: Pick<ComponentCanvasNode, 'x' | 'y' | 'width' | 'height'>
): CanvasRect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

export function normalizeRect(rect: CanvasRect): CanvasRect {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return {
    x: Math.min(rect.x, x2),
    y: Math.min(rect.y, y2),
    width: Math.max(MIN_RECT_SIZE, Math.abs(rect.width)),
    height: Math.max(MIN_RECT_SIZE, Math.abs(rect.height)),
  };
}

export function rectContainsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
  const normalized = normalizeRect(rect);
  return (
    point.x >= normalized.x &&
    point.x <= normalized.x + normalized.width &&
    point.y >= normalized.y &&
    point.y <= normalized.y + normalized.height
  );
}

export function rectsIntersect(left: CanvasRect, right: CanvasRect): boolean {
  const a = normalizeRect(left);
  const b = normalizeRect(right);
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function nodeOrder(left: ComponentCanvasNode, right: ComponentCanvasNode): number {
  return right.order - left.order || right.id.localeCompare(left.id);
}

/** Returns the topmost node using order and id as deterministic tie breakers. */
export function hitTestCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  point: CanvasPoint
): ComponentCanvasNode | null {
  return (
    [...nodes].sort(nodeOrder).find((node) => rectContainsPoint(rectFromNode(node), point)) ?? null
  );
}

export function selectCanvasNodesInMarquee(
  nodes: readonly ComponentCanvasNode[],
  marquee: CanvasRect,
  mode: 'intersect' | 'contain' = 'intersect'
): string[] {
  const area = normalizeRect(marquee);
  return [...nodes]
    .filter((node) => {
      const rect = rectFromNode(node);
      return mode === 'contain'
        ? rectContainsPoint(area, { x: rect.x, y: rect.y }) &&
            rectContainsPoint(area, { x: rect.x + rect.width, y: rect.y + rect.height })
        : rectsIntersect(rect, area);
    })
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((node) => node.id);
}

export function updateCanvasSelection(
  current: readonly string[],
  next: readonly string[],
  mode: CanvasSelectionMode = 'replace'
): string[] {
  const existing = new Set(current);
  if (mode === 'replace') return [...new Set(next)];
  if (mode === 'add') return [...existing, ...next.filter((id) => !existing.has(id))];
  for (const id of next) {
    if (existing.has(id)) existing.delete(id);
    else existing.add(id);
  }
  return [...existing];
}

export function translateRect(rect: CanvasRect, delta: CanvasPoint): CanvasRect {
  return { ...rect, x: rect.x + finite(delta.x), y: rect.y + finite(delta.y) };
}

export function translateCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  nodeIds: readonly string[],
  delta: CanvasPoint
): ComponentCanvasNode[] {
  const selected = new Set(nodeIds);
  return nodes.map((node) => {
    if (!selected.has(node.id)) return node;
    return { ...node, x: node.x + finite(delta.x), y: node.y + finite(delta.y) };
  });
}

/** Resizes from the opposite edge, keeping the result above the minimum size. */
export function resizeRect(
  initial: CanvasRect,
  handle: CanvasResizeHandle,
  delta: CanvasPoint,
  minSize = MIN_RECT_SIZE
): CanvasRect {
  const start = normalizeRect(initial);
  const minimum = Math.max(MIN_RECT_SIZE, finite(minSize, MIN_RECT_SIZE));
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = Math.min(right - minimum, left + delta.x);
  if (handle.includes('e')) right = Math.max(left + minimum, right + delta.x);
  if (handle.includes('n')) top = Math.min(bottom - minimum, top + delta.y);
  if (handle.includes('s')) bottom = Math.max(top + minimum, bottom + delta.y);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface CanvasRotationResult {
  angle: number;
  origin: CanvasPoint;
  /** True when the gesture explicitly requested center-origin behavior. */
  centerOrigin: boolean;
  quantized: boolean;
}

/** Quantizes only when Shift is held, keeping free rotation available by default. */
export function quantizeRotationDegrees(
  degrees: number,
  shiftKey = false,
  stepDegrees = 15
): number {
  const safeStep = Math.max(Number.EPSILON, Math.abs(finite(stepDegrees, 15)));
  return shiftKey ? Math.round(finite(degrees) / safeStep) * safeStep : finite(degrees);
}

export function rectCenter(rect: CanvasRect): CanvasPoint {
  const normalized = normalizeRect(rect);
  return { x: normalized.x + normalized.width / 2, y: normalized.y + normalized.height / 2 };
}

export function rotatePoint(point: CanvasPoint, origin: CanvasPoint, degrees: number): CanvasPoint {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  return { x: origin.x + x * cos - y * sin, y: origin.y + x * sin + y * cos };
}

export function rotatedRectCorners(
  rect: CanvasRect,
  origin: CanvasPoint = rectCenter(rect),
  degrees = 0
): CanvasPoint[] {
  const normalized = normalizeRect(rect);
  return [
    { x: normalized.x, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y },
    { x: normalized.x + normalized.width, y: normalized.y + normalized.height },
    { x: normalized.x, y: normalized.y + normalized.height },
  ].map((point) => rotatePoint(point, origin, degrees));
}

export function rotatedRectBounds(
  rect: CanvasRect,
  origin: CanvasPoint = rectCenter(rect),
  degrees = 0
): CanvasRect {
  const corners = rotatedRectCorners(rect, origin, degrees);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(MIN_RECT_SIZE, Math.max(...xs) - x),
    height: Math.max(MIN_RECT_SIZE, Math.max(...ys) - y),
  };
}

/** Computes a rotation gesture and keeps modifier semantics explicit for callers. */
export function rotationFromPointers(
  start: CanvasPoint,
  current: CanvasPoint,
  bounds: CanvasRect,
  options: { shiftKey?: boolean; altKey?: boolean; origin?: CanvasPoint; stepDegrees?: number } = {}
): CanvasRotationResult {
  const center = rectCenter(bounds);
  const origin = options.altKey ? center : (options.origin ?? center);
  const startAngle = Math.atan2(start.y - origin.y, start.x - origin.x);
  const currentAngle = Math.atan2(current.y - origin.y, current.x - origin.x);
  // Canvas angles follow the visual screen-space gesture direction. Pointer
  // coordinates grow downwards, so the signed delta is the inverse of the
  // mathematical atan2 delta used by rotatePoint/CSS-style transforms.
  let rawAngle = ((startAngle - currentAngle) * 180) / Math.PI;
  if (rawAngle > 180) rawAngle -= 360;
  if (rawAngle < -180) rawAngle += 360;
  const angle = quantizeRotationDegrees(rawAngle, options.shiftKey, options.stepDegrees);
  return {
    angle,
    origin,
    centerOrigin: options.altKey === true,
    quantized: options.shiftKey === true,
  };
}

function orderedCanvasNodes(nodes: readonly ComponentCanvasNode[]): ComponentCanvasNode[] {
  return [...nodes].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id)
  );
}

/** Reorders a selection as a group while retaining deterministic internal order. */
export function reorderCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  selectedNodeIds: readonly string[],
  action: CanvasZOrderAction
): ComponentCanvasNode[] {
  const ordered = orderedCanvasNodes(nodes);
  const selected = new Set(selectedNodeIds);
  if (!selected.size) return [...nodes];
  if (action === 'bring-to-front') {
    const remainder = ordered.filter((node) => !selected.has(node.id));
    ordered.splice(
      0,
      ordered.length,
      ...remainder,
      ...ordered.filter((node) => selected.has(node.id))
    );
  } else if (action === 'send-to-back') {
    const remainder = ordered.filter((node) => !selected.has(node.id));
    ordered.splice(
      0,
      ordered.length,
      ...ordered.filter((node) => selected.has(node.id)),
      ...remainder
    );
  } else if (action === 'bring-forward') {
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      if (selected.has(ordered[index]!.id) && !selected.has(ordered[index + 1]!.id)) {
        [ordered[index], ordered[index + 1]] = [ordered[index + 1]!, ordered[index]!];
      }
    }
  } else {
    for (let index = 1; index < ordered.length; index += 1) {
      if (selected.has(ordered[index]!.id) && !selected.has(ordered[index - 1]!.id)) {
        [ordered[index], ordered[index - 1]] = [ordered[index - 1]!, ordered[index]!];
      }
    }
  }
  const nextOrder = new Map(ordered.map((node, index) => [node.id, index]));
  return nodes.map((node) => ({ ...node, order: nextOrder.get(node.id) ?? node.order }));
}

export const bringCanvasNodesForward = (
  nodes: readonly ComponentCanvasNode[],
  ids: readonly string[]
) => reorderCanvasNodes(nodes, ids, 'bring-forward');
export const sendCanvasNodesBackward = (
  nodes: readonly ComponentCanvasNode[],
  ids: readonly string[]
) => reorderCanvasNodes(nodes, ids, 'send-backward');
export const bringCanvasNodesToFront = (
  nodes: readonly ComponentCanvasNode[],
  ids: readonly string[]
) => reorderCanvasNodes(nodes, ids, 'bring-to-front');
export const sendCanvasNodesToBack = (
  nodes: readonly ComponentCanvasNode[],
  ids: readonly string[]
) => reorderCanvasNodes(nodes, ids, 'send-to-back');

interface AlignmentCandidate {
  distance: number;
  position: number;
  guidePosition: number;
  kind: CanvasGuide['kind'];
  nodeId?: string;
  guideId?: string;
  locked?: boolean;
  peerNodeId?: string;
  segment?: { start: number; end: number };
}

function finiteSegment(start: number, end: number): { start: number; end: number } {
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function candidateIsBetter(
  next: AlignmentCandidate,
  current: AlignmentCandidate | undefined
): boolean {
  if (!current) return true;
  return (
    next.distance < current.distance ||
    (next.distance === current.distance &&
      `${next.kind}:${next.nodeId ?? ''}:${next.guideId ?? ''}:${next.position}` <
        `${current.kind}:${current.nodeId ?? ''}:${current.guideId ?? ''}:${current.position}`)
  );
}

/**
 * Snaps a moving rectangle to grid and peer edges/centres. Threshold is screen
 * space, making the interaction feel consistent at every canvas zoom. Ctrl
 * temporarily disables all snapping and visible guides.
 */
export function snapCanvasRect(
  rect: CanvasRect,
  peers: readonly (CanvasRect & { nodeId?: string })[],
  options: CanvasSnapOptions = {}
): CanvasSnapResult {
  const disabled = options.ctrlKey === true;
  if (disabled) return { rect, guides: [], snapped: false, disabled: true };
  const zoom = Math.max(Number.EPSILON, finite(options.zoom ?? 1, 1));
  const threshold =
    Math.max(0, finite(options.threshold ?? DEFAULT_SNAP_THRESHOLD, DEFAULT_SNAP_THRESHOLD)) / zoom;
  const gridSize = Math.max(
    MIN_RECT_SIZE,
    finite(options.gridSize ?? DEFAULT_GRID_SIZE, DEFAULT_GRID_SIZE)
  );
  const normalized = normalizeRect(rect);
  const candidatesX: AlignmentCandidate[] = [];
  const candidatesY: AlignmentCandidate[] = [];
  const left = normalized.x;
  const centerX = normalized.x + normalized.width / 2;
  const right = normalized.x + normalized.width;
  const top = normalized.y;
  const centerY = normalized.y + normalized.height / 2;
  const bottom = normalized.y + normalized.height;
  const gridX = Math.round(left / gridSize) * gridSize;
  const gridY = Math.round(top / gridSize) * gridSize;
  candidatesX.push({
    distance: Math.abs(gridX - left),
    position: gridX,
    guidePosition: gridX,
    kind: 'grid',
    segment: finiteSegment(top, bottom),
  });
  candidatesY.push({
    distance: Math.abs(gridY - top),
    position: gridY,
    guidePosition: gridY,
    kind: 'grid',
    segment: finiteSegment(left, right),
  });
  for (const peer of peers) {
    const other = normalizeRect(peer);
    const xValues: Array<[number, CanvasGuide['kind']]> = [
      [other.x, 'edge'],
      [other.x + other.width / 2, 'center'],
      [other.x + other.width, 'edge'],
    ];
    const yValues: Array<[number, CanvasGuide['kind']]> = [
      [other.y, 'edge'],
      [other.y + other.height / 2, 'center'],
      [other.y + other.height, 'edge'],
    ];
    for (const [position, kind] of xValues) {
      for (const [edge, offset] of [
        [left, 0],
        [centerX, normalized.width / 2],
        [right, normalized.width],
      ] as const) {
        candidatesX.push({
          distance: Math.abs(position - edge),
          position: position - offset,
          guidePosition: position,
          kind,
          nodeId: peer.nodeId,
          peerNodeId: peer.nodeId,
          segment: finiteSegment(Math.min(top, other.y), Math.max(bottom, other.y + other.height)),
        });
      }
    }
    for (const [position, kind] of yValues) {
      for (const [edge, offset] of [
        [top, 0],
        [centerY, normalized.height / 2],
        [bottom, normalized.height],
      ] as const) {
        candidatesY.push({
          distance: Math.abs(position - edge),
          position: position - offset,
          guidePosition: position,
          kind,
          nodeId: peer.nodeId,
          peerNodeId: peer.nodeId,
          segment: finiteSegment(
            Math.min(left, other.x),
            Math.max(right, other.x + other.width)
          ),
        });
      }
    }
  }
  for (const guide of options.guides ?? []) {
    if (!Number.isFinite(guide.position)) continue;
    const values =
      guide.orientation === 'vertical'
        ? ([
            [left, 0],
            [centerX, normalized.width / 2],
            [right, normalized.width],
          ] as const)
        : ([
            [top, 0],
            [centerY, normalized.height / 2],
            [bottom, normalized.height],
          ] as const);
    for (const [edge, offset] of values) {
      const candidate = {
        distance: Math.abs(guide.position - edge),
        position: guide.position - offset,
        guidePosition: guide.position,
        kind: 'guide' as const,
        guideId: guide.id,
        locked: guide.locked,
        segment:
          guide.orientation === 'vertical'
            ? finiteSegment(top, bottom)
            : finiteSegment(left, right),
      };
      if (guide.orientation === 'vertical') candidatesX.push(candidate);
      else candidatesY.push(candidate);
    }
  }
  const bestX = candidatesX
    .filter((candidate) => candidate.distance <= threshold)
    .reduce<
      AlignmentCandidate | undefined
    >((best, candidate) => (candidateIsBetter(candidate, best) ? candidate : best), undefined);
  const bestY = candidatesY
    .filter((candidate) => candidate.distance <= threshold)
    .reduce<
      AlignmentCandidate | undefined
    >((best, candidate) => (candidateIsBetter(candidate, best) ? candidate : best), undefined);
  const snappedRect = {
    ...normalized,
    x: bestX?.position ?? normalized.x,
    y: bestY?.position ?? normalized.y,
  };
  const guides: CanvasGuide[] = [];
  if (bestX)
    guides.push({
      orientation: 'vertical',
      position: bestX.guidePosition,
      kind: bestX.kind,
      nodeId: bestX.nodeId,
      peerNodeId: bestX.peerNodeId,
      segment: bestX.segment,
      id: bestX.guideId,
      locked: bestX.locked,
    });
  if (bestY)
    guides.push({
      orientation: 'horizontal',
      position: bestY.guidePosition,
      kind: bestY.kind,
      nodeId: bestY.nodeId,
      peerNodeId: bestY.peerNodeId,
      segment: bestY.segment,
      id: bestY.guideId,
      locked: bestY.locked,
    });
  return { rect: snappedRect, guides, snapped: guides.length > 0, disabled: false };
}

export interface CanvasGuideDraft {
  id?: string;
  orientation: CanvasGuideOrientation;
  position: number;
  locked?: boolean;
}

function guideIdFor(draft: CanvasGuideDraft, existing: readonly CanvasGuide[]): string {
  const base = draft.id ?? `guide-${draft.orientation}-${draft.position}`;
  if (!existing.some((guide) => guide.id === base)) return base;
  let suffix = 2;
  while (existing.some((guide) => guide.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function createCanvasGuide(
  guides: readonly CanvasGuide[],
  draft: CanvasGuideDraft
): CanvasGuide[] {
  const position = finite(draft.position);
  const guide: CanvasGuide = {
    id: guideIdFor({ ...draft, position }, guides),
    orientation: draft.orientation,
    position,
    kind: 'guide',
    locked: draft.locked === true,
  };
  return [...guides, guide];
}

export function moveCanvasGuide(
  guides: readonly CanvasGuide[],
  guideId: string,
  position: number
): CanvasGuide[] {
  return guides.map((guide) =>
    guide.id === guideId && !guide.locked ? { ...guide, position: finite(position) } : guide
  );
}

export function deleteCanvasGuide(guides: readonly CanvasGuide[], guideId: string): CanvasGuide[] {
  return guides.filter((guide) => guide.id !== guideId || guide.locked === true);
}

export const hitTestNodes = hitTestCanvasNodes;
export const hitTest = hitTestCanvasNodes;
export const marqueeSelection = selectCanvasNodesInMarquee;
export const selectMarquee = selectCanvasNodesInMarquee;
export const translateNodes = translateCanvasNodes;
export const resizeCanvasRect = resizeRect;
export const snapRect = snapCanvasRect;
export const snap = snapCanvasRect;

// Keep the scene-facing geometry entry point convenient for callers that do
// not need to know that hierarchy validation has its own pure module.
export {
  isCanvasDescendant,
  normalizeCanvasHierarchySelection,
  reparentCanvasNodes,
} from './canvas-hierarchy';
