import {
  COMPONENT_CANVAS_DOCUMENT_VERSION,
  COMPONENT_CANVAS_MAX_LOGICAL_NODES,
  createEmptyCanvasDocument,
  parseComponentCanvasDocument,
  type ComponentCanvasGuide,
  type ComponentCanvasDocument,
  type ComponentCanvasNode,
  type ComponentCanvasScopeState,
} from './canvas';

/** A v2 document may carry extensions owned by a newer canvas adapter. */
export type CanvasDocumentV2 = ComponentCanvasDocument & Record<string, unknown>;
export type CanvasNodeV2 = ComponentCanvasNode & Record<string, unknown>;
export type CanvasScopeStateV2 = ComponentCanvasScopeState & Record<string, unknown>;
export type CanvasGuideV2 = ComponentCanvasGuide & Record<string, unknown>;

export interface CanvasNodeSceneExtension {
  parentId?: string | null;
  rotation?: number;
  sizeMode?: 'auto' | 'fixed';
}

export interface CanvasDocumentAdapterResult {
  document: CanvasDocumentV2;
  /** Present when the payload was not a readable v2 document. */
  unreadablePayload?: unknown;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item: unknown) => cloneValue(item)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = cloneValue(child);
  }
  return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizedNodeSource(source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...source };
  // These keys are now parsed and validated below. Removing the raw values
  // prevents malformed known extensions from surviving beside their sanitized
  // canonical representation while all other extension fields are retained.
  delete result.parentId;
  delete result.rotation;
  delete result.sizeMode;
  return result;
}

function sanitizedGuideSource(source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...source };
  delete result.id;
  delete result.orientation;
  delete result.position;
  delete result.locked;
  return result;
}

/**
 * Adapts the persisted v2 document without mutating the source or dropping
 * extension fields. Known values still go through the canonical parser so a
 * malformed number or camera cannot leak into scene calculations.
 */
export function adaptCanvasDocument(value: unknown): CanvasDocumentAdapterResult {
  const parsed = parseComponentCanvasDocument(value);
  if (
    value !== null &&
    value !== undefined &&
    (!isRecord(value) || value.version !== COMPONENT_CANVAS_DOCUMENT_VERSION)
  ) {
    return {
      document: parsed.document as CanvasDocumentV2,
      unreadablePayload: parsed.unreadablePayload,
    };
  }
  if (value === null || value === undefined) {
    return { document: parsed.document as CanvasDocumentV2 };
  }

  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const knownNodes: ComponentCanvasNode[] = parsed.document.nodes;
  const usedSourceIndexes = new Set<number>();
  const nodes: CanvasNodeV2[] = knownNodes.map((node, index) => {
    const sourceIndex = sourceNodes.findIndex((candidate, candidateIndex) => {
      if (usedSourceIndexes.has(candidateIndex) || !isRecord(candidate)) return false;
      return candidate.id === node.id && candidate.componentId === node.componentId;
    });
    const fallbackIndex = sourceIndex >= 0 ? sourceIndex : index;
    if (sourceIndex >= 0) usedSourceIndexes.add(sourceIndex);
    const source = isRecord(sourceNodes[fallbackIndex])
      ? sanitizedNodeSource(cloneValue(sourceNodes[fallbackIndex]))
      : {};
    const sourcePresentation = isRecord(source.presentation) ? source.presentation : {};
    return {
      ...source,
      ...cloneValue(node),
      presentation: { ...sourcePresentation, ...cloneValue(node.presentation) },
    } as CanvasNodeV2;
  });

  const sourceScopes = isRecord(value.scopes) ? value.scopes : {};
  const scopes = {} as CanvasDocumentV2['scopes'];
  for (const scope of ['focus', 'variants', 'all'] as const) {
    const source = isRecord(sourceScopes[scope]) ? cloneValue(sourceScopes[scope]) : {};
    const sourceCamera = isRecord(source.camera) ? source.camera : {};
    const parsedScope = parsed.document.scopes[scope];
    scopes[scope] = {
      ...source,
      ...cloneValue(parsedScope),
      camera: { ...sourceCamera, ...cloneValue(parsedScope.camera) },
    } as CanvasScopeStateV2;
  }

  const parsedGuides = parsed.document.guides;
  const sourceGuides: unknown[] = Array.isArray(value.guides)
    ? Array.from(value.guides as unknown[])
    : [];
  const guides: CanvasGuideV2[] | undefined = parsedGuides?.map((guide) => {
    const source = sourceGuides.find(
      (candidate) => isRecord(candidate) && candidate.id === guide.id
    );
    const extension = isRecord(source) ? sanitizedGuideSource(cloneValue(source)) : {};
    return { ...extension, ...cloneValue(guide) } as CanvasGuideV2;
  });

  const documentSource = cloneValue(value);
  delete documentSource.guides;
  const document = {
    ...documentSource,
    version: COMPONENT_CANVAS_DOCUMENT_VERSION,
    nodes: nodes.slice(0, COMPONENT_CANVAS_MAX_LOGICAL_NODES),
    scopes,
  } as CanvasDocumentV2;
  if (guides !== undefined) document.guides = guides;
  delete document.unreadablePayload;
  return { document };
}

/** Alias kept intentionally descriptive for call sites that parse persisted data. */
export const parseCanvasDocumentV2 = adaptCanvasDocument;
export const parseCanvasDocument = adaptCanvasDocument;

/** Serializes an adapted document while retaining its extension fields. */
export function serializeCanvasDocument(document: CanvasDocumentV2): CanvasDocumentV2 {
  return cloneValue(document);
}

export const serializeCanvasDocumentV2 = serializeCanvasDocument;

/** Returns only validated, persisted node scene extensions for UI adapters. */
export function readCanvasNodeSceneExtension(
  node: Pick<CanvasNodeV2, 'parentId' | 'rotation' | 'sizeMode'>
): CanvasNodeSceneExtension {
  const extension: CanvasNodeSceneExtension = {};
  if (node.parentId === null || typeof node.parentId === 'string')
    extension.parentId = node.parentId;
  if (typeof node.rotation === 'number' && Number.isFinite(node.rotation)) {
    extension.rotation = node.rotation;
  }
  if (node.sizeMode === 'auto' || node.sizeMode === 'fixed') {
    extension.sizeMode = node.sizeMode;
  }
  return extension;
}

/**
 * Renderer dimensions are advisory for auto-sized nodes. Once a user has
 * resized a node, its persisted width/height are authoritative and late
 * renderer telemetry must not undo that edit. An active resize is rejected as
 * well so an in-flight measurement cannot race the pointer gesture.
 */
export function shouldApplyRendererMeasurement(
  node: Pick<CanvasNodeV2, 'sizeMode'> | null | undefined,
  options: { activeResize?: boolean } = {}
): boolean {
  if (options.activeResize) return false;
  return node?.sizeMode !== 'fixed';
}

/** Descriptive alias for callers that prefer a capability-style predicate. */
export const canApplyRendererMeasurement = shouldApplyRendererMeasurement;

/** Returns persisted user guides, or an empty list for legacy documents. */
export function readCanvasDocumentGuides(
  document: CanvasDocumentV2
): readonly ComponentCanvasGuide[] {
  return document.guides ?? [];
}

/** Useful for new projects and tests that need an extension-ready document. */
export function createCanvasDocumentV2(extensions: Record<string, unknown> = {}): CanvasDocumentV2 {
  return {
    ...(createEmptyCanvasDocument() as CanvasDocumentV2),
    ...cloneValue(extensions),
    version: COMPONENT_CANVAS_DOCUMENT_VERSION,
  };
}
