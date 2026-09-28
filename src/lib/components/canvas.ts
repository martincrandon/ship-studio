import type { ComponentDescriptor, ComponentIndex, ComponentInstance, StaticValue } from './types';
import type { ComponentPreviewPreset } from './presets';
import { sha256 } from './ranges';

/** Canvas limits are deliberately centralised so the UI and renderer scheduler
 * share the same bounded-work contract. */
export const COMPONENT_CANVAS_MAX_LOGICAL_NODES = 200;
export const COMPONENT_CANVAS_MAX_GENERATED_VARIANTS = 48;
export const COMPONENT_CANVAS_MAX_LIVE_FRAMES = 6;
export const COMPONENT_CANVAS_MAX_GUIDES = 200;
export const COMPONENT_CANVAS_MAX_EXTENSION_ID_LENGTH = 256;
/** Logical-space inset reserved for screen-space labels above and beside nodes. */
export const CANVAS_LAYOUT_LABEL_CLEARANCE = 32;
/** @deprecated Use the logical-node limit for new code. Kept for preset API compatibility. */
export const COMPONENT_CANVAS_MAX_FRAMES = COMPONENT_CANVAS_MAX_LOGICAL_NODES;
export const COMPONENT_CANVAS_DOCUMENT_VERSION = 2 as const;

export type CanvasScope = 'focus' | 'variants' | 'all';

/** Layout scopes independently so hidden frames never consume visible grid slots. */
export const CANVAS_SCOPE_ORDER: readonly CanvasScope[] = ['all', 'focus', 'variants'];

export interface CanvasCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface ComponentCanvasNode {
  /** Opaque, content-addressed identity. It is never a display name or index. */
  id: string;
  scope: CanvasScope;
  componentId: string;
  presetId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  order: number;
  collapsed: boolean;
  generated: boolean;
  /**
   * Renderer dimensions are advisory until a user explicitly resizes a node.
   * The field is optional so legacy v2 documents remain byte-compatible; an
   * omitted value has the same semantics as `auto`.
   */
  sizeMode?: 'auto' | 'fixed';
  /** Optional v2 scene extension retained for canvas-only transforms. */
  parentId?: string | null;
  /** Optional v2 scene extension; source code is never affected. */
  rotation?: number;
  presentation: {
    background: CanvasBackground;
    breakpoint: string | null;
    locale: string | null;
  };
}

/** User-authored alignment guide persisted with the canvas document. */
export interface ComponentCanvasGuide {
  id: string;
  orientation: 'horizontal' | 'vertical';
  position: number;
  locked?: boolean;
}

/** A generated finite test case is kept separate from the canvas layout. */
export interface GeneratedCanvasVariant {
  id: string;
  componentId: string;
  props: Record<string, StaticValue>;
}

/** Resolve an ephemeral finite variant by its stable presetId. */
export function resolveGeneratedCanvasVariant(
  variants: Readonly<Record<string, readonly GeneratedCanvasVariant[]>>,
  variantId: string | null
): GeneratedCanvasVariant | null {
  if (!variantId) return null;
  for (const componentVariants of Object.values(variants)) {
    const match = componentVariants.find((variant) => variant.id === variantId);
    if (match) return match;
  }
  return null;
}

/** Rebuild a generated matrix entry when its ephemeral UI state was reloaded. */
export function resolveGeneratedCanvasVariantForComponent(
  component: ComponentDescriptor,
  variantId: string | null
): GeneratedCanvasVariant | null {
  if (!variantId) return null;
  return (
    expandFiniteVariantMatrix(component, {
      componentId: component.id,
      presentation: { background: 'surface', breakpoint: null, locale: null },
    }).variants.find((variant) => variant.id === variantId) ?? null
  );
}

export interface ComponentCanvasScopeState {
  camera: CanvasCamera;
  expandedComponentIds: string[];
}

export interface ComponentCanvasDocument {
  version: typeof COMPONENT_CANVAS_DOCUMENT_VERSION;
  nodes: ComponentCanvasNode[];
  scopes: Record<CanvasScope, ComponentCanvasScopeState>;
  /** Optional scene extension; omitted from legacy documents with no guides. */
  guides?: ComponentCanvasGuide[];
  unreadablePayload?: unknown;
}

export interface ParsedCanvasDocument {
  document: ComponentCanvasDocument;
  /** Kept in memory for diagnostics; callers must not overwrite it silently. */
  unreadablePayload?: unknown;
}

export type CanvasWidthMode = 'fit' | 'full' | 'fixed';
export type CanvasBackground = 'surface' | 'white' | 'black' | 'checkerboard';
export type CanvasFrameHeight = 240 | 360 | 480 | 640 | 800;

/** Project-scoped key; the raw workspace path never becomes a shared key. */
export function componentPreviewPresetStorageKey(projectIdentity: string): string {
  return `ship-studio.component-preview-presets.v1.${sha256(projectIdentity).slice(0, 24)}`;
}

export interface ComponentCanvasFrame {
  id: string;
  presetId: string | null;
  name: string;
  componentId: string;
  props: Record<string, StaticValue>;
  slots: Record<string, string>;
  widthMode: CanvasWidthMode;
  width: number | null;
  height: CanvasFrameHeight;
  background: CanvasBackground;
  breakpoint: string | null;
  locale: string | null;
  /** The source revision that the authored frame was last reviewed against. */
  sourceRevision: string;
}

export function defaultCanvasCamera(): CanvasCamera {
  return { x: 0, y: 0, zoom: 1 };
}

export function createEmptyCanvasDocument(): ComponentCanvasDocument {
  return {
    version: COMPONENT_CANVAS_DOCUMENT_VERSION,
    nodes: [],
    scopes: {
      focus: { camera: defaultCanvasCamera(), expandedComponentIds: [] },
      variants: { camera: defaultCanvasCamera(), expandedComponentIds: [] },
      all: { camera: defaultCanvasCamera(), expandedComponentIds: [] },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseCamera(value: unknown): CanvasCamera {
  return {
    x: finiteNumber(isRecord(value) ? value.x : undefined, 0),
    y: finiteNumber(isRecord(value) ? value.y : undefined, 0),
    zoom: Math.min(4, Math.max(0.1, finiteNumber(isRecord(value) ? value.zoom : undefined, 1))),
  };
}

function parseNode(value: unknown): ComponentCanvasNode | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.componentId !== 'string') {
    return null;
  }
  const presentation = isRecord(value.presentation) ? value.presentation : {};
  const node: ComponentCanvasNode = {
    id: value.id,
    scope: ['focus', 'variants', 'all'].includes(String(value.scope))
      ? (value.scope as CanvasScope)
      : 'all',
    componentId: value.componentId,
    presetId: typeof value.presetId === 'string' ? value.presetId : null,
    x: finiteNumber(value.x, 0),
    y: finiteNumber(value.y, 0),
    width: Math.max(1, finiteNumber(value.width, 320)),
    height: Math.max(0, finiteNumber(value.height, 480)),
    order: finiteNumber(value.order, 0),
    collapsed: value.collapsed === true,
    generated: value.generated === true,
    presentation: {
      background: ['surface', 'white', 'black', 'checkerboard'].includes(
        String(presentation.background)
      )
        ? (presentation.background as CanvasBackground)
        : 'surface',
      breakpoint:
        presentation.breakpoint === null || typeof presentation.breakpoint === 'string'
          ? ((presentation.breakpoint as string | null | undefined) ?? null)
          : null,
      locale:
        presentation.locale === null || typeof presentation.locale === 'string'
          ? ((presentation.locale as string | null | undefined) ?? null)
          : null,
    },
  };
  if (
    typeof value.parentId === 'string' &&
    value.parentId.length > 0 &&
    value.parentId.length <= COMPONENT_CANVAS_MAX_EXTENSION_ID_LENGTH &&
    value.parentId !== node.id
  ) {
    node.parentId = value.parentId;
  } else if (value.parentId === null) {
    node.parentId = null;
  }
  if (typeof value.rotation === 'number' && Number.isFinite(value.rotation)) {
    node.rotation = value.rotation;
  }
  if (value.sizeMode === 'auto' || value.sizeMode === 'fixed') {
    node.sizeMode = value.sizeMode;
  }
  return node;
}

function parseGuides(value: unknown): ComponentCanvasGuide[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const guides: ComponentCanvasGuide[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const orientation = candidate.orientation;
    const position = candidate.position;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > COMPONENT_CANVAS_MAX_EXTENSION_ID_LENGTH ||
      ids.has(id) ||
      (orientation !== 'horizontal' && orientation !== 'vertical') ||
      typeof position !== 'number' ||
      !Number.isFinite(position)
    ) {
      continue;
    }
    ids.add(id);
    const guide: ComponentCanvasGuide = {
      id,
      orientation,
      position,
    };
    if (typeof candidate.locked === 'boolean') guide.locked = candidate.locked;
    guides.push(guide);
    if (guides.length >= COMPONENT_CANVAS_MAX_GUIDES) break;
  }
  return guides;
}

function sanitizeCanvasParentLinks(nodes: ComponentCanvasNode[]): ComponentCanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const parentId = node.parentId;
    if (typeof parentId !== 'string') return node;
    if (!byId.has(parentId)) {
      const { parentId: _parentId, ...withoutParent } = node;
      return withoutParent;
    }
    const visited = new Set<string>([node.id]);
    let current = byId.get(parentId);
    while (current) {
      if (visited.has(current.id)) {
        const { parentId: _parentId, ...withoutParent } = node;
        return withoutParent;
      }
      visited.add(current.id);
      const nextParentId = current.parentId;
      if (typeof nextParentId !== 'string') return node;
      current = byId.get(nextParentId);
    }
    return node;
  });
}

/** Parse persisted layout without ever treating malformed data as an empty save. */
export function parseComponentCanvasDocument(value: unknown): ParsedCanvasDocument {
  // The backend returns null/undefined when a project has never stored a
  // canvas. That is a valid fresh document, not a malformed payload. Keep
  // non-null values fail-closed so a corrupt saved document can never be
  // replaced by an empty save.
  if (value === null || value === undefined) {
    return { document: createEmptyCanvasDocument() };
  }
  if (!isRecord(value) || value.version !== COMPONENT_CANVAS_DOCUMENT_VERSION) {
    const empty = createEmptyCanvasDocument();
    return { document: { ...empty, unreadablePayload: value }, unreadablePayload: value };
  }
  const scopes = isRecord(value.scopes) ? value.scopes : {};
  const parsedNodes = Array.isArray(value.nodes)
    ? value.nodes.flatMap((node) => {
        const parsed = parseNode(node);
        return parsed ? [parsed] : [];
      })
    : [];
  const nodes = sanitizeCanvasParentLinks(parsedNodes);
  const guides = parseGuides(value.guides);
  const document: ComponentCanvasDocument = {
    version: COMPONENT_CANVAS_DOCUMENT_VERSION,
    nodes: nodes.slice(0, COMPONENT_CANVAS_MAX_LOGICAL_NODES),
    scopes: {
      focus: {
        camera: parseCamera(isRecord(scopes.focus) ? scopes.focus.camera : undefined),
        expandedComponentIds: readExpandedIds(
          isRecord(scopes.focus) ? scopes.focus.expandedComponentIds : undefined
        ),
      },
      variants: {
        camera: parseCamera(isRecord(scopes.variants) ? scopes.variants.camera : undefined),
        expandedComponentIds: readExpandedIds(
          isRecord(scopes.variants) ? scopes.variants.expandedComponentIds : undefined
        ),
      },
      all: {
        camera: parseCamera(isRecord(scopes.all) ? scopes.all.camera : undefined),
        expandedComponentIds: readExpandedIds(
          isRecord(scopes.all) ? scopes.all.expandedComponentIds : undefined
        ),
      },
    },
  };
  if (guides !== undefined) document.guides = guides;
  return {
    document,
  };
}

function readExpandedIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function componentCanvasNodeId(
  componentId: string,
  presetId: string | null,
  scope: CanvasScope
): string {
  return `node-${sha256(`component-canvas:${scope}:${componentId}:${presetId ?? 'generated'}`).slice(0, 24)}`;
}

export function autoLayoutCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  columns = 4,
  gap = 24
): ComponentCanvasNode[] {
  const sorted = [...nodes].sort(
    (a, b) =>
      Number(a.generated) - Number(b.generated) ||
      a.componentId.localeCompare(b.componentId) ||
      (a.presetId ?? '').localeCompare(b.presetId ?? '') ||
      a.id.localeCompare(b.id)
  );
  const nodesByScope = new Map<CanvasScope, ComponentCanvasNode[]>();
  for (const node of sorted) {
    const scopedNodes = nodesByScope.get(node.scope) ?? [];
    scopedNodes.push(node);
    nodesByScope.set(node.scope, scopedNodes);
  }

  const arranged: ComponentCanvasNode[] = [];
  for (const scope of CANVAS_SCOPE_ORDER) {
    const scopedNodes = nodesByScope.get(scope) ?? [];
    for (const { node, x, y } of positionCanvasGrid(
      scopedNodes,
      columns,
      gap,
      CANVAS_LAYOUT_LABEL_CLEARANCE
    )) {
      arranged.push({
        ...node,
        x,
        y,
        order: arranged.length,
      });
    }
  }
  return arranged;
}

/**
 * Pack heterogeneous frames into stable columns without letting a tall frame
 * create a blank band beneath every neighbouring column. Each new frame goes
 * into the shortest column, while column widths remain stable for the whole
 * layout pass so frames never overlap horizontally.
 */
function positionCanvasGrid(
  nodes: readonly ComponentCanvasNode[],
  columns: number,
  gap: number,
  origin = 0
): Array<{ node: ComponentCanvasNode; x: number; y: number }> {
  const safeColumns = Math.max(1, Math.floor(columns));
  const columnHeights = Array.from({ length: safeColumns }, () => 0);
  const placements: Array<{ node: ComponentCanvasNode; column: number }> = [];
  for (const node of nodes) {
    let column = 0;
    for (let candidate = 1; candidate < safeColumns; candidate += 1) {
      if (columnHeights[candidate] < columnHeights[column]) column = candidate;
    }
    placements.push({ node, column });
    columnHeights[column] += node.height + gap;
  }

  const columnWidths: number[] = [];
  for (const { node, column } of placements) {
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, node.width);
  }
  const columnOffsets: number[] = [];
  for (let column = 0; column < columnWidths.length; column += 1) {
    columnOffsets[column] =
      (columnOffsets[column - 1] ?? 0) + (column === 0 ? 0 : columnWidths[column - 1] + gap);
  }
  const nextY = Array.from({ length: safeColumns }, () => origin);
  return placements.map(({ node, column }) => {
    const position = {
      node,
      x: origin + (columnOffsets[column] ?? 0),
      y: nextY[column] ?? origin,
    };
    nextY[column] = position.y + node.height + gap;
    return position;
  });
}

/**
 * Arrange only the requested nodes while leaving the rest of the scene alone.
 * The selection keeps its current top-left anchor so arranging it never causes
 * an unrelated frame to jump.
 */
export function arrangeCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  selectedNodeIds?: readonly string[],
  columns = 4,
  gap = 24
): ComponentCanvasNode[] {
  const selected = selectedNodeIds?.length
    ? new Set(selectedNodeIds)
    : new Set(nodes.map((node) => node.id));
  const arranged = [...nodes]
    .filter((node) => selected.has(node.id))
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.componentId.localeCompare(right.componentId) ||
        left.id.localeCompare(right.id)
    );
  if (arranged.length === 0) return [...nodes];
  const isWholeCanvasLayout = !selectedNodeIds?.length;
  const anchorX = isWholeCanvasLayout
    ? CANVAS_LAYOUT_LABEL_CLEARANCE
    : Math.min(...arranged.map((node) => node.x));
  const anchorY = isWholeCanvasLayout
    ? CANVAS_LAYOUT_LABEL_CLEARANCE
    : Math.min(...arranged.map((node) => node.y));
  const arrangedById = new Map(
    positionCanvasGrid(arranged, columns, gap).map(({ node, x, y }) => [
      node.id,
      { ...node, x: anchorX + x, y: anchorY + y, order: node.order },
    ])
  );
  return nodes.map((node) => arrangedById.get(node.id) ?? node);
}

/** Duplicate a saved/generated test-case frame without touching source. */
export function duplicateCanvasNode(
  nodes: readonly ComponentCanvasNode[],
  nodeId: string,
  newId = `node-${sha256(`component-canvas:duplicate:${nodeId}:${Date.now()}:${Math.random()}`).slice(0, 24)}`
): { nodes: ComponentCanvasNode[]; refused: boolean } {
  if (nodes.length >= COMPONENT_CANVAS_MAX_LOGICAL_NODES) {
    return { nodes: [...nodes], refused: true };
  }
  const source = nodes.find((node) => node.id === nodeId);
  if (!source || nodes.some((node) => node.id === newId)) {
    return { nodes: [...nodes], refused: true };
  }
  const duplicate: ComponentCanvasNode = {
    ...source,
    id: newId,
    x: source.x + 24,
    y: source.y + 24,
    order: Math.max(-1, ...nodes.map((node) => node.order)) + 1,
  };
  return { nodes: [...nodes, duplicate], refused: false };
}

/** Source definitions are canonical and cannot be deleted from the canvas. */
export function deleteCanvasNode(
  nodes: readonly ComponentCanvasNode[],
  nodeId: string
): { nodes: ComponentCanvasNode[]; refused: boolean } {
  const source = nodes.find((node) => node.id === nodeId);
  if (!source || (source.scope === 'all' && source.presetId === null)) {
    return { nodes: [...nodes], refused: true };
  }
  return { nodes: nodes.filter((node) => node.id !== nodeId), refused: false };
}

export function ensureCanvasNodeLimit(nodes: readonly ComponentCanvasNode[]): {
  nodes: ComponentCanvasNode[];
  refused: number;
} {
  return {
    nodes: [...nodes].slice(0, COMPONENT_CANVAS_MAX_LOGICAL_NODES),
    refused: Math.max(0, nodes.length - COMPONENT_CANVAS_MAX_LOGICAL_NODES),
  };
}

export function expandFiniteVariantMatrix(
  component: ComponentDescriptor,
  base: Pick<ComponentCanvasNode, 'componentId' | 'presentation'> & { presetId?: string | null }
): {
  nodes: ComponentCanvasNode[];
  variants: GeneratedCanvasVariant[];
  prospectiveCount: number;
  refused: boolean;
} {
  const choices = finiteVariantChoices(component);
  const prospectiveCount = choices.reduce((count, choice) => count * choice.choices.length, 1);
  if (prospectiveCount > COMPONENT_CANVAS_MAX_GENERATED_VARIANTS) {
    return { nodes: [], variants: [], prospectiveCount, refused: true };
  }
  const combinations: Record<string, StaticValue>[] = [{}];
  for (const choice of choices) {
    const next: Record<string, StaticValue>[] = [];
    for (const current of combinations) {
      for (const value of choice.choices) next.push({ ...current, [choice.name]: value });
    }
    combinations.splice(0, combinations.length, ...next);
  }
  const variants = combinations.map((props) => ({
    id: `variant-${sha256(
      JSON.stringify({ componentId: component.id, base: base.presetId ?? null, props })
    ).slice(0, 24)}`,
    componentId: component.id,
    props,
  }));
  const nodes = variants.map((variant, index) => ({
    id: componentCanvasNodeId(component.id, variant.id, 'variants'),
    scope: 'variants' as const,
    componentId: base.componentId,
    presetId: variant.id,
    x: 0,
    y: 0,
    width: 320,
    height: 480,
    order: index,
    collapsed: false,
    generated: true,
    presentation: base.presentation,
  })) as ComponentCanvasNode[];
  return { nodes, variants, prospectiveCount, refused: false };
}

export interface CanvasFrameOrphan {
  frame: ComponentCanvasFrame;
  reason: 'missing-component' | 'dialect-changed' | 'unknown-prop' | 'unknown-slot';
}

export interface ReconciledCanvasFrames {
  active: ComponentCanvasFrame[];
  orphaned: CanvasFrameOrphan[];
}

function defaultFrameName(component: ComponentDescriptor, count: number): string {
  return count === 0 ? 'Default' : `${component.name} ${count + 1}`;
}

function staticPropsFromInstance(
  instance: ComponentInstance | null | undefined
): Record<string, StaticValue> {
  if (!instance) return {};
  return Object.fromEntries(
    Object.entries(instance.props).flatMap(([name, expression]) =>
      expression.kind === 'static' ? [[name, expression.value]] : []
    )
  );
}

function staticSlotsFromInstance(
  instance: ComponentInstance | null | undefined
): Record<string, string> {
  if (!instance) return {};
  return Object.fromEntries(
    instance.slots.flatMap((slot) =>
      slot.sourceText !== undefined ? [[slot.name, slot.sourceText]] : []
    )
  );
}

/** Create a frame from explicit values only. No default prop is copied into
 * props: absence remains meaningful and is displayed as source/default. */
export function createComponentCanvasFrame(
  component: ComponentDescriptor,
  sourceRevision: string,
  count = 0,
  instance?: ComponentInstance | null,
  preset?: ComponentPreviewPreset | null
): ComponentCanvasFrame {
  const presentation = preset?.presentation;
  return {
    id: preset?.id ?? `frame-${sha256(`${component.id}:${sourceRevision}:${count}`).slice(0, 16)}`,
    presetId: preset?.id ?? null,
    name: preset?.name ?? defaultFrameName(component, count),
    componentId: component.id,
    props: preset?.props ?? staticPropsFromInstance(instance),
    slots: preset?.slots ?? staticSlotsFromInstance(instance),
    widthMode: presentation?.widthMode ?? 'fit',
    width: presentation?.width ?? null,
    height: presentation?.height ?? 480,
    background: presentation?.background ?? 'surface',
    breakpoint: presentation?.breakpoint ?? null,
    locale: presentation?.locale ?? null,
    sourceRevision: preset?.sourceRevision ?? sourceRevision,
  };
}

export function frameToPreviewPreset(
  frame: ComponentCanvasFrame,
  dialect: ComponentPreviewPreset['dialect']
): ComponentPreviewPreset {
  return {
    id: frame.presetId ?? frame.id,
    version: 1,
    componentId: frame.componentId,
    dialect,
    name: frame.name.trim() || 'Untitled frame',
    props: frame.props,
    slots: frame.slots,
    sourceRevision: frame.sourceRevision,
    presentation: {
      widthMode: frame.widthMode,
      width: frame.width,
      height: frame.height,
      background: frame.background,
      breakpoint: frame.breakpoint,
      locale: frame.locale,
    },
  };
}

export function previewPresetToFrame(
  preset: ComponentPreviewPreset,
  component: ComponentDescriptor,
  sourceRevision: string,
  count = 0
): ComponentCanvasFrame {
  return createComponentCanvasFrame(component, sourceRevision, count, null, preset);
}

export function addCanvasFrame(
  frames: readonly ComponentCanvasFrame[],
  frame: ComponentCanvasFrame
): { frames: ComponentCanvasFrame[]; refused: boolean } {
  if (frames.length >= COMPONENT_CANVAS_MAX_FRAMES) {
    return { frames: [...frames], refused: true };
  }
  return { frames: [...frames, frame], refused: false };
}

export function removeCanvasFrame(
  frames: readonly ComponentCanvasFrame[],
  frameId: string
): ComponentCanvasFrame[] {
  if (frames.length <= 1) return [...frames];
  return frames.filter((frame) => frame.id !== frameId);
}

export function moveCanvasFrame(
  frames: readonly ComponentCanvasFrame[],
  frameId: string,
  direction: 'up' | 'down'
): ComponentCanvasFrame[] {
  const index = frames.findIndex((frame) => frame.id === frameId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= frames.length) return [...frames];
  const next = [...frames];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Variant controls come exclusively from parser-proven finite choices. */
export function finiteVariantChoices(component: ComponentDescriptor) {
  const variantNames = new Set(component.variantProps);
  return component.props
    .filter((prop) => variantNames.has(prop.name) && prop.choices && prop.choices.length > 0)
    .map((prop) => ({ name: prop.name, choices: prop.choices! }));
}

export function reconcileCanvasFrames(
  frames: readonly ComponentCanvasFrame[],
  index: ComponentIndex
): ReconciledCanvasFrames {
  const active: ComponentCanvasFrame[] = [];
  const orphaned: CanvasFrameOrphan[] = [];
  for (const frame of frames) {
    const component = index.components.find((candidate) => candidate.id === frame.componentId);
    if (!component) {
      orphaned.push({ frame, reason: 'missing-component' });
      continue;
    }
    const frameDialect = frame.componentId.split(':', 1)[0];
    if (frameDialect && frameDialect !== component.dialect) {
      orphaned.push({ frame, reason: 'dialect-changed' });
      continue;
    }
    const propNames = new Set(component.props.map((prop) => prop.name));
    if (Object.keys(frame.props).some((name) => !propNames.has(name))) {
      orphaned.push({ frame, reason: 'unknown-prop' });
      continue;
    }
    const slotNames = new Set(component.slots.map((slot) => slot.name));
    if (Object.keys(frame.slots).some((name) => !slotNames.has(name))) {
      orphaned.push({ frame, reason: 'unknown-slot' });
      continue;
    }
    active.push(frame);
  }
  return { active, orphaned };
}

/** Stable identity for baseline comparisons and stale-revision detection. */
export function canvasFrameIdentity(frame: ComponentCanvasFrame, sourceRevision: string): string {
  return sha256(
    JSON.stringify({
      componentId: frame.componentId,
      name: frame.name,
      props: frame.props,
      slots: frame.slots,
      widthMode: frame.widthMode,
      width: frame.width,
      height: frame.height,
      background: frame.background,
      breakpoint: frame.breakpoint,
      locale: frame.locale,
      sourceRevision,
    })
  );
}
