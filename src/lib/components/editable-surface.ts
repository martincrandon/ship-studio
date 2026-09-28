import type { RendererSourceRange } from './renderer-session';
import type { RendererCapabilityFlags } from './renderer-session';
import type { SourceRef } from './types';

/**
 * The smallest target contract shared by Preview and an isolated component
 * frame. It intentionally carries no ComponentInstance: a virtual frame is a
 * definition editing surface, not proof of a runtime usage.
 */
export interface EditableSurfaceTarget {
  contentWindow: Window | null;
  exactOrigin: string;
  surfaceId: string;
  sessionId: string | null;
  capabilityToken?: string | null;
  generation?: number | null;
  frameId: string | null;
  componentId: string | null;
  componentRevision: string | null;
  capabilities: RendererCapabilityFlags;
}

export interface RendererFrameEditContext {
  componentId: string;
  indexedRevision: string;
  definition: SourceRef;
  descendant: RendererSourceRange;
  confidence: 'exact' | 'sourceAnchored';
  proof: {
    sessionId: string;
    frameId: string;
    componentRevision: string;
  };
}

export type SourceEditGuard = (
  source: SourceRef | null
) => { status: 'valid'; source?: SourceRef } | { status: 'refused'; reason: string };

/**
 * Preview deliberately has no negotiated session identity. A component frame
 * must carry every identity field; a partially-populated target is never
 * treated as a legacy surface or allowed to fall back to a wildcard post.
 */
export function isLegacyEditableSurfaceTarget(target: EditableSurfaceTarget): boolean {
  return (
    target.sessionId === null &&
    target.capabilityToken == null &&
    target.generation == null &&
    target.frameId === null &&
    target.componentId === null &&
    target.componentRevision === null
  );
}

export function isNegotiatedEditableSurfaceTarget(target: EditableSurfaceTarget): boolean {
  return (
    typeof target.sessionId === 'string' &&
    target.sessionId.length > 0 &&
    typeof target.capabilityToken === 'string' &&
    target.capabilityToken.length > 0 &&
    typeof target.generation === 'number' &&
    Number.isSafeInteger(target.generation) &&
    typeof target.frameId === 'string' &&
    target.frameId.length > 0 &&
    typeof target.componentId === 'string' &&
    target.componentId.length > 0 &&
    typeof target.componentRevision === 'string' &&
    target.componentRevision.length > 0
  );
}

export type EditContextValidation =
  | { status: 'valid'; source: RendererSourceRange }
  | { status: 'refused'; reason: string };

/** Creates a target only when the iframe has an actual content window. */
export function editableSurfaceFromIframe(
  iframe: HTMLIFrameElement | null,
  input: Omit<EditableSurfaceTarget, 'contentWindow'>
): EditableSurfaceTarget | null {
  if (!iframe?.contentWindow) return null;
  return { ...input, contentWindow: iframe.contentWindow };
}

/** Prevents Preview and a component frame from accepting edits concurrently. */
export function isSameEditableSurface(
  left: EditableSurfaceTarget | null,
  right: EditableSurfaceTarget | null
): boolean {
  return (
    !!left &&
    !!right &&
    left.contentWindow === right.contentWindow &&
    left.exactOrigin === right.exactOrigin &&
    left.surfaceId === right.surfaceId &&
    left.sessionId === right.sessionId &&
    left.capabilityToken === right.capabilityToken &&
    left.generation === right.generation &&
    left.frameId === right.frameId &&
    left.componentId === right.componentId &&
    left.componentRevision === right.componentRevision
  );
}

/** Posts only to the negotiated renderer origin; callers still validate replies. */
export function postToEditableSurface(target: EditableSurfaceTarget, message: unknown): boolean {
  if (!target.contentWindow || !target.exactOrigin) return false;
  if (isLegacyEditableSurfaceTarget(target)) {
    target.contentWindow.postMessage(message, '*');
    return true;
  }
  if (!isNegotiatedEditableSurfaceTarget(target)) return false;
  // Negotiated commands always carry the complete identity envelope. A caller
  // cannot accidentally omit it (or override one field with stale data).
  const enriched = {
    ...(typeof message === 'object' && message !== null ? message : {}),
    protocolVersion: 2,
    sessionId: target.sessionId,
    capabilityToken: target.capabilityToken,
    generation: target.generation,
    frameId: target.frameId,
    componentId: target.componentId,
  };
  target.contentWindow.postMessage(enriched, target.exactOrigin);
  return true;
}

/**
 * Rejects messages that a project frame could forge after navigation or from a
 * stale renderer generation. Preview keeps its historical source/origin contract;
 * negotiated component frames additionally require the v2 identity envelope.
 */
export function isEditableSurfaceMessage(
  target: EditableSurfaceTarget | null,
  message: unknown
): boolean {
  if (!target) return false;
  if (isLegacyEditableSurfaceTarget(target)) return true;
  if (!isNegotiatedEditableSurfaceTarget(target)) return false;
  if (!message || typeof message !== 'object') return false;
  const data = message as Record<string, unknown>;
  return (
    data.protocolVersion === 2 &&
    data.sessionId === target.sessionId &&
    data.capabilityToken === target.capabilityToken &&
    data.generation === target.generation &&
    data.frameId === target.frameId &&
    data.componentId === target.componentId
  );
}

/** Deactivates the in-frame selection bridge before another surface is bound. */
export function deactivateEditableSurface(target: EditableSurfaceTarget | null): void {
  if (target) postToEditableSurface(target, { type: 'ss:deactivate' });
}

/**
 * Validates a renderer-reported child range before enabling Edit main. The
 * range must be inside the indexed definition and prove the same file/hash;
 * stale HMR/source revisions are refused rather than guessed.
 */
export function validateRendererFrameEditContext(
  target: EditableSurfaceTarget,
  context: RendererFrameEditContext
): EditContextValidation {
  if (!target.capabilities.editing) {
    return { status: 'refused', reason: 'The renderer session does not grant editing.' };
  }
  if (
    !target.componentId ||
    target.componentId !== context.componentId ||
    !target.componentRevision ||
    target.componentRevision !== context.indexedRevision ||
    context.proof.componentRevision !== context.indexedRevision ||
    context.proof.sessionId !== target.sessionId ||
    context.proof.frameId !== target.frameId
  ) {
    return {
      status: 'refused',
      reason: 'The renderer selection is stale or belongs to another frame.',
    };
  }
  if (
    context.confidence !== 'exact' ||
    context.descendant.file !== context.definition.file ||
    context.descendant.contentHash !== context.definition.contentHash ||
    context.descendant.start < context.definition.start ||
    context.descendant.end > context.definition.end ||
    context.descendant.end < context.descendant.start
  ) {
    return {
      status: 'refused',
      reason: 'The renderer did not prove an exact descendant source range.',
    };
  }
  return { status: 'valid', source: context.descendant };
}
