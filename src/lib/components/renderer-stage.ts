import type { CanvasCameraState } from './canvas-camera';
import {
  COMPONENT_RENDERER_MAX_EVENT_ID_LENGTH,
  COMPONENT_RENDERER_MAX_MESSAGE_RATE,
  COMPONENT_RENDERER_MAX_MESSAGE_BYTES,
  rendererMessageWithinBounds,
  type RendererElementSelection,
  type RendererFramePayload,
  type RendererSessionDescriptor,
  type RendererSourceRange,
} from './renderer-session';

/**
 * The stage is a separate, reviewed host contract from the legacy one-frame
 * route. A numeric protocol version makes stale frame hosts fail closed while
 * the descriptive name keeps generated Next hosts easy to identify.
 */
export const COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION = 3 as const;
export const COMPONENT_RENDERER_STAGE_CONTRACT = 'next-host-v2' as const;
// Routable in both Next App and Pages routers (a leading underscore would be
// interpreted as a private App Router folder rather than a URL segment).
export const COMPONENT_RENDERER_STAGE_ROUTE_SEGMENT = 'shipstudio_canvas_stage' as const;
export const COMPONENT_RENDERER_STAGE_MAX_FRAMES = 200;
export const COMPONENT_RENDERER_STAGE_MAX_FRAME_ID_LENGTH = 256;
export const COMPONENT_RENDERER_STAGE_READY_TIMEOUT_MS = 15_000;
export const COMPONENT_RENDERER_STAGE_HEARTBEAT_TIMEOUT_MS = 15_000;

export type RendererStageProtocolVersion = typeof COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION;

/** Layout is intentionally parent-owned. The project runtime only paints it. */
export interface RendererStageLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

/** One actual component instance in the shared project-runtime document. */
export interface RendererStageFrame extends RendererFramePayload {
  layout: RendererStageLayout;
  /** Hidden nodes remain in the document but are not painted by the host. */
  visible?: boolean;
}

export interface RendererStageCamera extends CanvasCameraState {
  /** Documents the ownership boundary for generated hosts and QA tooling. */
  owner: 'parent';
}

export interface RendererStageSyncCommand {
  protocolVersion: RendererStageProtocolVersion;
  contract: typeof COMPONENT_RENDERER_STAGE_CONTRACT;
  type: 'sync';
  sessionId: string;
  capabilityToken: string;
  generation: number;
  stageId: string;
  frames: RendererStageFrame[];
  camera: RendererStageCamera;
  selectedFrameId: string | null;
  inputFrameId: string | null;
  /**
   * The runtime retains these already-painted instances while a changed
   * payload is loading. This is the stage equivalent of a poster handoff and
   * prevents a selected card from flashing blank during a prop update.
   */
  retainFrameIds: string[];
  /** The first paint barrier used by the parent before revealing the stage. */
  revealFrameIds: string[];
}

export type RendererStageCommand = RendererStageSyncCommand;

interface RendererStageEventBase {
  protocolVersion: RendererStageProtocolVersion;
  contract: typeof COMPONENT_RENDERER_STAGE_CONTRACT;
  sessionId: string;
  capabilityToken: string;
  generation: number;
  stageId: string;
  eventId: string;
}

export type RendererStageEvent =
  | (RendererStageEventBase & {
      type: 'stage-ready';
      frameIds: string[];
    })
  | (RendererStageEventBase & { type: 'heartbeat' })
  | (RendererStageEventBase & {
      type: 'frame-ready';
      frameId: string;
      componentId: string;
      componentRevision: string;
    })
  | (RendererStageEventBase & {
      type: 'frame-rendered-dimensions';
      frameId: string;
      componentId: string;
      componentRevision: string;
      width: number;
      height: number;
    })
  | (RendererStageEventBase & {
      type: 'frame-error';
      frameId: string;
      componentId: string;
      componentRevision: string;
      code: string;
      message: string;
    })
  | (RendererStageEventBase & {
      type: 'frame-activated';
      frameId: string;
      componentId: string;
      componentRevision: string;
    })
  | (RendererStageEventBase & {
      type: 'frame-selection';
      frameId: string;
      componentId: string;
      componentRevision: string;
      sourceRange: RendererSourceRange;
      signature: RendererElementSelection;
    })
  | (RendererStageEventBase & {
      type: 'stage-error';
      code: string;
      message: string;
      frameId?: string;
      componentId?: string;
      componentRevision?: string;
    });

export interface RendererStageMessageContext {
  source: unknown;
  expectedSource: unknown;
  origin: string;
  expectedOrigin: string;
  session: RendererSessionDescriptor;
  stageId: string;
  frames: ReadonlyMap<string, Pick<RendererStageFrame, 'componentId' | 'componentRevision'>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function finiteBoundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function eventIdIsSafe(value: unknown): value is string {
  return boundedString(value, COMPONENT_RENDERER_MAX_EVENT_ID_LENGTH);
}

function sourceRangeIsSafe(value: unknown): value is RendererSourceRange {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.file, 512) &&
    finiteBoundedNumber(value.start, 0, 1_000_000_000) &&
    Number.isInteger(value.start) &&
    finiteBoundedNumber(value.end, value.start, value.start + 1_000_000) &&
    Number.isInteger(value.end) &&
    boundedString(value.contentHash, 256)
  );
}

function selectionIsSafe(value: unknown): value is RendererElementSelection {
  if (!isRecord(value) || !boundedString(value.tagName, 64)) return false;
  if (!boundedString(value.className, 4096) || !Array.isArray(value.ancestorClasses)) return false;
  if (
    value.ancestorClasses.length > 32 ||
    !value.ancestorClasses.every((item) => boundedString(item, 512))
  )
    return false;
  return (
    (value.text === undefined || boundedString(value.text, 4096)) &&
    (value.sourceFile === undefined || boundedString(value.sourceFile, 512)) &&
    (value.sourceLine === undefined || finiteBoundedNumber(value.sourceLine, 1, 1_000_000)) &&
    (value.sourceColumn === undefined || finiteBoundedNumber(value.sourceColumn, 1, 1_000_000)) &&
    (value.domPath === undefined || boundedString(value.domPath, 2048))
  );
}

function frameIdentityIsSafe(
  event: Record<string, unknown>,
  frames: RendererStageMessageContext['frames']
): event is Record<string, unknown> & {
  frameId: string;
  componentId: string;
  componentRevision: string;
} {
  if (!boundedString(event.frameId, COMPONENT_RENDERER_STAGE_MAX_FRAME_ID_LENGTH)) return false;
  const frame = frames.get(event.frameId);
  return (
    !!frame &&
    boundedString(event.componentId, 256) &&
    boundedString(event.componentRevision, 256) &&
    event.componentId === frame.componentId &&
    event.componentRevision === frame.componentRevision
  );
}

/**
 * Validates stage events against the exact iframe window, origin, session,
 * generation, stage identity, and current frame allowlist. Unknown frame IDs
 * are rejected even when their component identity looks plausible.
 */
export function validateRendererStageEvent(
  event: unknown,
  context: RendererStageMessageContext
): RendererStageEvent | null {
  if (
    context.source !== context.expectedSource ||
    context.origin !== context.expectedOrigin ||
    !isRecord(event) ||
    event.protocolVersion !== COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION ||
    event.contract !== COMPONENT_RENDERER_STAGE_CONTRACT ||
    event.sessionId !== context.session.sessionId ||
    event.capabilityToken !== context.session.capabilityToken ||
    event.generation !== context.session.generation ||
    event.stageId !== context.stageId ||
    !eventIdIsSafe(event.eventId)
  ) {
    return null;
  }

  const type = event.type;
  if (type === 'heartbeat') {
    return { ...event, type } as RendererStageEvent;
  }
  if (type === 'stage-ready') {
    return Array.isArray(event.frameIds) &&
      event.frameIds.length <= COMPONENT_RENDERER_STAGE_MAX_FRAMES &&
      new Set(event.frameIds).size === event.frameIds.length &&
      event.frameIds.every(
        (id) =>
          boundedString(id, COMPONENT_RENDERER_STAGE_MAX_FRAME_ID_LENGTH) && context.frames.has(id)
      )
      ? ({ ...event, type, frameIds: [...event.frameIds] } as RendererStageEvent)
      : null;
  }
  if (type === 'stage-error') {
    const hasFrameIdentity =
      event.frameId === undefined || frameIdentityIsSafe(event, context.frames);
    return boundedString(event.code, 128) && boundedString(event.message, 4096) && hasFrameIdentity
      ? ({
          ...event,
          type,
          ...(event.frameId === undefined ||
          boundedString(event.frameId, COMPONENT_RENDERER_STAGE_MAX_FRAME_ID_LENGTH)
            ? {}
            : { frameId: undefined }),
        } as RendererStageEvent)
      : null;
  }
  if (!frameIdentityIsSafe(event, context.frames)) return null;
  if (type === 'frame-ready' || type === 'frame-activated') {
    return { ...event, type } as RendererStageEvent;
  }
  if (type === 'frame-rendered-dimensions') {
    return finiteBoundedNumber(event.width, 1, 100_000) &&
      finiteBoundedNumber(event.height, 1, 100_000)
      ? ({ ...event, type } as RendererStageEvent)
      : null;
  }
  if (type === 'frame-error') {
    return boundedString(event.code, 128) && boundedString(event.message, 4096)
      ? ({ ...event, type } as RendererStageEvent)
      : null;
  }
  if (type === 'frame-selection') {
    return sourceRangeIsSafe(event.sourceRange) && selectionIsSafe(event.signature)
      ? ({ ...event, type } as RendererStageEvent)
      : null;
  }
  return null;
}

export interface RendererStageEventGuardOptions {
  now?: () => number;
}

/** Applies replay, rate, and identity bounds to one shared stage stream. */
export class RendererStageEventGuard {
  private readonly now: () => number;
  private sessionKey: string | null = null;
  private readonly seenEvents = new Set<string>();
  private readonly eventTimes: number[] = [];

  constructor(options: RendererStageEventGuardOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  accept(event: unknown, context: RendererStageMessageContext): RendererStageEvent | null {
    const sessionKey = [
      context.session.sessionId,
      context.session.capabilityToken,
      context.session.generation,
      context.session.allowedOrigin,
      context.stageId,
    ].join('\u0000');
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.seenEvents.clear();
      this.eventTimes.length = 0;
    }
    if (!rendererMessageWithinBounds(event)) return null;
    const accepted = validateRendererStageEvent(event, context);
    if (!accepted || this.seenEvents.has(accepted.eventId)) return null;
    const cutoff = this.now() - 1_000;
    while (this.eventTimes[0] !== undefined && this.eventTimes[0] < cutoff) this.eventTimes.shift();
    if (this.eventTimes.length >= COMPONENT_RENDERER_MAX_MESSAGE_RATE) return null;
    this.seenEvents.add(accepted.eventId);
    this.eventTimes.push(this.now());
    return accepted;
  }
}

function safeStageId(stageId: string): boolean {
  return boundedString(stageId, COMPONENT_RENDERER_STAGE_MAX_FRAME_ID_LENGTH);
}

function safeLayout(layout: RendererStageLayout): boolean {
  return (
    finiteBoundedNumber(layout.x, -10_000_000, 10_000_000) &&
    finiteBoundedNumber(layout.y, -10_000_000, 10_000_000) &&
    finiteBoundedNumber(layout.width, 1, 100_000) &&
    finiteBoundedNumber(layout.height, 1, 100_000) &&
    (layout.rotation === undefined || finiteBoundedNumber(layout.rotation, -360_000, 360_000))
  );
}

function safeCamera(camera: RendererStageCamera): boolean {
  return (
    camera.owner === 'parent' &&
    finiteBoundedNumber(camera.x, -10_000_000, 10_000_000) &&
    finiteBoundedNumber(camera.y, -10_000_000, 10_000_000) &&
    finiteBoundedNumber(camera.zoom, 0.01, 100)
  );
}

/** Builds the only parent→runtime command used to update the shared stage. */
export function createRendererStageSyncCommand(input: {
  session: RendererSessionDescriptor;
  stageId: string;
  frames: readonly RendererStageFrame[];
  camera: RendererStageCamera;
  selectedFrameId: string | null;
  inputFrameId: string | null;
  retainFrameIds?: readonly string[];
  revealFrameIds?: readonly string[];
}): RendererStageSyncCommand | null {
  if (!safeStageId(input.stageId) || input.frames.length > COMPONENT_RENDERER_STAGE_MAX_FRAMES) {
    return null;
  }
  if (!safeCamera(input.camera)) return null;
  const ids = new Set<string>();
  const frames: RendererStageFrame[] = [];
  for (const frame of input.frames) {
    if (
      ids.has(frame.frameId) ||
      !boundedString(frame.frameId, COMPONENT_RENDERER_STAGE_MAX_FRAME_ID_LENGTH) ||
      frame.protocolVersion !== input.session.protocolVersion ||
      frame.sessionId !== input.session.sessionId ||
      frame.generation !== input.session.generation ||
      frame.projectIdentity !== input.session.projectIdentity ||
      !rendererStageComponentAllowed(input.session, frame) ||
      !safeLayout(frame.layout)
    ) {
      return null;
    }
    ids.add(frame.frameId);
    frames.push({ ...frame, layout: { ...frame.layout } });
  }
  const boundedIds = (values: readonly string[] | undefined): string[] =>
    [...new Set(values ?? [])].filter((id) => ids.has(id));
  const selectedFrameId =
    input.selectedFrameId && ids.has(input.selectedFrameId) ? input.selectedFrameId : null;
  const inputFrameId =
    input.inputFrameId && ids.has(input.inputFrameId) ? input.inputFrameId : null;
  const command: RendererStageSyncCommand = {
    protocolVersion: COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION,
    contract: COMPONENT_RENDERER_STAGE_CONTRACT,
    type: 'sync',
    sessionId: input.session.sessionId,
    capabilityToken: input.session.capabilityToken,
    generation: input.session.generation,
    stageId: input.stageId,
    frames,
    camera: { ...input.camera },
    selectedFrameId,
    inputFrameId,
    retainFrameIds: boundedIds(input.retainFrameIds),
    revealFrameIds: boundedIds(input.revealFrameIds),
  };
  return rendererStageMessageWithinBounds(command) ? command : null;
}

export function rendererStageComponentAllowed(
  session: RendererSessionDescriptor,
  frame: Pick<RendererStageFrame, 'componentId' | 'componentRevision'>
): boolean {
  return (
    boundedString(frame.componentId, 256) &&
    boundedString(frame.componentRevision, 256) &&
    session.supportedComponentIds.includes(frame.componentId) &&
    session.sourceRevisions[frame.componentId] === frame.componentRevision
  );
}

export function rendererStageUrl(
  session: Pick<RendererSessionDescriptor, 'baseUrl'>,
  routeSegment: string,
  stageId: string
): string {
  const base = session.baseUrl.replace(/\/$/, '');
  return `${base}/${encodeURIComponent(routeSegment)}?stageId=${encodeURIComponent(stageId)}`;
}

export function rendererStageMessageWithinBounds(value: unknown): boolean {
  // Keep a named stage helper so generated-host and parent tests can assert
  // that sync payloads are bounded without depending on the old frame API.
  return (
    rendererMessageWithinBounds(value) &&
    serializedByteLength(value) <= COMPONENT_RENDERER_MAX_MESSAGE_BYTES
  );
}

function serializedByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (serialized === undefined) return Number.POSITIVE_INFINITY;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).byteLength;
  return Array.from(serialized).reduce(
    (sum, character) => sum + (character.codePointAt(0)! <= 0x7f ? 1 : 2),
    0
  );
}
