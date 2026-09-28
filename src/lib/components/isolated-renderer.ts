import type { ComponentA11yResult } from './qa';
import type {
  CanvasBackground,
  CanvasFrameHeight,
  CanvasWidthMode,
  ComponentCanvasFrame,
} from './canvas';
import type { ComponentDescriptor, StaticValue } from './types';

/**
 * The renderer is deliberately a host capability rather than an adapter.
 *
 * A host owns the project runtime (usually a separate preview webview or an
 * external browser). Ship Studio sends only an indexed component identity and
 * explicit static frame values. It never imports a project module, evaluates
 * project configuration, or mounts returned markup in its own process.
 */
export const COMPONENT_ISOLATED_RENDERER_PROTOCOL = 1 as const;
export const COMPONENT_RENDERER_MAX_REQUEST_BYTES = 128 * 1024;
export const COMPONENT_RENDERER_MAX_IMAGE_CHARS = 8 * 1024 * 1024;

export interface ComponentIsolatedRenderRequest {
  protocolVersion: typeof COMPONENT_ISOLATED_RENDERER_PROTOCOL;
  /** Opaque project identity. This must not be an absolute filesystem path. */
  projectIdentity: string;
  frameId: string;
  componentId: string;
  dialect: ComponentDescriptor['dialect'];
  sourceRevision: string;
  /** Optional saved-baseline identity for a host-side pixel comparison. */
  baselineFingerprint?: string;
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

/**
 * A result contains an image, not HTML. The image can safely be displayed in
 * the Ship Studio UI without executing project scripts in the app webview.
 * `renderFingerprint` must be derived by the host from the rendered pixels;
 * it is what lets QA distinguish a match from a changed render without
 * reading the project screenshot file in the frontend.
 */
export interface ComponentIsolatedRenderResult {
  protocolVersion: typeof COMPONENT_ISOLATED_RENDERER_PROTOCOL;
  projectIdentity: string;
  frameId: string;
  sourceRevision: string;
  imageDataUrl: string;
  renderFingerprint: string;
  width: number;
  height: number;
  /** Optional host-computed normalized pixel difference against a baseline. */
  pixelDifference?: number;
  /** Echo of the exact baseline identity used for `pixelDifference`. */
  comparedBaselineFingerprint?: string;
  /** A path explicitly returned by the host for agent handoff/baseline storage. */
  screenshotPath?: string;
}

export interface ComponentIsolatedRendererHost {
  protocolVersion: typeof COMPONENT_ISOLATED_RENDERER_PROTOCOL;
  projectIdentity: string;
  renderFrame: (request: ComponentIsolatedRenderRequest) => Promise<ComponentIsolatedRenderResult>;
  runAccessibility?: (request: ComponentIsolatedRenderRequest) => Promise<ComponentA11yResult>;
}

export interface ComponentIsolatedRendererCapability {
  readonly protocolVersion: typeof COMPONENT_ISOLATED_RENDERER_PROTOCOL;
  readonly projectIdentity: string;
  renderFrame: (request: ComponentIsolatedRenderRequest) => Promise<ComponentIsolatedRenderResult>;
  runAccessibility?: (request: ComponentIsolatedRenderRequest) => Promise<ComponentA11yResult>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 4096;
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value);
}

function hasAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('file:');
}

function staticValueIsBounded(value: unknown, depth = 0): value is StaticValue {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'string':
      return typeof record.value === 'string' && record.value.length <= 8192;
    case 'number':
      return typeof record.value === 'number' && Number.isFinite(record.value);
    case 'boolean':
      return typeof record.value === 'boolean';
    case 'null':
      return record.value === null;
    case 'array':
      return (
        Array.isArray(record.value) &&
        record.value.length <= 128 &&
        record.value.every((item) => staticValueIsBounded(item, depth + 1))
      );
    case 'object':
      return (
        !!record.value &&
        typeof record.value === 'object' &&
        !Array.isArray(record.value) &&
        Object.keys(record.value as Record<string, unknown>).length <= 128 &&
        Object.values(record.value as Record<string, unknown>).every((item) =>
          staticValueIsBounded(item, depth + 1)
        )
      );
    default:
      return false;
  }
}

function requestIsSafe(request: ComponentIsolatedRenderRequest, projectIdentity: string): boolean {
  if (
    request.protocolVersion !== COMPONENT_ISOLATED_RENDERER_PROTOCOL ||
    request.projectIdentity !== projectIdentity ||
    !isNonEmptyString(request.frameId) ||
    !isNonEmptyString(request.componentId) ||
    !isNonEmptyString(request.sourceRevision) ||
    (request.baselineFingerprint !== undefined &&
      (!isNonEmptyString(request.baselineFingerprint) ||
        request.baselineFingerprint.length > 512)) ||
    hasAbsolutePath(request.projectIdentity) ||
    hasAbsolutePath(request.componentId) ||
    !Object.entries(request.props).every(
      ([name, value]) => isNonEmptyString(name) && name.length <= 160 && staticValueIsBounded(value)
    ) ||
    !Object.entries(request.slots).every(
      ([name, value]) => isNonEmptyString(name) && name.length <= 160 && value.length <= 32_768
    )
  ) {
    return false;
  }
  return JSON.stringify(request).length <= COMPONENT_RENDERER_MAX_REQUEST_BYTES;
}

function resultIsSafe(
  result: ComponentIsolatedRenderResult,
  request: ComponentIsolatedRenderRequest,
  projectIdentity: string
): boolean {
  return (
    result.protocolVersion === COMPONENT_ISOLATED_RENDERER_PROTOCOL &&
    result.projectIdentity === projectIdentity &&
    result.frameId === request.frameId &&
    result.sourceRevision === request.sourceRevision &&
    isImageDataUrl(result.imageDataUrl) &&
    result.imageDataUrl.length <= COMPONENT_RENDERER_MAX_IMAGE_CHARS &&
    isNonEmptyString(result.renderFingerprint) &&
    result.renderFingerprint.length <= 512 &&
    isFinitePositive(result.width) &&
    isFinitePositive(result.height) &&
    (result.pixelDifference === undefined ||
      (typeof result.pixelDifference === 'number' &&
        Number.isFinite(result.pixelDifference) &&
        result.pixelDifference >= 0 &&
        result.pixelDifference <= 1 &&
        request.baselineFingerprint !== undefined &&
        result.comparedBaselineFingerprint === request.baselineFingerprint)) &&
    (result.comparedBaselineFingerprint === undefined ||
      result.comparedBaselineFingerprint === request.baselineFingerprint) &&
    (result.screenshotPath === undefined ||
      (isNonEmptyString(result.screenshotPath) && result.screenshotPath.length <= 4096))
  );
}

function accessibilityResultIsSafe(
  result: ComponentA11yResult,
  request: ComponentIsolatedRenderRequest
): boolean {
  return (
    !!result &&
    result.frameId === request.frameId &&
    result.sourceRevision === request.sourceRevision &&
    isNonEmptyString(result.checkedAt) &&
    Array.isArray(result.findings) &&
    result.findings.length <= 128 &&
    result.findings.every(
      (finding) =>
        isNonEmptyString(finding.id) &&
        ['minor', 'moderate', 'serious', 'critical'].includes(finding.impact) &&
        isNonEmptyString(finding.message) &&
        finding.message.length <= 4096 &&
        (finding.helpUrl === undefined ||
          (typeof finding.helpUrl === 'string' && finding.helpUrl.length <= 2048)) &&
        (finding.elementRef === undefined ||
          (typeof finding.elementRef === 'string' && finding.elementRef.length <= 512))
    )
  );
}

/** Convert a frame to the only request shape a host is allowed to receive. */
export function createComponentIsolatedRenderRequest(
  frame: ComponentCanvasFrame,
  component: Pick<ComponentDescriptor, 'id' | 'dialect'>,
  sourceRevision: string,
  projectIdentity: string,
  baselineFingerprint?: string
): ComponentIsolatedRenderRequest {
  return {
    protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
    projectIdentity,
    frameId: frame.id,
    componentId: component.id,
    dialect: component.dialect,
    sourceRevision,
    ...(baselineFingerprint ? { baselineFingerprint } : {}),
    props: frame.props,
    slots: frame.slots,
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

/**
 * Accept a host only after its protocol and project identity are proven. The
 * wrapper validates both requests and responses, so an untrusted or stale
 * host can only fail closed; it cannot make the Canvas claim a render.
 */
export function createComponentIsolatedRendererCapability(
  host: ComponentIsolatedRendererHost | null | undefined,
  projectIdentity: string
): ComponentIsolatedRendererCapability | null {
  if (
    !host ||
    host.protocolVersion !== COMPONENT_ISOLATED_RENDERER_PROTOCOL ||
    !isNonEmptyString(projectIdentity) ||
    host.projectIdentity !== projectIdentity ||
    hasAbsolutePath(projectIdentity) ||
    typeof host.renderFrame !== 'function'
  ) {
    return null;
  }

  return {
    protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
    projectIdentity,
    renderFrame: async (request) => {
      if (!requestIsSafe(request, projectIdentity)) {
        throw new Error('The isolated renderer request was refused by its safety boundary.');
      }
      const result = await host.renderFrame(request);
      if (!resultIsSafe(result, request, projectIdentity)) {
        throw new Error('The isolated renderer returned an invalid or stale frame.');
      }
      return result;
    },
    ...(host.runAccessibility
      ? {
          runAccessibility: async (request: ComponentIsolatedRenderRequest) => {
            if (!requestIsSafe(request, projectIdentity)) {
              throw new Error(
                'The isolated accessibility request was refused by its safety boundary.'
              );
            }
            const result = await host.runAccessibility!(request);
            if (!accessibilityResultIsSafe(result, request)) {
              throw new Error('The isolated accessibility result was invalid or stale.');
            }
            return result;
          },
        }
      : {}),
  };
}
