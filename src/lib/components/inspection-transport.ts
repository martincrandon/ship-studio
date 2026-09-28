import {
  isEditableSurfaceMessage,
  isLegacyEditableSurfaceTarget,
  isNegotiatedEditableSurfaceTarget,
  postToEditableSurface,
  type EditableSurfaceTarget,
} from './editable-surface';

/** Bounds shared by the legacy Preview bridge and negotiated frame bridges. */
export const INSPECTION_TREE_MAX_NODES = 4000;
export const INSPECTION_TREE_MAX_DEPTH = 60;
export const INSPECTION_TREE_MAX_CHILDREN = 256;
export const INSPECTION_TREE_TAG_MAX = 64;
export const INSPECTION_TREE_CLASS_MAX = 4096;
export const INSPECTION_TREE_TEXT_MAX = 4096;
export const INSPECTION_TREE_ID_MAX = 512;
export const INSPECTION_TREE_OWNER_HINTS_MAX = 8;
export const INSPECTION_TREE_OWNER_STRING_MAX = 512;
export const INSPECTION_TREE_ARRAY_MAX = 4000;
export const INSPECTION_SELECTION_REQUEST_MAX = 128;

export interface InspectionWireOwnerHint {
  renderer?: string;
  file?: string;
  line?: number;
  column?: number;
  symbolHint?: string;
  runtimeKey?: string;
}

export interface InspectionWireNode {
  i: number;
  t: string;
  c: string;
  x: string;
  k: InspectionWireNode[];
  a?: string;
  o?: InspectionWireOwnerHint[];
  r?: string | null;
}

export interface BoundedInspectionTree {
  tree: InspectionWireNode | null;
  truncated: boolean;
}

export interface InspectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface InspectionSignature {
  tagName: string;
  className: string;
  ancestorClasses: string[];
  text?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  domPath?: string;
  rect?: InspectionRect;
  computedColor?: string;
  computedBackgroundColor?: string;
  unlayeredProps?: string[];
  inheritedProps?: Record<
    string,
    {
      cssValue: string;
      tagName: string;
      className: string;
      ancestorClasses: string[];
      token?: string;
    }
  >;
  attrSrc?: string | null;
  currentSrc?: string | null;
  direction?: 'ltr' | 'rtl';
  writingMode?: string;
  spacingUnit?: string;
}

export interface BoundedInspectionMessageBase {
  type: string;
}

export type BoundedInspectionMessage =
  | (BoundedInspectionMessageBase & {
      type: 'ss:tree';
      tree: InspectionWireNode;
      truncated: boolean;
    })
  | (BoundedInspectionMessageBase & { type: 'ss:treeDirty' })
  | (BoundedInspectionMessageBase & { type: 'ss:hover'; nodeId: number | null })
  | (BoundedInspectionMessageBase & { type: 'ss:selRect'; rect: InspectionRect | null })
  | (BoundedInspectionMessageBase & {
      type: 'ss:select';
      nodeId: number | null;
      affectedNodeIds: number[];
      count?: number;
      leafText?: boolean;
      selectionKind?: 'element' | 'component';
      /** Correlates an Elements-panel select request with its renderer ack. */
      selectionRequestId?: string;
      rect: InspectionRect | null;
      signature?: InspectionSignature;
      component?: {
        key: string;
        componentId?: string;
        instanceId?: string;
        name?: string;
        confidence?: string;
        hostNodeIds: number[];
      };
    })
  | (BoundedInspectionMessageBase & {
      type: 'ss:cascade';
      nodeId: number | null;
      rules: InspectionCascadeRule[];
    })
  | (BoundedInspectionMessageBase & {
      type: 'ss:componentFocusCandidate' | 'ss:hoverCandidate';
      focusCandidateNodeId?: number;
      hoverCandidateNodeId?: number;
    });

export interface InspectionCascadeDecl {
  prop: string;
  value: string;
  important: boolean;
  active: boolean;
  overriddenBy?: string;
}

export interface InspectionCascadeRule {
  selector: string | null;
  declarations: InspectionCascadeDecl[];
  specificity: [number, number, number];
  sourceOrder: number;
  mediaText: string | null;
  mediaMinPx: number | null;
  inactiveMedia: boolean;
  layer: string | null;
  container: string | null;
  supports: string | null;
  href: string | null;
  origin: 'author' | 'inline';
}

export interface InspectionSurfaceTransport {
  /** Stable identity for the bound window, used to invalidate stale React state. */
  readonly surfaceId: string;
  /** Changes whenever session/frame/component/revision identity changes. */
  readonly revisionKey: string;
  readonly active: boolean;
  post(message: unknown): boolean;
  accepts(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>): boolean;
}

interface IframeRefLike {
  current: HTMLIFrameElement | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function boundedOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, max);
}

function boundedNodeId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedPositiveNumber(value: unknown, max = 10_000_000): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max
    ? value
    : null;
}

function boundOwnerHint(value: unknown): InspectionWireOwnerHint | null {
  if (!isRecord(value)) return null;
  const hint: InspectionWireOwnerHint = {};
  const renderer = boundedOptionalString(value.renderer, INSPECTION_TREE_OWNER_STRING_MAX);
  const file = boundedOptionalString(value.file, INSPECTION_TREE_OWNER_STRING_MAX);
  const symbolHint = boundedOptionalString(value.symbolHint, INSPECTION_TREE_OWNER_STRING_MAX);
  const runtimeKey = boundedOptionalString(value.runtimeKey, INSPECTION_TREE_OWNER_STRING_MAX);
  const line = boundedNodeId(value.line);
  const column = boundedNodeId(value.column);
  if (renderer) hint.renderer = renderer;
  if (file) hint.file = file;
  if (symbolHint) hint.symbolHint = symbolHint;
  if (runtimeKey) hint.runtimeKey = runtimeKey;
  if (line !== null) hint.line = line;
  if (column !== null) hint.column = column;
  return Object.keys(hint).length > 0 ? hint : null;
}

/**
 * Turns an untrusted tree payload into the small wire shape consumed by React.
 * Invalid scalar fields are neutralised, while depth, child, owner, and total
 * node caps are applied before the result can enter component state.
 */
export function boundInspectionTree(value: unknown): BoundedInspectionTree {
  const seen = new Set<unknown>();
  let nodes = 0;
  let truncated = false;

  const visit = (current: unknown, depth: number): InspectionWireNode | null => {
    if (!isRecord(current)) {
      truncated = true;
      return null;
    }
    if (seen.has(current)) {
      truncated = true;
      return null;
    }
    if (nodes >= INSPECTION_TREE_MAX_NODES) {
      truncated = true;
      return null;
    }
    if (depth > INSPECTION_TREE_MAX_DEPTH) {
      truncated = true;
      return null;
    }
    const id = boundedNodeId(current.i);
    const tag = boundedOptionalString(current.t, INSPECTION_TREE_TAG_MAX);
    if (id === null || !tag) {
      truncated = true;
      return null;
    }

    seen.add(current);
    nodes += 1;
    const children: InspectionWireNode[] = [];
    const rawChildren = Array.isArray(current.k) ? current.k : [];
    if (!Array.isArray(current.k) && current.k !== undefined) truncated = true;
    if (rawChildren.length > INSPECTION_TREE_MAX_CHILDREN) truncated = true;
    if (depth >= INSPECTION_TREE_MAX_DEPTH && rawChildren.length > 0) truncated = true;
    for (const child of rawChildren.slice(0, INSPECTION_TREE_MAX_CHILDREN)) {
      if (nodes >= INSPECTION_TREE_MAX_NODES) {
        truncated = true;
        break;
      }
      const bounded = visit(child, depth + 1);
      if (bounded) children.push(bounded);
    }
    seen.delete(current);

    const ownerHints = Array.isArray(current.o)
      ? current.o.slice(0, INSPECTION_TREE_OWNER_HINTS_MAX).flatMap((hint) => {
          const bounded = boundOwnerHint(hint);
          return bounded ? [bounded] : [];
        })
      : undefined;
    if (Array.isArray(current.o) && current.o.length > INSPECTION_TREE_OWNER_HINTS_MAX) {
      truncated = true;
    }
    const node: InspectionWireNode = {
      i: id,
      t: tag,
      c: boundedString(current.c, INSPECTION_TREE_CLASS_MAX),
      x: boundedString(current.x, INSPECTION_TREE_TEXT_MAX),
      k: children,
    };
    const idAttr = boundedOptionalString(current.a, INSPECTION_TREE_ID_MAX);
    const runtimeKey =
      current.r === null
        ? null
        : boundedOptionalString(current.r, INSPECTION_TREE_OWNER_STRING_MAX);
    if (idAttr) node.a = idAttr;
    if (ownerHints?.length) node.o = ownerHints;
    if (runtimeKey !== undefined) node.r = runtimeKey;
    return node;
  };

  return { tree: visit(value, 0), truncated };
}

function boundRect(value: unknown): InspectionRect | null {
  if (!isRecord(value)) return null;
  const top = boundedPositiveNumber(value.top);
  const left = boundedPositiveNumber(value.left);
  const width = boundedPositiveNumber(value.width);
  const height = boundedPositiveNumber(value.height);
  if (top === null || left === null || width === null || height === null) return null;
  return { top, left, width: Math.max(0, width), height: Math.max(0, height) };
}

function boundSignature(value: unknown): InspectionSignature | undefined {
  if (!isRecord(value)) return undefined;
  const tagName = boundedOptionalString(value.tagName, INSPECTION_TREE_TAG_MAX);
  if (!tagName) return undefined;
  const ancestors = Array.isArray(value.ancestorClasses) ? value.ancestorClasses : [];
  const signature: InspectionSignature = {
    tagName,
    className: boundedString(value.className, INSPECTION_TREE_CLASS_MAX),
    ancestorClasses: ancestors
      .slice(0, 32)
      .map((item) => boundedString(item, INSPECTION_TREE_CLASS_MAX))
      .filter((item) => item.length > 0),
  };
  if (ancestors.length > 32) signature.ancestorClasses.length = 32;
  const text = boundedOptionalString(value.text, INSPECTION_TREE_TEXT_MAX);
  const sourceFile = boundedOptionalString(value.sourceFile, INSPECTION_TREE_ID_MAX);
  const domPath = boundedOptionalString(value.domPath, INSPECTION_TREE_ID_MAX);
  const sourceLine = boundedNodeId(value.sourceLine);
  const sourceColumn = boundedNodeId(value.sourceColumn);
  if (text) signature.text = text;
  if (sourceFile) signature.sourceFile = sourceFile;
  if (domPath) signature.domPath = domPath;
  if (sourceLine !== null) signature.sourceLine = sourceLine;
  if (sourceColumn !== null) signature.sourceColumn = sourceColumn;
  const rect = boundRect(value.rect);
  if (rect) signature.rect = rect;
  const computedColor = boundedOptionalString(value.computedColor, 512);
  const computedBackgroundColor = boundedOptionalString(value.computedBackgroundColor, 512);
  if (computedColor) signature.computedColor = computedColor;
  if (computedBackgroundColor) signature.computedBackgroundColor = computedBackgroundColor;
  if (Array.isArray(value.unlayeredProps)) {
    signature.unlayeredProps = value.unlayeredProps
      .slice(0, 64)
      .map((item) => boundedString(item, 128))
      .filter((item) => item.length > 0);
  }
  if (value.inheritedProps && isRecord(value.inheritedProps)) {
    const inherited: NonNullable<InspectionSignature['inheritedProps']> = {};
    for (const [property, raw] of Object.entries(value.inheritedProps).slice(0, 64)) {
      if (!/^[a-z][a-z-]{0,63}$/i.test(property) || !isRecord(raw)) continue;
      const cssValue = boundedOptionalString(raw.cssValue, 512);
      const tagName = boundedOptionalString(raw.tagName, INSPECTION_TREE_TAG_MAX);
      const className = boundedString(raw.className, INSPECTION_TREE_CLASS_MAX);
      const ancestorValues = Array.isArray(raw.ancestorClasses) ? raw.ancestorClasses : [];
      if (!cssValue || !tagName) continue;
      inherited[property] = {
        cssValue,
        tagName,
        className,
        ancestorClasses: ancestorValues
          .slice(0, 32)
          .map((item) => boundedString(item, INSPECTION_TREE_CLASS_MAX))
          .filter((item) => item.length > 0),
      };
      const token = boundedOptionalString(raw.token, 512);
      if (token) inherited[property].token = token;
    }
    if (Object.keys(inherited).length > 0) signature.inheritedProps = inherited;
  }
  if (value.attrSrc === null || typeof value.attrSrc === 'string') {
    signature.attrSrc = value.attrSrc === null ? null : value.attrSrc.slice(0, 4096);
  }
  if (value.currentSrc === null || typeof value.currentSrc === 'string') {
    signature.currentSrc = value.currentSrc === null ? null : value.currentSrc.slice(0, 4096);
  }
  if (value.direction === 'ltr' || value.direction === 'rtl') signature.direction = value.direction;
  const writingMode = boundedOptionalString(value.writingMode, 128);
  const spacingUnit = boundedOptionalString(value.spacingUnit, 128);
  if (writingMode) signature.writingMode = writingMode;
  if (spacingUnit) signature.spacingUnit = spacingUnit;
  return signature;
}

function boundCascadeRule(value: unknown): InspectionCascadeRule | null {
  if (!isRecord(value)) return null;
  const selector =
    value.selector === null
      ? null
      : boundedOptionalString(value.selector, 2048) ?? undefined;
  if (selector === undefined) return null;
  if (!Array.isArray(value.declarations) || value.declarations.length > 64) return null;
  const declarations: InspectionCascadeDecl[] = [];
  for (const raw of value.declarations) {
    if (!isRecord(raw)) return null;
    const prop = boundedOptionalString(raw.prop, 128);
    const declarationValue = boundedOptionalString(raw.value, 512);
    if (!prop || declarationValue === undefined) return null;
    if (typeof raw.important !== 'boolean' || typeof raw.active !== 'boolean') return null;
    const declaration: InspectionCascadeDecl = {
      prop,
      value: declarationValue,
      important: raw.important,
      active: raw.active,
    };
    const overriddenBy = boundedOptionalString(raw.overriddenBy, 2048);
    if (overriddenBy) declaration.overriddenBy = overriddenBy;
    declarations.push(declaration);
  }
  const specificity = value.specificity;
  if (
    !Array.isArray(specificity) ||
    specificity.length !== 3 ||
    specificity.some(
      (part) =>
        typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0 || part > 1_000_000
    )
  )
    return null;
  const sourceOrder = value.sourceOrder;
  if (
    typeof sourceOrder !== 'number' ||
    !Number.isSafeInteger(sourceOrder) ||
    sourceOrder < 0 ||
    sourceOrder > 1_000_000
  )
    return null;
  const nullableString = (input: unknown, max: number): string | null | undefined =>
    input === null ? null : boundedOptionalString(input, max);
  const mediaText = nullableString(value.mediaText, 2048);
  const layer = nullableString(value.layer, 512);
  const container = nullableString(value.container, 2048);
  const supports = nullableString(value.supports, 2048);
  const href = nullableString(value.href, 2048);
  if (
    mediaText === undefined ||
    layer === undefined ||
    container === undefined ||
    supports === undefined ||
    href === undefined
  )
    return null;
  const mediaMinPx =
    value.mediaMinPx === null
      ? null
      : typeof value.mediaMinPx === 'number' &&
          Number.isFinite(value.mediaMinPx) &&
          value.mediaMinPx >= 0 &&
          value.mediaMinPx <= 10_000_000
        ? value.mediaMinPx
        : undefined;
  if (mediaMinPx === undefined || typeof value.inactiveMedia !== 'boolean') return null;
  if (value.origin !== 'author' && value.origin !== 'inline') return null;
  return {
    selector,
    declarations,
    specificity: specificity as [number, number, number],
    sourceOrder,
    mediaText,
    mediaMinPx,
    inactiveMedia: value.inactiveMedia,
    layer,
    container,
    supports,
    href,
    origin: value.origin,
  };
}

function boundCascade(value: unknown): InspectionCascadeRule[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const rules: InspectionCascadeRule[] = [];
  for (const item of value) {
    const rule = boundCascadeRule(item);
    if (rule) rules.push(rule);
  }
  return rules;
}

function boundNodeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, INSPECTION_TREE_ARRAY_MAX)
    .map(boundedNodeId)
    .filter((id): id is number => id !== null);
}

/** Bounds the inspection messages that can update React selection/tree state. */
export function boundInspectionMessage(value: unknown): BoundedInspectionMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string' || value.type.length > 64) return null;
  switch (value.type) {
    case 'ss:tree': {
      const result = boundInspectionTree(value.tree);
      if (!result.tree) return null;
      return {
        type: 'ss:tree',
        tree: result.tree,
        truncated: value.truncated === true || result.truncated,
      };
    }
    case 'ss:treeDirty':
      return { type: 'ss:treeDirty' };
    case 'ss:hover':
      return { type: 'ss:hover', nodeId: boundedNodeId(value.nodeId) };
    case 'ss:selRect':
      return { type: 'ss:selRect', rect: boundRect(value.rect) };
    case 'ss:componentFocusCandidate': {
      const id = boundedNodeId(value.focusCandidateNodeId);
      return id === null
        ? { type: 'ss:componentFocusCandidate' }
        : { type: 'ss:componentFocusCandidate', focusCandidateNodeId: id };
    }
    case 'ss:hoverCandidate': {
      const id = boundedNodeId(value.hoverCandidateNodeId);
      return id === null
        ? { type: 'ss:hoverCandidate' }
        : { type: 'ss:hoverCandidate', hoverCandidateNodeId: id };
    }
    case 'ss:select': {
      const componentValue = isRecord(value.component) ? value.component : null;
      const key = boundedOptionalString(componentValue?.key, INSPECTION_TREE_ID_MAX);
      const component = key
        ? {
            key,
            ...(boundedOptionalString(componentValue?.componentId, INSPECTION_TREE_ID_MAX)
              ? {
                  componentId: boundedOptionalString(
                    componentValue?.componentId,
                    INSPECTION_TREE_ID_MAX
                  ),
                }
              : {}),
            ...(boundedOptionalString(componentValue?.instanceId, INSPECTION_TREE_ID_MAX)
              ? {
                  instanceId: boundedOptionalString(
                    componentValue?.instanceId,
                    INSPECTION_TREE_ID_MAX
                  ),
                }
              : {}),
            ...(boundedOptionalString(componentValue?.name, INSPECTION_TREE_ID_MAX)
              ? { name: boundedOptionalString(componentValue?.name, INSPECTION_TREE_ID_MAX) }
              : {}),
            ...(boundedOptionalString(componentValue?.confidence, 32)
              ? { confidence: boundedOptionalString(componentValue?.confidence, 32) }
              : {}),
            hostNodeIds: boundNodeIds(componentValue?.hostNodeIds),
          }
        : undefined;
      const selectionKind =
        value.selectionKind === 'component' || value.selectionKind === 'element'
          ? value.selectionKind
          : undefined;
      const selectionRequestId = boundedOptionalString(
        value.selectionRequestId,
        INSPECTION_SELECTION_REQUEST_MAX
      );
      const count = boundedNodeId(value.count);
      return {
        type: 'ss:select',
        nodeId: boundedNodeId(value.nodeId),
        affectedNodeIds: boundNodeIds(value.affectedNodeIds),
        ...(count !== null ? { count } : {}),
        ...(typeof value.leafText === 'boolean' ? { leafText: value.leafText } : {}),
        ...(selectionKind ? { selectionKind } : {}),
        ...(selectionRequestId ? { selectionRequestId } : {}),
        rect: boundRect(value.rect),
        ...(boundSignature(value.signature) ? { signature: boundSignature(value.signature) } : {}),
        ...(component ? { component } : {}),
      };
    }
    case 'ss:cascade': {
      const rules = boundCascade(value.rules);
      if (!rules) return null;
      return { type: 'ss:cascade', nodeId: boundedNodeId(value.nodeId), rules };
    }
    default:
      return null;
  }
}

function surfaceRevisionKey(target: EditableSurfaceTarget): string {
  return JSON.stringify([
    target.surfaceId,
    target.exactOrigin,
    target.sessionId,
    target.capabilityToken,
    target.generation,
    target.frameId,
    target.componentId,
    target.componentRevision,
  ]);
}

/**
 * Creates the one inspection channel used by both Preview and component frames.
 * An explicit null target means no surface; it never falls back to Preview.
 */
export function createInspectionTransport(options: {
  iframeRef: IframeRefLike;
  surfaceTarget?: EditableSurfaceTarget | null;
  legacySurfaceId?: string;
}): InspectionSurfaceTransport {
  const { iframeRef, surfaceTarget } = options;
  if (surfaceTarget === null) {
    return {
      surfaceId: 'none',
      revisionKey: 'none',
      active: false,
      post: () => false,
      accepts: () => false,
    };
  }
  if (surfaceTarget) {
    const target = surfaceTarget;
    const negotiated = isNegotiatedEditableSurfaceTarget(target);
    const legacy = isLegacyEditableSurfaceTarget(target);
    return {
      surfaceId: target.surfaceId,
      revisionKey: surfaceRevisionKey(target),
      active: !!target.contentWindow && (negotiated || legacy),
      post: (message) => (negotiated || legacy ? postToEditableSurface(target, message) : false),
      accepts: (event) =>
        (negotiated || legacy) &&
        event.source === target.contentWindow &&
        (legacy
          ? true
          : event.origin === target.exactOrigin && isEditableSurfaceMessage(target, event.data)),
    };
  }
  const surfaceId = options.legacySurfaceId ?? 'preview';
  return {
    surfaceId,
    revisionKey: `legacy:${surfaceId}`,
    active: true,
    post: (message) => {
      const contentWindow = iframeRef.current?.contentWindow;
      if (!contentWindow) return false;
      contentWindow.postMessage(message, '*');
      return true;
    },
    accepts: (event) => event.source === iframeRef.current?.contentWindow,
  };
}
