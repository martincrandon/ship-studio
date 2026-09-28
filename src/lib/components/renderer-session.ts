import type { CanvasBackground, CanvasFrameHeight, CanvasWidthMode } from './canvas';
import type { ComponentDialect, StaticValue } from './types';

export const COMPONENT_RENDERER_SESSION_PROTOCOL = 2 as const;
export const COMPONENT_RENDERER_MAX_MESSAGE_BYTES = 128 * 1024;
export const COMPONENT_RENDERER_MAX_MESSAGE_RATE = 30;
export const COMPONENT_RENDERER_MAX_SESSIONS_PER_PROJECT = 2;
export const COMPONENT_RENDERER_MAX_NESTING_DEPTH = 8;
export const COMPONENT_RENDERER_MAX_EVENT_ID_LENGTH = 128;
export const COMPONENT_RENDERER_READY_TIMEOUT_MS = 10_000;
export const COMPONENT_RENDERER_PAINT_TIMEOUT_MS = 10_000;
export const COMPONENT_RENDERER_HEARTBEAT_TIMEOUT_MS = 15_000;
export const COMPONENT_RENDERER_ACCESSIBILITY_TIMEOUT_MS = 5_000;

export interface RendererCapabilityFlags {
  liveFrame: boolean;
  snapshots: boolean;
  accessibility: boolean;
  editing: boolean;
}

export interface RendererSessionDescriptor {
  protocolVersion: typeof COMPONENT_RENDERER_SESSION_PROTOCOL;
  sessionId: string;
  capabilityToken: string;
  allowedOrigin: string;
  baseUrl: string;
  /** Rust-owned loopback payload endpoint, when a native session is active. */
  dataEndpoint?: string;
  generation: number;
  projectIdentity: string;
  supportedComponentIds: string[];
  sourceRevisions: Record<string, string>;
  capabilities: RendererCapabilityFlags;
}

export interface RendererFramePayload {
  protocolVersion: typeof COMPONENT_RENDERER_SESSION_PROTOCOL;
  projectIdentity: string;
  sessionId: string;
  frameId: string;
  componentId: string;
  componentRevision: string;
  generation: number;
  props: Record<string, StaticValue>;
  slots: Record<string, string>;
  presentation: {
    widthMode: CanvasWidthMode;
    width: number | null;
    height: CanvasFrameHeight;
    background: CanvasBackground;
    breakpoint: string | null;
    locale: string | null;
  };
}

export type RendererHostEvent =
  | { type: 'ready'; eventId: string; frameId: string }
  | { type: 'heartbeat'; eventId: string; frameId: string }
  | {
      type: 'rendered-dimensions';
      eventId: string;
      frameId: string;
      width: number;
      height: number;
      /** Camera scale used while measuring the rendered bounds. */
      zoom?: number;
    }
  | { type: 'render-error'; eventId: string; frameId: string; code: string; message: string }
  | {
      type: 'console-diagnostic';
      eventId: string;
      frameId: string;
      level: 'log' | 'warn' | 'error';
      message: string;
    }
  | {
      type: 'element-selection';
      eventId: string;
      frameId: string;
      sourceRange: RendererSourceRange;
      signature: RendererElementSelection;
    }
  | { type: 'source-location'; eventId: string; frameId: string; sourceRange: RendererSourceRange }
  | { type: 'revision-change'; eventId: string; frameId: string; componentRevision: string }
  | {
      type: 'accessibility-result';
      eventId: string;
      frameId: string;
      requestId: string;
      findings: RendererA11yFinding[];
    }
  | { type: 'snapshot-complete'; eventId: string; frameId: string; fingerprint: string };

export interface RendererSourceRange {
  file: string;
  start: number;
  end: number;
  contentHash: string;
}

/** The bounded DOM identity sent alongside a renderer-proven source range. */
export interface RendererElementSelection {
  tagName: string;
  className: string;
  ancestorClasses: string[];
  text?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
  domPath?: string;
}

export interface RendererA11yFinding {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  message: string;
  helpUrl?: string;
  elementRef?: string;
}

export interface RendererMessageContext {
  source: unknown;
  expectedSource: unknown;
  origin: string;
  expectedOrigin: string;
  session: RendererSessionDescriptor;
  frame: Pick<RendererFramePayload, 'frameId' | 'componentId' | 'componentRevision'>;
}

export interface RendererSessionManagerOptions {
  now?: () => number;
  idFactory?: () => string;
  tokenFactory?: () => string;
  maxSessionsPerProject?: number;
}

export interface PreparedRendererSessionInput {
  projectIdentity: string;
  allowedOrigin: string;
  baseUrl: string;
  supportedComponentIds: string[];
  sourceRevisions: Record<string, string>;
  capabilities: RendererCapabilityFlags;
}

function randomOpaqueId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${prefix}-${randomUuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function eventIdIsSafe(value: unknown): value is string {
  return boundedString(value, COMPONENT_RENDERER_MAX_EVENT_ID_LENGTH);
}

function sourceRangeIsSafe(value: unknown): value is RendererSourceRange {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.file, 512) &&
    typeof value.start === 'number' &&
    Number.isInteger(value.start) &&
    value.start >= 0 &&
    typeof value.end === 'number' &&
    Number.isInteger(value.end) &&
    value.end >= value.start &&
    value.end - value.start <= 1_000_000 &&
    boundedString(value.contentHash, 256)
  );
}

function findingIsSafe(value: unknown): value is RendererA11yFinding {
  if (!isRecord(value)) return false;
  return (
    boundedString(value.id, 256) &&
    ['minor', 'moderate', 'serious', 'critical'].includes(String(value.impact)) &&
    boundedString(value.message, 4096) &&
    (value.helpUrl === undefined || boundedString(value.helpUrl, 2048)) &&
    (value.elementRef === undefined || boundedString(value.elementRef, 512))
  );
}

function elementSelectionIsSafe(value: unknown): value is RendererElementSelection {
  if (!isRecord(value)) return false;
  const ancestorClasses = value.ancestorClasses;
  return (
    boundedString(value.tagName, 64) &&
    boundedString(value.className, 4096) &&
    Array.isArray(ancestorClasses) &&
    ancestorClasses.length <= 32 &&
    ancestorClasses.every((item) => boundedString(item, 512)) &&
    (value.text === undefined || boundedString(value.text, 4096)) &&
    (value.sourceFile === undefined || boundedString(value.sourceFile, 512)) &&
    (value.sourceLine === undefined ||
      (typeof value.sourceLine === 'number' &&
        Number.isInteger(value.sourceLine) &&
        value.sourceLine > 0 &&
        value.sourceLine <= 1_000_000)) &&
    (value.sourceColumn === undefined ||
      (typeof value.sourceColumn === 'number' &&
        Number.isInteger(value.sourceColumn) &&
        value.sourceColumn > 0 &&
        value.sourceColumn <= 1_000_000)) &&
    (value.domPath === undefined || boundedString(value.domPath, 2048))
  );
}

/** Shared handshake/message validator used by the iframe host adapter and tests. */
export function validateRendererHostEvent(
  event: unknown,
  context: RendererMessageContext
): RendererHostEvent | null {
  if (
    context.source !== context.expectedSource ||
    context.origin !== context.expectedOrigin ||
    !isRecord(event) ||
    event.protocolVersion !== COMPONENT_RENDERER_SESSION_PROTOCOL ||
    event.sessionId !== context.session.sessionId ||
    event.capabilityToken !== context.session.capabilityToken ||
    event.generation !== context.session.generation ||
    event.frameId !== context.frame.frameId ||
    event.componentId !== context.frame.componentId
  ) {
    return null;
  }
  if (!eventIdIsSafe(event.eventId)) return null;
  const type = event.type;
  if (
    ![
      'ready',
      'heartbeat',
      'rendered-dimensions',
      'render-error',
      'console-diagnostic',
      'element-selection',
      'source-location',
      'revision-change',
      'accessibility-result',
      'snapshot-complete',
    ].includes(String(type))
  )
    return null;
  if (type === 'ready') return { type, eventId: event.eventId, frameId: context.frame.frameId };
  if (type === 'heartbeat') return { type, eventId: event.eventId, frameId: context.frame.frameId };
  if (type === 'rendered-dimensions') {
    return typeof event.width === 'number' &&
      typeof event.height === 'number' &&
      event.width > 0 &&
      event.height > 0 &&
      (event.zoom === undefined ||
        (typeof event.zoom === 'number' &&
          Number.isFinite(event.zoom) &&
          event.zoom >= 0.01 &&
          event.zoom <= 256))
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          width: event.width,
          height: event.height,
          ...(typeof event.zoom === 'number' ? { zoom: event.zoom } : {}),
        }
      : null;
  }
  if (type === 'render-error') {
    return boundedString(event.code, 128) && boundedString(event.message, 4096)
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          code: event.code,
          message: event.message,
        }
      : null;
  }
  if (type === 'console-diagnostic') {
    return ['log', 'warn', 'error'].includes(String(event.level)) &&
      boundedString(event.message, 4096)
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          level: event.level as 'log' | 'warn' | 'error',
          message: event.message,
        }
      : null;
  }
  if (type === 'element-selection') {
    return sourceRangeIsSafe(event.sourceRange) && elementSelectionIsSafe(event.signature)
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          sourceRange: event.sourceRange,
          signature: event.signature,
        }
      : null;
  }
  if (type === 'source-location') {
    return sourceRangeIsSafe(event.sourceRange)
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          sourceRange: event.sourceRange,
        }
      : null;
  }
  if (type === 'revision-change') {
    return boundedString(event.componentRevision, 256) &&
      event.componentRevision === context.frame.componentRevision
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          componentRevision: event.componentRevision,
        }
      : null;
  }
  if (type === 'accessibility-result') {
    return boundedString(event.requestId, COMPONENT_RENDERER_MAX_EVENT_ID_LENGTH) &&
      Array.isArray(event.findings) &&
      event.findings.length <= 128 &&
      event.findings.every(findingIsSafe)
      ? {
          type,
          eventId: event.eventId,
          frameId: context.frame.frameId,
          requestId: event.requestId,
          findings: event.findings,
        }
      : null;
  }
  return boundedString(event.fingerprint, 512)
    ? {
        type: 'snapshot-complete',
        eventId: event.eventId,
        frameId: context.frame.frameId,
        fingerprint: event.fingerprint,
      }
    : null;
}

export function rendererMessageWithinBounds(value: unknown): boolean {
  try {
    const seen = new Set<unknown>();
    const walk = (current: unknown, depth: number): boolean => {
      if (depth > COMPONENT_RENDERER_MAX_NESTING_DEPTH) return false;
      if (!current || typeof current !== 'object') return true;
      if (seen.has(current)) return false;
      seen.add(current);
      if (Array.isArray(current)) {
        return current.length <= 256 && current.every((item) => walk(item, depth + 1));
      }
      const entries = Object.entries(current);
      return (
        entries.length <= 256 &&
        entries.every(([key, item]) => key.length <= 256 && walk(item, depth + 1))
      );
    };
    const serialized = JSON.stringify(value);
    let serializedBytes = 0;
    if (typeof TextEncoder !== 'undefined') {
      serializedBytes = new TextEncoder().encode(serialized).byteLength;
    } else {
      for (const character of serialized) {
        const codePoint = character.codePointAt(0) ?? 0;
        serializedBytes +=
          codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      }
    }
    return serializedBytes <= COMPONENT_RENDERER_MAX_MESSAGE_BYTES && walk(value, 0);
  } catch {
    return false;
  }
}

export interface RendererEventGuardOptions {
  now?: () => number;
}

function rendererEventGuardSessionKey(session: RendererSessionDescriptor): string {
  return [
    session.sessionId,
    session.capabilityToken,
    session.generation,
    session.allowedOrigin,
  ].join('\u0000');
}

/**
 * Applies the browser-side replay, rate, and whole-message bounds to one
 * iframe's already-identified message stream. The key changes with the
 * negotiated session or generation so a fresh renderer starts with clean
 * event state without allowing an old event to cross that boundary.
 */
export class RendererEventGuard {
  private readonly now: () => number;
  private sessionKey: string | null = null;
  private readonly seenEvents = new Set<string>();
  private readonly eventTimes: number[] = [];

  constructor(options: RendererEventGuardOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  accept(event: unknown, context: RendererMessageContext): RendererHostEvent | null {
    const sessionKey = rendererEventGuardSessionKey(context.session);
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.seenEvents.clear();
      this.eventTimes.length = 0;
    }
    if (!rendererMessageWithinBounds(event)) return null;
    const accepted = validateRendererHostEvent(event, context);
    if (!accepted || this.seenEvents.has(accepted.eventId)) return null;
    const cutoff = this.now() - 1_000;
    while (this.eventTimes[0] !== undefined && this.eventTimes[0] < cutoff) {
      this.eventTimes.shift();
    }
    if (this.eventTimes.length >= COMPONENT_RENDERER_MAX_MESSAGE_RATE) return null;
    this.seenEvents.add(accepted.eventId);
    this.eventTimes.push(this.now());
    return accepted;
  }
}

/**
 * Owns ephemeral renderer sessions without persisting tokens or accepting
 * project-provided module paths. The generated host is responsible for using
 * the descriptor only after its own reviewed registry has been installed.
 */
export class RendererSessionManager {
  private readonly sessions = new Map<string, RendererSessionDescriptor>();
  private readonly seenEvents = new Map<string, Set<string>>();
  private readonly eventTimes = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly maxSessionsPerProject: number;

  constructor(options: RendererSessionManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomOpaqueId('renderer'));
    this.tokenFactory = options.tokenFactory ?? (() => randomOpaqueId('cap'));
    this.maxSessionsPerProject = Math.max(
      1,
      Math.min(options.maxSessionsPerProject ?? COMPONENT_RENDERER_MAX_SESSIONS_PER_PROJECT, 8)
    );
  }

  prepare(input: PreparedRendererSessionInput): RendererSessionDescriptor {
    const projectSessions = [...this.sessions.values()].filter(
      (session) => session.projectIdentity === input.projectIdentity
    );
    if (projectSessions.length >= this.maxSessionsPerProject) {
      throw new Error(
        'Renderer session limit reached for this project. Stop an existing session first.'
      );
    }
    if (!boundedString(input.projectIdentity, 512))
      throw new Error('Invalid renderer project identity.');
    if (!boundedString(input.allowedOrigin, 2048) || !boundedString(input.baseUrl, 4096)) {
      throw new Error('Invalid renderer origin or base URL.');
    }
    if (
      input.supportedComponentIds.length > 200 ||
      input.supportedComponentIds.some((id) => !boundedString(id, 256))
    ) {
      throw new Error('Renderer component allowlist is invalid or too large.');
    }
    const descriptor: RendererSessionDescriptor = {
      protocolVersion: COMPONENT_RENDERER_SESSION_PROTOCOL,
      sessionId: this.idFactory(),
      capabilityToken: this.tokenFactory(),
      allowedOrigin: input.allowedOrigin,
      baseUrl: input.baseUrl,
      generation: 1,
      projectIdentity: input.projectIdentity,
      supportedComponentIds: [...new Set(input.supportedComponentIds)].sort(),
      sourceRevisions: { ...input.sourceRevisions },
      capabilities: { ...input.capabilities },
    };
    this.sessions.set(descriptor.sessionId, descriptor);
    this.seenEvents.set(descriptor.sessionId, new Set());
    this.eventTimes.set(descriptor.sessionId, []);
    return descriptor;
  }

  get(sessionId: string): RendererSessionDescriptor | null {
    return this.sessions.get(sessionId) ?? null;
  }

  acceptEvent(event: unknown, context: RendererMessageContext): RendererHostEvent | null {
    if (!rendererMessageWithinBounds(event)) return null;
    const session = this.get(context.session.sessionId);
    if (!session || session !== context.session) return null;
    const accepted = validateRendererHostEvent(event, context);
    if (!accepted) return null;
    const seen = this.seenEvents.get(session.sessionId);
    const times = this.eventTimes.get(session.sessionId);
    if (!seen || !times || seen.has(accepted.eventId)) return null;
    const cutoff = this.now() - 1_000;
    while (times[0] !== undefined && times[0] < cutoff) times.shift();
    if (times.length >= COMPONENT_RENDERER_MAX_MESSAGE_RATE) return null;
    seen.add(accepted.eventId);
    times.push(this.now());
    return accepted;
  }

  cancel(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    this.seenEvents.delete(sessionId);
    this.eventTimes.delete(sessionId);
    return removed;
  }

  invalidateProject(projectIdentity: string): number {
    const sessionIds = [...this.sessions.values()]
      .filter((session) => session.projectIdentity === projectIdentity)
      .map((session) => session.sessionId);
    sessionIds.forEach((sessionId) => this.cancel(sessionId));
    return sessionIds.length;
  }

  size(): number {
    return this.sessions.size;
  }
}

export function rendererComponentIsAllowed(
  session: RendererSessionDescriptor,
  componentId: string,
  revision: string
): boolean {
  return (
    session.supportedComponentIds.includes(componentId) &&
    session.sourceRevisions[componentId] === revision
  );
}

export function rendererDialectAdapterEnabled(dialect: ComponentDialect): boolean {
  const flags: Partial<Record<ComponentDialect, string>> = {
    react: 'SHIPSTUDIO_COMPONENT_RENDERER_REACT',
    astro: 'SHIPSTUDIO_COMPONENT_RENDERER_ASTRO',
    vue: 'SHIPSTUDIO_COMPONENT_RENDERER_VUE',
    svelte: 'SHIPSTUDIO_COMPONENT_RENDERER_SVELTE',
  };
  const key = flags[dialect];
  return key ? import.meta.env?.[key] === 'true' : false;
}
