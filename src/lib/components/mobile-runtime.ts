import { normalizeProjectPath, normalizeRuntimeSourcePath } from './adapters/react-helpers';
import type { ComponentIndex, ComponentDialect, ComponentDiagnostic, SourceRef } from './types';

/** Version of the opt-in native runtime provenance protocol. */
export const MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION = 1 as const;
const MAX_RUNTIME_STRING = 256;
const MAX_RUNTIME_MESSAGE_BYTES = 64 * 1024;

export type MobileRuntimeRenderer = Extract<ComponentDialect, 'react-native' | 'flutter'>;
export type MobileRuntimeClearReason = 'reload' | 'route-change' | 'disconnect';

/**
 * The source range emitted by an instrumented native runtime. Ranges are
 * UTF-8 byte offsets, matching the shared component/index mutation contract.
 */
export type MobileRuntimeSourceAnchor = SourceRef;

export interface MobileRuntimeHello {
  protocol: typeof MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION;
  type: 'hello';
  renderer: MobileRuntimeRenderer;
  bridgeSession: string;
  sessionToken: string;
  runtimeVersion: string;
  frameworkVersion: string | null;
  capabilities: readonly ['source-binding'];
}

export interface MobileRuntimeBoundaryMessage {
  protocol: typeof MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION;
  type: 'boundary';
  renderer: MobileRuntimeRenderer;
  bridgeSession: string;
  sessionToken: string;
  runtimeId: string;
  definition: MobileRuntimeSourceAnchor;
  invocation: MobileRuntimeSourceAnchor | null;
  routeKey: string | null;
}

export interface MobileRuntimeClearMessage {
  protocol: typeof MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION;
  type: 'clear';
  renderer: MobileRuntimeRenderer;
  bridgeSession: string;
  sessionToken: string;
  runtimeId: string | null;
  reason: MobileRuntimeClearReason;
}

export type MobileRuntimeMessage =
  | MobileRuntimeHello
  | MobileRuntimeBoundaryMessage
  | MobileRuntimeClearMessage;

export interface MobileRuntimeBinding {
  renderer: MobileRuntimeRenderer;
  bridgeSession: string;
  runtimeId: string;
  routeKey: string | null;
  confidence: 'exact' | 'sourceAnchored';
  componentId: string;
  instanceId?: string;
  definition: SourceRef;
  invocation?: SourceRef;
  indexRevision: string;
}

export type MobileRuntimeResult =
  | { status: 'accepted'; binding: MobileRuntimeBinding }
  | { status: 'cleared'; runtimeId: string | null }
  | { status: 'refused'; code: MobileRuntimeRefusalCode; diagnostics: ComponentDiagnostic[] };

export type MobileRuntimeRefusalCode =
  | 'malformed'
  | 'unsupported-protocol'
  | 'renderer-mismatch'
  | 'unauthenticated'
  | 'session-mismatch'
  | 'not-indexed'
  | 'stale-source'
  | 'ambiguous-instance'
  | 'invocation-not-indexed'
  | 'disposed';

export interface MobileRuntimeBridgeOptions {
  index: ComponentIndex;
  /** The absolute project path used to normalize Metro/VM source URLs. */
  projectPath: string;
  renderer: MobileRuntimeRenderer;
  /** Generated per preview session; never derive it from project source. */
  sessionToken: string;
  onBinding?: (binding: MobileRuntimeBinding | null) => void;
}

export interface MobileRuntimeBridge {
  receive(input: unknown): MobileRuntimeResult;
  dispose(): void;
}

export interface MobileRuntimeEmitterOptions {
  renderer: MobileRuntimeRenderer;
  bridgeSession: string;
  sessionToken: string;
  runtimeVersion: string;
  frameworkVersion: string | null;
  send: (message: MobileRuntimeMessage) => void;
}

export interface MobileRuntimeEmitter {
  hello(): void;
  boundary(
    runtimeId: string,
    definition: MobileRuntimeSourceAnchor,
    invocation?: MobileRuntimeSourceAnchor | null,
    routeKey?: string | null
  ): void;
  clear(reason: MobileRuntimeClearReason, runtimeId?: string | null): void;
  dispose(): void;
}

/**
 * Parse only the protocol envelope and bounded fields. Source identity is
 * validated by {@link createMobileRuntimeBridge} against the current index.
 */
export function parseMobileRuntimeMessage(input: unknown):
  | { status: 'valid'; message: MobileRuntimeMessage }
  | {
      status: 'refused';
      code: Extract<MobileRuntimeRefusalCode, 'malformed' | 'unsupported-protocol'>;
      diagnostics: ComponentDiagnostic[];
    } {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_RUNTIME_MESSAGE_BYTES) {
      return malformed('The native component runtime message is too large.');
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return malformed('The native component runtime message is not valid JSON.');
    }
  }
  if (!isRecord(value)) return malformed('The native component runtime message is not an object.');
  if (value.protocol !== MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION) {
    return {
      status: 'refused',
      code: 'unsupported-protocol',
      diagnostics: [
        runtimeDiagnostic(
          'mobile-runtime-unsupported-protocol',
          `Unsupported native component runtime protocol ${String(value.protocol)}.`
        ),
      ],
    };
  }
  const type = boundedString(value.type);
  const renderer = boundedString(value.renderer);
  const bridgeSession = boundedString(value.bridgeSession);
  const sessionToken = boundedString(value.sessionToken);
  if (
    !type ||
    !renderer ||
    !bridgeSession ||
    !sessionToken ||
    !isMobileRenderer(renderer) ||
    bridgeSession.length > MAX_RUNTIME_STRING ||
    sessionToken.length > MAX_RUNTIME_STRING
  ) {
    return malformed('The native component runtime message has invalid session fields.');
  }
  if (type === 'hello') {
    const runtimeVersion = boundedString(value.runtimeVersion);
    const frameworkVersion = nullableString(value.frameworkVersion);
    if (!runtimeVersion || frameworkVersion === undefined || value.capabilities === undefined) {
      return malformed('The native component runtime hello is incomplete.');
    }
    if (
      !Array.isArray(value.capabilities) ||
      value.capabilities.length !== 1 ||
      value.capabilities[0] !== 'source-binding'
    ) {
      return malformed('The native component runtime capabilities are unsupported.');
    }
    return {
      status: 'valid',
      message: {
        protocol: MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION,
        type,
        renderer,
        bridgeSession,
        sessionToken,
        runtimeVersion,
        frameworkVersion,
        capabilities: ['source-binding'],
      },
    };
  }
  if (type === 'clear') {
    const runtimeId = nullableBoundedString(value.runtimeId);
    const reason = boundedString(value.reason);
    if (runtimeId === undefined || !isClearReason(reason)) {
      return malformed('The native component runtime clear message is invalid.');
    }
    return {
      status: 'valid',
      message: {
        protocol: MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION,
        type,
        renderer,
        bridgeSession,
        sessionToken,
        runtimeId,
        reason,
      },
    };
  }
  if (type !== 'boundary')
    return malformed('The native component runtime message type is unknown.');
  const runtimeId = boundedString(value.runtimeId);
  const routeKey = nullableBoundedString(value.routeKey);
  const definition = parseSourceAnchor(value.definition);
  const invocation = nullableSourceAnchor(value.invocation);
  if (!runtimeId || routeKey === undefined || !definition || invocation === undefined) {
    return malformed('The native component runtime boundary is incomplete.');
  }
  return {
    status: 'valid',
    message: {
      protocol: MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION,
      type,
      renderer,
      bridgeSession,
      sessionToken,
      runtimeId,
      definition,
      invocation,
      routeKey,
    },
  };
}

/**
 * Create the host-side validator. It never maps by component name, rendered
 * coordinates, or runtime order: only exact indexed source ranges can become
 * an `exact` binding. A definition-only event remains `sourceAnchored`.
 */
export function createMobileRuntimeBridge(
  options: MobileRuntimeBridgeOptions
): MobileRuntimeBridge {
  let disposed = false;
  let authenticatedSession: string | null = null;
  let activeBinding: MobileRuntimeBinding | null = null;
  const emit = (binding: MobileRuntimeBinding | null) => {
    activeBinding = binding;
    options.onBinding?.(binding);
  };

  return {
    receive(input) {
      if (disposed) return refused('disposed', 'The native component runtime bridge is closed.');
      const parsed = parseMobileRuntimeMessage(input);
      if (parsed.status === 'refused') return parsed;
      const message = parsed.message;
      if (message.renderer !== options.renderer) {
        return refused('renderer-mismatch', 'The runtime renderer does not match this bridge.');
      }
      if (message.sessionToken !== options.sessionToken) {
        return refused('unauthenticated', 'The runtime session token is not accepted.');
      }
      if (message.type === 'hello') {
        authenticatedSession = message.bridgeSession;
        emit(null);
        return { status: 'cleared', runtimeId: null };
      }
      if (!authenticatedSession) {
        return refused('unauthenticated', 'The runtime must send hello before boundary data.');
      }
      if (message.bridgeSession !== authenticatedSession) {
        return refused('session-mismatch', 'The runtime bridge session is no longer active.');
      }
      if (message.type === 'clear') {
        if (message.runtimeId === null || activeBinding?.runtimeId === message.runtimeId)
          emit(null);
        return { status: 'cleared', runtimeId: message.runtimeId };
      }
      const binding = resolveRuntimeBinding(message, options);
      if (binding.status === 'refused') return binding;
      emit(binding.binding);
      return binding;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      authenticatedSession = null;
      emit(null);
    },
  };
}

/**
 * Small emitter intended for an opt-in Metro transform or Flutter runtime
 * plugin. The caller owns the transport; this module only creates explicit,
 * hash-bound messages and sends a final cleanup event on disposal.
 */
export function createMobileRuntimeEmitter(
  options: MobileRuntimeEmitterOptions
): MobileRuntimeEmitter {
  let disposed = false;
  const send = (message: MobileRuntimeMessage) => {
    if (!disposed) options.send(message);
  };
  const base = () => ({
    protocol: MOBILE_COMPONENT_RUNTIME_PROTOCOL_VERSION,
    renderer: options.renderer,
    bridgeSession: options.bridgeSession,
    sessionToken: options.sessionToken,
  });
  return {
    hello() {
      send({
        ...base(),
        type: 'hello',
        runtimeVersion: options.runtimeVersion,
        frameworkVersion: options.frameworkVersion,
        capabilities: ['source-binding'],
      });
    },
    boundary(runtimeId, definition, invocation = null, routeKey = null) {
      send({ ...base(), type: 'boundary', runtimeId, definition, invocation, routeKey });
    },
    clear(reason, runtimeId = null) {
      send({ ...base(), type: 'clear', runtimeId, reason });
    },
    dispose() {
      if (disposed) return;
      send({ ...base(), type: 'clear', runtimeId: null, reason: 'disconnect' });
      disposed = true;
    },
  };
}

function resolveRuntimeBinding(
  message: MobileRuntimeBoundaryMessage,
  options: MobileRuntimeBridgeOptions
):
  | { status: 'accepted'; binding: MobileRuntimeBinding }
  | { status: 'refused'; code: MobileRuntimeRefusalCode; diagnostics: ComponentDiagnostic[] } {
  const definition = normalizeRuntimeSourceRef(
    message.definition,
    options.projectPath,
    options.index.profile.workspaceRoot
  );
  const invocation = message.invocation
    ? normalizeRuntimeSourceRef(
        message.invocation,
        options.projectPath,
        options.index.profile.workspaceRoot
      )
    : null;
  if (!definition || (message.invocation && !invocation)) {
    return refused('stale-source', 'The runtime source range is not a valid project source.');
  }
  const component = options.index.components.find(
    (candidate) =>
      candidate.dialect === message.renderer && sameSourceRef(candidate.definition, definition)
  );
  if (!component) {
    const sameRange = options.index.components.find(
      (candidate) =>
        candidate.dialect === message.renderer && sameSourceRange(candidate.definition, definition)
    );
    if (sameRange) {
      return refused('stale-source', 'The runtime definition has an outdated source hash.');
    }
    return refused(
      'not-indexed',
      'The runtime definition is not present in the current source index.'
    );
  }
  if (!invocation) {
    return {
      status: 'accepted',
      binding: {
        renderer: message.renderer,
        bridgeSession: message.bridgeSession,
        runtimeId: message.runtimeId,
        routeKey: message.routeKey,
        confidence: 'sourceAnchored',
        componentId: component.id,
        definition: component.definition,
        indexRevision: options.index.revision,
      },
    };
  }
  const matches = options.index.instances.filter(
    (instance) =>
      instance.componentId === component.id && sameSourceRef(instance.invocation, invocation)
  );
  if (matches.length === 0) {
    const sameRange = options.index.instances.some(
      (instance) =>
        instance.componentId === component.id && sameSourceRange(instance.invocation, invocation)
    );
    if (sameRange) {
      return refused('stale-source', 'The runtime invocation has an outdated source hash.');
    }
    return refused(
      'invocation-not-indexed',
      'The runtime invocation is not present in the current source index.'
    );
  }
  if (matches.length !== 1) {
    return refused(
      'ambiguous-instance',
      'The runtime invocation maps to more than one indexed instance.'
    );
  }
  const instance = matches[0];
  return {
    status: 'accepted',
    binding: {
      renderer: message.renderer,
      bridgeSession: message.bridgeSession,
      runtimeId: message.runtimeId,
      routeKey: message.routeKey,
      confidence: 'exact',
      componentId: component.id,
      instanceId: instance.id,
      definition: component.definition,
      invocation: instance.invocation,
      indexRevision: options.index.revision,
    },
  };
}

function normalizeRuntimeSourceRef(
  reference: SourceRef,
  projectPath: string,
  workspaceRoot: string
): SourceRef | null {
  if (
    reference.file.includes('\0') ||
    reference.file.trim().length === 0 ||
    reference.file.split(/[\\/]/).some((part) => part === '..')
  ) {
    return null;
  }
  const file = normalizeRuntimeSourcePath(reference.file, projectPath, workspaceRoot);
  if (file === '.' || file.startsWith('../') || file.includes('/../')) return null;
  return { ...reference, file: normalizeProjectPath(file) };
}

function parseSourceAnchor(value: unknown): SourceRef | null {
  if (!isRecord(value)) return null;
  const file = boundedString(value.file);
  const start = boundedInteger(value.start);
  const end = boundedInteger(value.end);
  const line = boundedInteger(value.line);
  const column = boundedInteger(value.column);
  const contentHash = boundedString(value.contentHash);
  if (
    !file ||
    start === null ||
    end === null ||
    line === null ||
    column === null ||
    !contentHash ||
    !/^[a-f0-9]{64}$/.test(contentHash) ||
    start < 0 ||
    end <= start ||
    line < 1 ||
    column < 1
  ) {
    return null;
  }
  return { file, start, end, line, column, contentHash };
}

function nullableSourceAnchor(value: unknown): SourceRef | null | undefined {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return parseSourceAnchor(value) ?? undefined;
}

function sameSourceRef(left: SourceRef, right: SourceRef): boolean {
  return sameSourceRange(left, right) && left.contentHash === right.contentHash;
}

function sameSourceRange(left: SourceRef, right: SourceRef): boolean {
  return (
    normalizeProjectPath(left.file) === normalizeProjectPath(right.file) &&
    left.start === right.start &&
    left.end === right.end
  );
}

function isMobileRenderer(value: string): value is MobileRuntimeRenderer {
  return value === 'react-native' || value === 'flutter';
}

function isClearReason(value: string | null): value is MobileRuntimeClearReason {
  return value === 'reload' || value === 'route-change' || value === 'disconnect';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RUNTIME_STRING
    ? value
    : null;
}

function nullableBoundedString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return boundedString(value) ?? undefined;
}

function boundedInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return boundedString(value) ?? undefined;
}

function runtimeDiagnostic(code: string, message: string): ComponentDiagnostic {
  return { code, severity: 'warning', message };
}

function malformed(message: string): {
  status: 'refused';
  code: 'malformed';
  diagnostics: ComponentDiagnostic[];
} {
  return {
    status: 'refused',
    code: 'malformed',
    diagnostics: [runtimeDiagnostic('mobile-runtime-malformed', message)],
  };
}

function refused(
  code: Exclude<MobileRuntimeRefusalCode, 'malformed' | 'unsupported-protocol'>,
  message: string
): { status: 'refused'; code: MobileRuntimeRefusalCode; diagnostics: ComponentDiagnostic[] } {
  return {
    status: 'refused',
    code,
    diagnostics: [runtimeDiagnostic(`mobile-runtime-${code}`, message)],
  };
}
