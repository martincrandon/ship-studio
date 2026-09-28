import { COMPONENT_CANVAS_MAX_LOGICAL_NODES } from './canvas';
import {
  COMPONENT_RENDERER_STAGE_CONTRACT,
  COMPONENT_RENDERER_STAGE_MAX_FRAMES,
  COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION,
} from './renderer-stage';
import { COMPONENT_RENDERER_SESSION_PROTOCOL } from './renderer-session';
import type { RendererFramePayload } from './renderer-session';
import type { ComponentIndex } from './types';
import {
  serializeRendererRegistry,
  type RendererRegistryEntry,
  type RendererRegistryResult,
} from './renderer-registry';
import { buildRendererInspectorRuntimeSource } from './renderer-inspector-runtime';

export type NextRouterKind = 'app' | 'pages';

/**
 * The generated host is a project-runtime integration, not a second iframe
 * per canvas node. Keep this version independent from the session protocol so
 * changing the stage shape invalidates the project-scoped setup consent.
 */
export const NEXT_RENDERER_HOST_INTEGRATION_VERSION = 'next-host-v2' as const;
export const NEXT_RENDERER_STAGE_VERSION = COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION;
export const NEXT_RENDERER_STAGE_CONTRACT = COMPONENT_RENDERER_STAGE_CONTRACT;
export const NEXT_RENDERER_STAGE_MAX_FRAMES = Math.min(
  COMPONENT_CANVAS_MAX_LOGICAL_NODES,
  COMPONENT_RENDERER_STAGE_MAX_FRAMES
);
export const NEXT_RENDERER_STAGE_MAX_ID_LENGTH = 256;

export interface NextRendererStageLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

/** Full frame sent in the authenticated protocol-3 sync command. */
export interface NextRendererStageFrame extends RendererFramePayload {
  /** Stable canvas node/frame identity. This is never a display label. */
  layout: NextRendererStageLayout;
  visible?: boolean;
}

/** The initial GET /stage response is a protocol-2 snapshot, not the sync. */
export interface NextRendererStageSnapshot {
  protocolVersion: typeof COMPONENT_RENDERER_SESSION_PROTOCOL;
  sessionId: string;
  generation: number;
  frames: RendererFramePayload[];
}

export interface NextRendererStageSyncPayload {
  protocolVersion: typeof COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION;
  contract: typeof COMPONENT_RENDERER_STAGE_CONTRACT;
  type: 'sync';
  sessionId: string;
  capabilityToken: string;
  generation: number;
  stageId: string;
  frames: NextRendererStageFrame[];
  camera: { x: number; y: number; zoom: number; owner: 'parent' };
  selectedFrameId: string | null;
  inputFrameId: string | null;
  retainFrameIds: string[];
  revealFrameIds: string[];
}

/** Backwards-compatible name for callers that only need the stage snapshot. */
export type NextRendererStagePayload = NextRendererStageSnapshot;

export interface NextRendererStageFrameDescriptor {
  frameId: string;
  componentId: string;
  componentRevision: string;
  /** Absolute canvas coordinates, in the same logical space as the canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  order: number;
  rotation?: number;
}

function stageStringIsSafe(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\r\n]/.test(value)
  );
}

function stageNumberIsSafe(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function stageSnapshotFrameIsSafe(
  value: unknown,
  sessionId: string,
  generation: number
): value is RendererFramePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.protocolVersion === COMPONENT_RENDERER_SESSION_PROTOCOL &&
    frame.sessionId === sessionId &&
    frame.generation === generation &&
    stageStringIsSafe(frame.frameId) &&
    stageStringIsSafe(frame.componentId) &&
    stageStringIsSafe(frame.componentRevision) &&
    !!frame.props &&
    typeof frame.props === 'object' &&
    !Array.isArray(frame.props) &&
    !!frame.slots &&
    typeof frame.slots === 'object' &&
    !Array.isArray(frame.slots) &&
    !!frame.presentation &&
    typeof frame.presentation === 'object' &&
    !Array.isArray(frame.presentation)
  );
}

/** Validate the authenticated initial GET /stage snapshot. */
export function isNextRendererStagePayload(value: unknown): value is NextRendererStagePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stage = value as Record<string, unknown>;
  if (
    stage.protocolVersion !== COMPONENT_RENDERER_SESSION_PROTOCOL ||
    !stageStringIsSafe(stage.sessionId) ||
    !Number.isInteger(stage.generation) ||
    !stageNumberIsSafe(stage.generation, 1, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(stage.frames) ||
    stage.frames.length === 0 ||
    stage.frames.length > NEXT_RENDERER_STAGE_MAX_FRAMES
  ) {
    return false;
  }
  const sessionId = stage.sessionId;
  const generation = stage.generation;
  const frameIds = new Set<string>();
  return stage.frames.every((frame) => {
    if (!stageSnapshotFrameIsSafe(frame, sessionId, generation)) return false;
    if (frameIds.has(frame.frameId)) return false;
    frameIds.add(frame.frameId);
    return true;
  });
}

/** Encode only the opaque stage handle; the stage itself is fetched in the project runtime. */
export function encodeNextRendererStageId(stageId: string): string {
  if (!stageStringIsSafe(stageId, NEXT_RENDERER_STAGE_MAX_ID_LENGTH)) {
    throw new Error('The renderer stage id is invalid or exceeds its bounds.');
  }
  return encodeURIComponent(stageId);
}

export interface NextRendererHostOptions {
  sessionId: string;
  capabilityToken: string;
  sessionEndpoint: string;
  parentOrigin: string;
  /** Project-relative active workspace root (`.` for a single-package project). */
  workspaceRoot?: string;
  generation?: number;
  /** Stable route identity shared by read-only preflight and the live session. */
  routeIdentity?: string;
  explicitDecoratorModule?: string | null;
  explicitDecoratorExportName?: string | null;
  explicitStylesheets?: string[];
  /** Optional source contents used for fail-closed Pages Router compatibility checks. */
  runtimeFiles?: readonly NextRuntimeSourceFile[];
  /** False means the source inventory omitted files and cannot prove routing facts. */
  runtimeSnapshotComplete?: boolean;
}

export interface NextRuntimeSourceFile {
  file: string;
  content: string;
}

export interface NextPagesRuntimeCompatibility {
  supported: boolean;
  configFiles: string[];
  middlewareFiles: string[];
  blockers: string[];
}

export interface GeneratedNextRendererFile {
  relativePath: string;
  contents: string;
  kind: 'route' | 'client-shell' | 'registry' | 'loading';
}

export type NextRendererHostPlan =
  | {
      supported: true;
      router: NextRouterKind;
      routeSegment: string;
      routeFile: string;
      files: GeneratedNextRendererFile[];
      supportedComponentIds: string[];
      sourceRevision: string;
      setupReason: string;
    }
  | {
      supported: false;
      reason: string;
    };

const MAX_HOST_FILES = 4;
const MAX_ROUTE_ATTEMPTS = 32;

/**
 * Detects the Next router from indexed project paths only. An app and pages
 * tree together are ambiguous because their providers and URL semantics may
 * differ, so setup remains catalog-only until the user resolves it.
 */
export function detectNextRouter(
  projectFiles: readonly string[],
  workspaceRoot = '.'
): { kind: NextRouterKind; root: 'root' | 'src' } | { kind: 'unsupported'; reason: string } {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (normalizedWorkspaceRoot === null) {
    return {
      kind: 'unsupported',
      reason: 'The active workspace root is not a safe project-relative path.',
    };
  }
  const files = new Set(
    projectFiles
      .map(normalizeProjectPath)
      .map((file) => relativeWorkspacePath(file, normalizedWorkspaceRoot))
      .filter((file): file is string => file !== null)
  );
  const appRoots = ['app', 'src/app'].filter((root) => hasDirectory(files, root));
  const pagesRoots = ['pages', 'src/pages'].filter((root) => hasDirectory(files, root));

  if (appRoots.length > 1 || pagesRoots.length > 1) {
    return {
      kind: 'unsupported',
      reason:
        'The project contains duplicate Next router roots; renderer setup needs an explicit root.',
    };
  }
  if (appRoots.length > 0 && pagesRoots.length > 0) {
    return {
      kind: 'unsupported',
      reason:
        'The project contains both an App Router and Pages Router tree; renderer setup is ambiguous.',
    };
  }
  if (appRoots.length === 1) {
    return { kind: 'app', root: appRoots[0] === 'src/app' ? 'src' : 'root' };
  }
  if (pagesRoots.length === 1) {
    return { kind: 'pages', root: pagesRoots[0] === 'src/pages' ? 'src' : 'root' };
  }
  return {
    kind: 'unsupported',
    reason: 'No unambiguous Next App Router or Pages Router directory was found.',
  };
}

/** Builds a reviewable, collision-safe host without importing project code. */
export function buildNextRendererHostPlan(
  index: Pick<ComponentIndex, 'revision'>,
  registry: RendererRegistryResult,
  projectFiles: readonly string[],
  options: NextRendererHostOptions
): NextRendererHostPlan {
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot ?? '.');
  if (workspaceRoot === null) {
    return {
      supported: false,
      reason: 'The active workspace root is not a safe project-relative path.',
    };
  }
  const router = detectNextRouter(projectFiles, workspaceRoot);
  if (router.kind === 'unsupported') return { supported: false, reason: router.reason };
  if (!isSafeLoopbackUrl(options.sessionEndpoint)) {
    return {
      supported: false,
      reason: 'The renderer session endpoint must be an explicit HTTP loopback URL.',
    };
  }
  if (!isSafeOrigin(options.parentOrigin)) {
    return {
      supported: false,
      reason: 'The renderer parent origin must be an explicit origin without credentials or paths.',
    };
  }
  if (
    !isSafeOpaqueValue(options.sessionId, 256) ||
    !isSafeOpaqueValue(options.capabilityToken, 256)
  ) {
    return { supported: false, reason: 'The renderer session identity is malformed.' };
  }
  if (options.explicitDecoratorModule && !isSafeProjectPath(options.explicitDecoratorModule)) {
    return {
      supported: false,
      reason: 'The selected decorator module is not a safe project-relative path.',
    };
  }
  if (
    options.explicitDecoratorExportName !== undefined &&
    options.explicitDecoratorExportName !== null &&
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(options.explicitDecoratorExportName)
  ) {
    return {
      supported: false,
      reason: 'The selected decorator export name is not a safe identifier.',
    };
  }
  if (registry.sourceRevision !== index.revision) {
    return {
      supported: false,
      reason: 'The reviewed renderer registry is stale; refresh the component catalog first.',
    };
  }
  if ((options.explicitStylesheets ?? []).some((file) => !isSafeProjectPath(file))) {
    return {
      supported: false,
      reason: 'A selected global stylesheet is not a safe project-relative path.',
    };
  }

  const runtimeFiles = (options.runtimeFiles ?? []).flatMap((file) => {
    const relative = relativeWorkspacePath(normalizeProjectPath(file.file), workspaceRoot);
    return relative === null ? [] : [{ ...file, file: relative }];
  });

  if (router.kind === 'pages') {
    if (options.runtimeSnapshotComplete === false) {
      return {
        supported: false,
        reason:
          'Pages Router compatibility cannot be verified from a partial source snapshot; refresh the catalog first.',
      };
    }
    const compatibility = inspectNextPagesRuntimeCompatibility(runtimeFiles);
    if (!compatibility.supported) {
      return {
        supported: false,
        reason: `Pages Router runtime compatibility needs explicit review: ${compatibility.blockers.join(' ')}`,
      };
    }
  }

  const supportedEntries = registry.entries.filter((entry) => entry.supported);
  if (supportedEntries.length === 0) {
    return {
      supported: false,
      reason: 'No parser-proven React component can enter the reviewed renderer registry.',
    };
  }
  if (supportedEntries.length > 200 || registry.entries.length > 200) {
    return {
      supported: false,
      reason: 'The renderer registry exceeds the bounded component limit.',
    };
  }

  const files = new Set(projectFiles.map(normalizeProjectPath));
  const routeRoot = router.root === 'src' ? 'src' : '';
  const workspaceRouteDirectory =
    router.kind === 'app'
      ? `${routeRoot ? `${routeRoot}/` : ''}app`
      : `${routeRoot ? `${routeRoot}/` : ''}pages`;
  const routeDirectory = joinWorkspacePath(workspaceRoot, workspaceRouteDirectory);
  const routeSegment = allocateRouteSegment(
    files,
    routeDirectory,
    options.routeIdentity ?? options.sessionId,
    router.kind
  );
  if (!routeSegment) {
    return {
      supported: false,
      reason: 'Could not allocate a collision-free temporary renderer route.',
    };
  }
  const routeFile =
    router.kind === 'app'
      ? `${routeDirectory}/${routeSegment}/page.tsx`
      : `${routeDirectory}/${routeSegment}.tsx`;
  // A file nested under `pages` becomes another Next page. Keep the Pages
  // Router client shell in the project-owned integration directory instead.
  const shellFile =
    router.kind === 'app'
      ? `${routeDirectory}/${routeSegment}/__shipstudio_renderer_shell.tsx`
      : joinWorkspacePath(
          workspaceRoot,
          `.shipstudio/component-renderer/${routeSegment}/shell.tsx`
        );
  const imports = buildRegistryImports(supportedEntries, routeFile);
  const registrySource = buildRegistrySource(imports);
  const shellImport = relativeImport(routeFile, shellFile);
  const routeContents = buildRouteSource({
    router: router.kind,
    registrySource,
    shellImport,
    options,
    routeFile,
    decoratorModule: options.explicitDecoratorModule,
    decoratorExportName: options.explicitDecoratorExportName,
  });
  const shellContents = buildClientShellSource();
  const registryFile: GeneratedNextRendererFile = {
    relativePath: '.shipstudio/component-renderer/registry.json',
    contents: serializeRendererRegistry(registry),
    kind: 'registry',
  };
  const generatedFiles: GeneratedNextRendererFile[] = [
    { relativePath: routeFile, contents: routeContents, kind: 'route' },
    { relativePath: shellFile, contents: shellContents, kind: 'client-shell' },
    registryFile,
  ];
  if (router.kind === 'app') {
    generatedFiles.push({
      relativePath: `${routeDirectory}/${routeSegment}/loading.tsx`,
      contents: buildLoadingSource(),
      kind: 'loading',
    });
  }
  if (generatedFiles.length > MAX_HOST_FILES) {
    return { supported: false, reason: 'The generated renderer host exceeded its file bound.' };
  }

  return {
    supported: true,
    router: router.kind,
    routeSegment,
    routeFile,
    files: generatedFiles,
    supportedComponentIds: supportedEntries.map((entry) => entry.componentId),
    sourceRevision: index.revision,
    setupReason:
      'The route inherits the project framework runtime; provider and stylesheet additions remain explicit setup choices.',
  };
}

/**
 * Checks the Pages Router assumptions that cannot be proven from route names.
 * This deliberately does not evaluate next.config or middleware. Unknown or
 * custom routing behavior stays catalog-only with setup guidance instead of
 * generating a route that may be hidden, rewritten, or served at the wrong URL.
 */
export function inspectNextPagesRuntimeCompatibility(
  files: readonly NextRuntimeSourceFile[]
): NextPagesRuntimeCompatibility {
  const normalizedFiles = files.map((file) => ({
    file: normalizeProjectPath(file.file),
    content: file.content,
  }));
  const configFiles = normalizedFiles
    .filter(({ file }) => /^next\.config\.(?:js|cjs|mjs|ts)$/.test(file))
    .map(({ file }) => file)
    .sort();
  const middlewareFiles = normalizedFiles
    .filter(({ file }) => /(^|\/)(?:src\/)?middleware\.(?:js|cjs|mjs|ts|tsx)$/.test(file))
    .map(({ file }) => file)
    .sort();
  const blockers: string[] = [];

  for (const file of normalizedFiles.filter(({ file }) => configFiles.includes(file))) {
    const basePath = nextConfigProperty(file.content, 'basePath');
    if (basePath !== null) {
      blockers.push(
        basePath.kind === 'literal'
          ? `next.config sets basePath to ${JSON.stringify(basePath.value)}; verify the renderer route through that base path before enabling it.`
          : 'next.config contains a dynamic basePath; its runtime route prefix cannot be verified safely.'
      );
    }
    const assetPrefix = nextConfigProperty(file.content, 'assetPrefix');
    if (assetPrefix !== null) {
      blockers.push(
        assetPrefix.kind === 'literal'
          ? `next.config sets assetPrefix to ${JSON.stringify(assetPrefix.value)}; verify renderer assets under the configured prefix before enabling it.`
          : 'next.config contains a dynamic assetPrefix; renderer asset URLs cannot be verified safely.'
      );
    }
    if (/\bi18n\s*:|\blocales\s*:|\bdefaultLocale\s*:/.test(file.content)) {
      blockers.push(
        'next.config contains locale routing; choose and verify the renderer locale route explicitly before enabling it.'
      );
    }
  }

  if (
    normalizedFiles.some(({ file }) =>
      /(?:^|\/)\[[^/\]]*(?:locale|lang)[^/\]]*\](?:\/|$)/i.test(file)
    )
  ) {
    blockers.push(
      'The Pages Router contains a locale-like dynamic route segment; verify the renderer route for the active locale before enabling it.'
    );
  }
  if (middlewareFiles.length > 0) {
    blockers.push(
      `Middleware may rewrite or block the renderer route (${middlewareFiles.join(', ')}); verify it explicitly or add a reviewed exception without Ship Studio modifying it.`
    );
  }

  return { supported: blockers.length === 0, configFiles, middlewareFiles, blockers };
}

function nextConfigProperty(
  content: string,
  property: 'basePath' | 'assetPrefix'
): { kind: 'literal'; value: string } | { kind: 'dynamic' } | null {
  const match = new RegExp(`\\b${property}\\s*:\\s*(['"])(.*?)\\1`, 's').exec(content);
  if (match) return { kind: 'literal', value: match[2] ?? '' };
  return new RegExp(`\\b${property}\\s*:`).test(content) ? { kind: 'dynamic' } : null;
}

function buildRegistryImports(
  entries: readonly RendererRegistryEntry[],
  routeFile: string
): Array<{ entry: RendererRegistryEntry; localName: string; importPath: string }> {
  return entries.map((entry, index) => ({
    entry,
    localName: `ShipStudioComponent${index}`,
    importPath: relativeImport(routeFile, entry.modulePath),
  }));
}

function buildRegistrySource(
  imports: ReadonlyArray<{
    entry: RendererRegistryEntry;
    localName: string;
    importPath: string;
  }>
): string {
  const importLines = imports.map(({ entry, localName, importPath }) =>
    entry.exportKind === 'default'
      ? `import ${localName} from ${jsonLiteral(importPath)};`
      : `import { ${entry.exportName} as ${localName} } from ${jsonLiteral(importPath)};`
  );
  const registryLines = imports.map(
    ({ entry, localName }) =>
      `  ${jsonLiteral(entry.componentId)}: { Component: ${localName}, revision: ${jsonLiteral(entry.sourceRevision)}, renderRoot: ${jsonValue(entry.renderRoot ?? null)} },`
  );
  return [...importLines, '', 'const componentRegistry = {', ...registryLines, '} as const;'].join(
    '\n'
  );
}

function buildRendererRoutePrelude(
  input: {
    shellImport: string;
    options: NextRendererHostOptions;
    registrySource: string;
  },
  decoratorImport: string,
  decoratorStart: string,
  decoratorEnd: string
): string[] {
  return [
    '/* Ship Studio component renderer host; generated after explicit review. */',
    "import { Fragment, createElement, type ComponentType } from 'react';",
    `import RendererFrameShell, { RendererStageShell } from ${jsonLiteral(input.shellImport)};`,
    decoratorImport.trimEnd(),
    input.registrySource,
    '',
    `const SESSION_ENDPOINT = ${jsonLiteral(input.options.sessionEndpoint)};`,
    `const SESSION_ID = ${jsonLiteral(input.options.sessionId)};`,
    `const CAPABILITY_TOKEN = ${jsonLiteral(input.options.capabilityToken)};`,
    `const PARENT_ORIGIN = ${jsonLiteral(input.options.parentOrigin)};`,
    `const GENERATION = ${String(input.options.generation ?? 1)};`,
    'const PROTOCOL_VERSION = 2;',
    'const STAGE_PROTOCOL_VERSION = 3;',
    'const STAGE_CONTRACT = "next-host-v2";',
    'const MAX_STAGE_FRAMES = 200;',
    'const MAX_STAGE_ID_LENGTH = 256;',
    '',
    'type StaticValue = { kind: string; value?: unknown };',
    'type RendererRoot = { tag: string; classTokens: string[]; id: string | null; source: { file: string; start: number; end: number; line: number; column: number; contentHash: string } };',
    'type FramePayload = { protocolVersion: number; projectIdentity: string; sessionId: string; frameId: string; componentId: string; componentRevision: string; generation: number; props: Record<string, StaticValue>; slots: Record<string, string> };',
    'type StagePayload = { protocolVersion: number; sessionId: string; generation: number; frames: FramePayload[] };',
    'type StageLayout = { frameId: string; x: number; y: number; width: number; height: number; rotation?: number; visible?: boolean };',
    'type StageResult = { requested: FramePayload; frame: FramePayload | null; error: string | null };',
    '',
    'function scalar(value: StaticValue): unknown {',
    "  if (value.kind === 'array' && Array.isArray(value.value)) return value.value.map((item) => scalar(item as StaticValue));",
    "  if (value.kind === 'object' && value.value && typeof value.value === 'object') return Object.fromEntries(Object.entries(value.value as Record<string, StaticValue>).map(([key, item]) => [key, scalar(item)]));",
    '  return value.value ?? null;',
    '}',
    '',
    'function safeStageString(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\\r\\n]/.test(value); }',
    'function safeStageNumber(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }',
    'function safeSnapshotFrame(value: unknown, sessionId: string, generation: number): value is FramePayload {',
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return false;',
    '  const frame = value as Record<string, unknown>;',
    '  return frame.protocolVersion === PROTOCOL_VERSION && frame.sessionId === sessionId && frame.generation === generation && safeStageString(frame.frameId) && safeStageString(frame.componentId) && safeStageString(frame.componentRevision) && !!frame.props && typeof frame.props === "object" && !Array.isArray(frame.props) && !!frame.slots && typeof frame.slots === "object" && !Array.isArray(frame.slots) && !!frame.presentation && typeof frame.presentation === "object" && !Array.isArray(frame.presentation);',
    '}',
    'function parseStageResponse(value: unknown): StagePayload {',
    '  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-stage");',
    '  const stage = value as Record<string, unknown>;',
    '  if (stage.protocolVersion !== PROTOCOL_VERSION || stage.sessionId !== SESSION_ID || stage.generation !== GENERATION || !Array.isArray(stage.frames) || stage.frames.length === 0 || stage.frames.length > MAX_STAGE_FRAMES) throw new Error("invalid-stage");',
    '  const seen = new Set<string>();',
    '  if (!stage.frames.every((frame) => safeSnapshotFrame(frame, SESSION_ID, GENERATION) && !seen.has(frame.frameId) && (seen.add(frame.frameId), true))) throw new Error("invalid-stage");',
    '  return stage as StagePayload;',
    '}',
    '',
    'async function readFrame(frameId: string): Promise<FramePayload> {',
    '  if (!safeStageString(frameId)) throw new Error("invalid-frame-id");',
    '  const response = await fetch(`${SESSION_ENDPOINT}/${encodeURIComponent(SESSION_ID)}/frame/${encodeURIComponent(frameId)}`, {',
    '    headers: { Authorization: `Bearer ${CAPABILITY_TOKEN}` },',
    '    cache: "no-store",',
    '  });',
    '  if (!response.ok) throw new Error(`frame-${response.status}`);',
    '  return (await response.json()) as FramePayload;',
    '}',
    '',
    'async function readStage(stageId: string): Promise<StagePayload> {',
    '  if (!safeStageString(stageId, MAX_STAGE_ID_LENGTH)) throw new Error("invalid-stage-id");',
    '  const response = await fetch(`${SESSION_ENDPOINT}/${encodeURIComponent(SESSION_ID)}/stage?stageId=${encodeURIComponent(stageId)}`, {',
    '    headers: { Authorization: `Bearer ${CAPABILITY_TOKEN}` },',
    '    cache: "no-store",',
    '  });',
    '  if (!response.ok) throw new Error(`stage-${response.status}`);',
    '  return parseStageResponse(await response.json());',
    '}',
    '',
    'function renderFrame(frame: FramePayload, isolateDocument = true, stageId?: string) {',
    '  if (frame.protocolVersion !== PROTOCOL_VERSION || frame.sessionId !== SESSION_ID || frame.generation !== GENERATION) throw new Error("stale-frame");',
    '  const entry = (componentRegistry as Record<string, { Component: ComponentType<Record<string, unknown>>; revision: string; renderRoot: RendererRoot | null }>)[frame.componentId];',
    '  if (!entry) throw new Error("unsupported-component");',
    '  if (entry.revision !== frame.componentRevision) throw new Error("stale-revision");',
    '  const props = Object.fromEntries(Object.entries(frame.props ?? {}).map(([key, value]) => [key, scalar(value)]));',
    '  for (const [slot, text] of Object.entries(frame.slots ?? {})) props[slot] = text;',
    '  const child = createElement(entry.Component, props);',
    '  return (',
    `    <RendererFrameShell frame={frame} root={entry.renderRoot ?? undefined} isolateDocument={isolateDocument} stageId={stageId} capabilityToken={CAPABILITY_TOKEN} parentOrigin={PARENT_ORIGIN}>`,
    `      ${decoratorStart}{child}${decoratorEnd}`,
    '    </RendererFrameShell>',
    '  );',
    '}',
    '',
    'function rendererError(error: unknown, frame?: FramePayload, stageId?: string) {',
    '  const message = error instanceof Error ? error.message.slice(0, 256) : "renderer-failed";',
    '  return <RendererFrameShell frame={frame} stageId={stageId} errorCode="renderer-failed" errorMessage={message} capabilityToken={CAPABILITY_TOKEN} parentOrigin={PARENT_ORIGIN} />;',
    '}',
    '',
    'async function readStageFrames(stage: StagePayload): Promise<StageResult[]> {',
    '  return stage.frames.map((requested) => {',
    '    try {',
    '      return { requested, frame: requested, error: null };',
    '    } catch (error) {',
    '      return { requested, frame: null, error: error instanceof Error ? error.message.slice(0, 256) : "frame-failed" };',
    '    }',
    '  });',
    '}',
    '',
    'function initialStageLayouts(frames: FramePayload[]): StageLayout[] {',
    '  return frames.map((frame, index) => ({ frameId: frame.frameId, x: 0, y: index * 16, width: typeof frame.presentation.width === "number" ? frame.presentation.width : 320, height: typeof frame.presentation.height === "number" ? frame.presentation.height : 240, visible: false }));',
    '}',
    '',
    'function renderStage(stage: StagePayload, results: StageResult[], stageIdForRuntime: string) {',
    '  return (',
    '    <RendererStageShell sessionId={SESSION_ID} capabilityToken={CAPABILITY_TOKEN} generation={GENERATION} stageId={stageIdForRuntime} parentOrigin={PARENT_ORIGIN} frames={initialStageLayouts(stage.frames)} frameIdentities={stage.frames.map((frame) => ({ frameId: frame.frameId, componentId: frame.componentId, componentRevision: frame.componentRevision }))}>',
    '      {results.map(({ requested, frame, error }) => {',
    '        if (!frame) return <div key={requested.frameId} data-shipstudio-renderer-error="frame-failed" data-shipstudio-frame-id={requested.frameId}>{error ?? "Frame failed"}</div>;',
    '        try { return <Fragment key={requested.frameId}>{renderFrame(frame, false, stageIdForRuntime)}</Fragment>; } catch (renderError) { return <Fragment key={requested.frameId}>{rendererError(renderError, frame, stageIdForRuntime)}</Fragment>; }',
    '      })}',
    '    </RendererStageShell>',
    '  );',
    '}',
  ];
}

function buildRouteSource(input: {
  router: NextRouterKind;
  registrySource: string;
  shellImport: string;
  options: NextRendererHostOptions;
  routeFile: string;
  decoratorModule?: string | null;
  decoratorExportName?: string | null;
}): string {
  const decoratorImport = input.decoratorModule
    ? `import { ${input.decoratorExportName ?? 'default'} as Decorator } from ${jsonLiteral(relativeImport(input.routeFile, input.decoratorModule))};\n`
    : '';
  const decoratorStart = input.decoratorModule ? '<Decorator>' : '<>';
  const decoratorEnd = input.decoratorModule ? '</Decorator>' : '</>';
  if (input.router === 'pages') {
    return buildPagesRouteSource(input, decoratorImport, decoratorStart, decoratorEnd);
  }
  const functionSignature =
    input.router === 'app'
      ? 'export default async function ShipStudioRendererPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined> }) {'
      : 'export default async function ShipStudioRendererPage({ query }: { query: Record<string, string | string[] | undefined> }) {';
  const paramsExpression = input.router === 'app' ? 'await searchParams' : 'query';
  return [
    ...buildRendererRoutePrelude(input, decoratorImport, decoratorStart, decoratorEnd),
    '',
    functionSignature,
    `  const params = ${paramsExpression};`,
    '  const rawStageId = params.stageId;',
    '  const stageId = Array.isArray(rawStageId) ? rawStageId[0] : rawStageId;',
    '  if (stageId) {',
    '    try {',
    '      const stage = await readStage(stageId);',
    '      return renderStage(stage, await readStageFrames(stage), stageId);',
    '    } catch (error) {',
    '      return <div data-shipstudio-renderer-error="stage-failed">{error instanceof Error ? error.message.slice(0, 256) : "stage-failed"}</div>;',
    '    }',
    '  }',
    '  const rawFrameId = params.frameId;',
    '  const frameId = Array.isArray(rawFrameId) ? rawFrameId[0] : rawFrameId;',
    '  try {',
    '    const frame = await readFrame(frameId ?? "");',
    '    return renderFrame(frame);',
    '  } catch (error) {',
    '    return rendererError(error);',
    '  }',
    '}',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Pages Router pages do not receive the URL query as component props. Read it
 * in getServerSideProps so the generated host renders the same reviewed frame
 * payload as the App Router route instead of silently rendering a blank page.
 */
function buildPagesRouteSource(
  input: {
    registrySource: string;
    shellImport: string;
    options: NextRendererHostOptions;
    routeFile: string;
    decoratorModule?: string | null;
    decoratorExportName?: string | null;
  },
  decoratorImport: string,
  decoratorStart: string,
  decoratorEnd: string
): string {
  return [
    ...buildRendererRoutePrelude(input, decoratorImport, decoratorStart, decoratorEnd),
    '',
    'export async function getServerSideProps({ query }: { query: Record<string, string | string[] | undefined> }) {',
    '  const rawStageId = query?.stageId;',
    '  const stageId = Array.isArray(rawStageId) ? rawStageId[0] : rawStageId;',
    '  if (stageId) {',
    '    try {',
    '      const stage = await readStage(stageId);',
    '      return { props: { stage, stageResults: await readStageFrames(stage), stageId } };',
    '    } catch (error) {',
    '      return { props: { stageError: error instanceof Error ? error.message.slice(0, 256) : "stage-failed" } };',
    '    }',
    '  }',
    '  const rawFrameId = query?.frameId;',
    '  const frameId = Array.isArray(rawFrameId) ? rawFrameId[0] : rawFrameId;',
    '  try {',
    '    return { props: { frame: await readFrame(frameId ?? "") } };',
    '  } catch (error) {',
    '    return { props: { errorMessage: error instanceof Error ? error.message.slice(0, 256) : "renderer-failed" } };',
    '  }',
    '}',
    '',
    'export default function ShipStudioRendererPage({ frame, errorMessage, stage, stageResults, stageError, stageId }: { frame?: FramePayload; errorMessage?: string; stage?: StagePayload; stageResults?: StageResult[]; stageError?: string; stageId?: string }) {',
    '  if (stage) return renderStage(stage, stageResults ?? [], stageId ?? "");',
    '  if (stageError) return <div data-shipstudio-renderer-error="stage-failed">{stageError}</div>;',
    '  if (!frame) return <RendererFrameShell errorCode="renderer-failed" errorMessage={errorMessage ?? "renderer-failed"} capabilityToken={CAPABILITY_TOKEN} parentOrigin={PARENT_ORIGIN} />;',
    '  try {',
    '    return renderFrame(frame);',
    '  } catch (error) {',
    '    return rendererError(error);',
    '  }',
    '}',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function buildClientShellSource(): string {
  return [
    '/* Ship Studio component renderer host; generated after explicit review. */',
    "'use client';",
    "import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';",
    '',
    'const PROTOCOL_VERSION = 2;',
    'function safeRendererZoom(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 256; }',
    'const MAX_A11Y_FINDINGS = 128;',
    buildRendererInspectorRuntimeSource(),
    '',
    'function accessibilityElementRef(element: Element): string {',
    '  const parts: string[] = [];',
    '  let current: Element | null = element;',
    '  while (current && current !== document.body && parts.length < 8) {',
    '    const parent = current.parentElement;',
    '    if (!parent) break;',
    '    const index = Array.prototype.indexOf.call(parent.children, current) + 1;',
    '    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);',
    '    current = parent;',
    '  }',
    '  return `body>${parts.join(">")}`.slice(0, 512);',
    '}',
    '',
    'function accessibilityName(element: Element): string {',
    '  const labelledBy = element.getAttribute("aria-labelledby");',
    '  if (labelledBy) {',
    '    const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\\s+/g, " ").trim();',
    '    if (text) return text.slice(0, 256);',
    '  }',
    '  return (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 256);',
    '}',
    '',
    '',
    'type RendererCascadeRule = { selector: string | null; declarations: Array<{ prop: string; value: string; important: boolean; active: boolean }>; specificity: [number, number, number]; sourceOrder: number; mediaText: string | null; mediaMinPx: number | null; inactiveMedia: boolean; layer: string | null; container: string | null; supports: string | null; href: string | null; origin: "author" | "inline" };',
    'function cascadeSpecificity(selector: string): [number, number, number] {',
    '  const ids = (selector.match(/#[a-zA-Z0-9_-]+/g) ?? []).length;',
    '  const classes = (selector.match(/\\.[a-zA-Z0-9_-]+|\\[[^\\]]+\\]|:[a-zA-Z0-9_-]+/g) ?? []).length;',
    '  const tags = (selector.replace(/#[a-zA-Z0-9_-]+|\\.[a-zA-Z0-9_-]+|\\[[^\\]]+\\]|:[a-zA-Z0-9_-]+/g, " ").match(/[a-zA-Z][a-zA-Z0-9-]*/g) ?? []).length;',
    '  return [ids, classes, tags];',
    '}',
    'function collectCascadeRules(element: Element): RendererCascadeRule[] {',
    '  const result: RendererCascadeRule[] = []; let sourceOrder = 0;',
    '  const visit = (rules: CSSRuleList, sheet: CSSStyleSheet, mediaText: string | null, layer: string | null, supports: string | null) => {',
    '    for (let index = 0; index < rules.length && result.length < 128; index += 1) {',
    '      const rule = rules.item(index); if (!rule) continue; sourceOrder += 1;',
    '      const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;',
    '      if (rule.type === 1) {',
    '        const styleRule = rule as CSSStyleRule; let matches = false;',
    '        try { matches = element.matches(styleRule.selectorText); } catch { matches = false; }',
    '        if (!matches) continue;',
    '        const declarations: RendererCascadeRule["declarations"] = [];',
    '        for (let declaration = 0; declaration < styleRule.style.length && declaration < 64; declaration += 1) {',
    '          const prop = styleRule.style.item(declaration); if (!prop || prop.length > 128) continue;',
    '          declarations.push({ prop, value: styleRule.style.getPropertyValue(prop).slice(0, 512), important: styleRule.style.getPropertyPriority(prop) === "important", active: true });',
    '        }',
    '        if (declarations.length > 0) result.push({ selector: styleRule.selectorText.slice(0, 2048), declarations, specificity: cascadeSpecificity(styleRule.selectorText), sourceOrder, mediaText, mediaMinPx: mediaText ? Number(/min-width\\s*:\\s*([\\d.]+)px/i.exec(mediaText)?.[1] ?? NaN) || null : null, inactiveMedia: !!mediaText && !window.matchMedia(mediaText).matches, layer, container: null, supports, href: sheet.href ?? null, origin: "author" });',
    '      } else if (nested) {',
    '        const grouped = rule as CSSRule & { conditionText?: string; media?: MediaList; name?: string };',
    '        const nextMedia = rule.type === 4 ? (grouped.conditionText ?? grouped.media?.mediaText ?? null) : mediaText;',
    '        const nextSupports = rule.type === 12 ? (grouped.conditionText ?? null) : supports;',
    '        const nextLayer = grouped.name ?? layer;',
    '        visit(nested, sheet, nextMedia, nextLayer, nextSupports);',
    '      }',
    '    }',
    '  };',
    '  for (const sheet of Array.from(document.styleSheets)) { try { if (sheet.cssRules) visit(sheet.cssRules, sheet, null, null, null); } catch { /* cross-origin sheets are not trusted */ } }',
    '  return result;',
    '}',
    '',
    'function inspectAccessibility(): Array<{ id: string; impact: "minor" | "moderate" | "serious" | "critical"; message: string; elementRef: string }> {',
    '  const findings: Array<{ id: string; impact: "minor" | "moderate" | "serious" | "critical"; message: string; elementRef: string }> = [];',
    '  const report = (id: string, impact: "minor" | "moderate" | "serious" | "critical", message: string, element: Element) => {',
    '    if (findings.length < MAX_A11Y_FINDINGS) findings.push({ id, impact, message: message.slice(0, 4096), elementRef: accessibilityElementRef(element) });',
    '  };',
    '  document.querySelectorAll("img:not([aria-hidden=\\"true\\"]):not([role=\\"presentation\\"])").forEach((element) => {',
    '    if (!element.hasAttribute("alt")) report("image-alt", "serious", "Image is missing an alt attribute.", element);',
    '  });',
    '  document.querySelectorAll("button,[role=\\"button\\"],a[href]").forEach((element) => {',
    '    if (!accessibilityName(element)) report("interactive-name", "serious", "Interactive element has no accessible name.", element);',
    '  });',
    '  document.querySelectorAll("input:not([type=\\"hidden\\"]),select,textarea").forEach((element) => {',
    '    const id = element.getAttribute("id");',
    '    const labelled = !!element.getAttribute("aria-label") || !!element.getAttribute("aria-labelledby") || Array.from(document.querySelectorAll("label")).some((label) => (id && label.htmlFor === id) || label.contains(element));',
    '    if (!labelled) report("form-label", "serious", "Form control has no associated label.", element);',
    '  });',
    '  let previousHeading = 0;',
    '  document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((element) => {',
    '    const level = Number(element.tagName.slice(1));',
    '    if (previousHeading > 0 && level > previousHeading + 1) report("heading-order", "moderate", `Heading level jumps from h${previousHeading} to h${level}.`, element);',
    '    previousHeading = level;',
    '  });',
    '  return findings;',
    '}',
    '',
    'class RendererErrorBoundary extends Component<{ children?: ReactNode; onError: (error: unknown) => void }, { message: string | null }> {',
    '  state: { message: string | null } = { message: null };',
    '  static getDerivedStateFromError(error: unknown) { return { message: error instanceof Error ? error.message.slice(0, 256) : "renderer-failed" }; }',
    '  componentDidCatch(error: unknown) { this.props.onError(error); }',
    '  render() { return this.state.message ? <div data-shipstudio-renderer-error="render-threw">{this.state.message}</div> : this.props.children; }',
    '}',
    '',
    'export default function RendererFrameShell({ frame, root, children, isolateDocument = true, stageId, capabilityToken, parentOrigin, errorCode, errorMessage }: {',
    '  frame?: RendererFrame;',
    '  root?: RendererRoot;',
    '  children?: ReactNode;',
    '  isolateDocument?: boolean;',
    '  stageId?: string;',
    '  capabilityToken: string;',
    '  parentOrigin: string;',
    '  errorCode?: string;',
    '  errorMessage?: string;',
    '}) {',
    '  const hostRef = useRef<HTMLDivElement | null>(null);',
    '  const markedRef = useRef<MarkedElement | null>(null);',
    '  const selectedRef = useRef<Element | null>(null);',
    '  const baselineClassRef = useRef<string | null>(null);',
    '  const previewStylesRef = useRef<Map<string, string | null>>(new Map());',
    '  const cascadeActiveRef = useRef(false);',
    '  const [inspectionActive, setInspectionActive] = useState(false);',
    '  const [cameraZoom, setCameraZoom] = useState(1);',
    '  const post = useCallback((type: string, extra: Record<string, unknown> = {}) => {',
    '    if (!frame) return;',
    '    const stageType = stageId ? ({ ready: "frame-ready", heartbeat: "heartbeat", "rendered-dimensions": "frame-rendered-dimensions", "render-error": "frame-error", "element-selection": "frame-selection" } as Record<string, string>)[type] ?? type : type;',
    '    const componentRevision = (frame as RendererFrame & { componentRevision?: string }).componentRevision;',
    '    window.parent.postMessage({ ...extra, ...(stageId ? { protocolVersion: 3, contract: "next-host-v2", stageId, componentRevision } : { protocolVersion: PROTOCOL_VERSION }), sessionId: frame.sessionId, capabilityToken, generation: frame.generation, frameId: frame.frameId, componentId: frame.componentId, type: stageType, eventId: crypto.randomUUID() }, parentOrigin);',
    '  }, [capabilityToken, frame, parentOrigin, stageId]);',
    '  inspectorPost = post; inspectorSelectedRef = selectedRef; inspectorBaselineClassRef = baselineClassRef; inspectorPreviewStylesRef = previewStylesRef; inspectorCascadeActiveRef = cascadeActiveRef;',
    '  useEffect(() => {',
    '    if (stageId || !frame) return;',
    '    const handleCameraMessage = (event: MessageEvent) => {',
    '      if (event.source !== window.parent || event.origin !== parentOrigin) return;',
    '      const request = event.data as Record<string, unknown> | null;',
    '      if (!request || request.protocolVersion !== PROTOCOL_VERSION || request.type !== "ss:set-camera" || request.sessionId !== frame.sessionId || request.capabilityToken !== capabilityToken || request.generation !== frame.generation || request.frameId !== frame.frameId || request.componentId !== frame.componentId || !safeRendererZoom(request.zoom)) return;',
    '      setCameraZoom(request.zoom);',
    '    };',
    '    window.addEventListener("message", handleCameraMessage);',
    '    return () => window.removeEventListener("message", handleCameraMessage);',
    '  }, [capabilityToken, frame, parentOrigin, stageId]);',
    '  const reportDimensions = useCallback(() => {',
    '    if (!frame || !hostRef.current) return;',
    '    const host = hostRef.current;',
    '    const rootElement = root ? Array.from(host.querySelectorAll(root.tag)).find((element) => matchesRoot(element, root)) : null;',
    '    const measured = rootElement ?? host;',
    '    const rect = measured.getBoundingClientRect();',
    '    const paintZoom = stageId ? 1 : cameraZoom;',
    '    let width = rect.width / paintZoom;',
    '    let height = rect.height / paintZoom;',
    '    for (const candidate of [measured, ...Array.from(measured.querySelectorAll("*"))]) {',
    '      if (!(candidate instanceof HTMLElement)) continue;',
    '      const candidateRect = candidate.getBoundingClientRect();',
    '      width = Math.max(width, (candidateRect.right - rect.left) / paintZoom);',
    '      height = Math.max(height, (candidateRect.bottom - rect.top) / paintZoom);',
    '    }',
    '    width = Math.ceil(width);',
    '    height = Math.ceil(height);',
    '    if (width > 0 && height > 0) post("rendered-dimensions", { width, height, zoom: paintZoom });',
    '  }, [cameraZoom, frame, post, root, stageId]);',
    '  useLayoutEffect(() => {',
    '    const host = hostRef.current;',
    '    if (!host || !frame) return;',
    '    let frameHandle: number | null = null;',
    '    const report = () => {',
    '      if (frameHandle !== null) cancelAnimationFrame(frameHandle);',
    '      frameHandle = requestAnimationFrame(() => { frameHandle = null; reportDimensions(); });',
    '    };',
    '    report();',
    '    const observer = new ResizeObserver(report);',
    '    const observeTree = () => {',
    '      observer.disconnect();',
    '      observer.observe(host);',
    '      const rootElement = root ? Array.from(host.querySelectorAll(root.tag)).find((element) => matchesRoot(element, root)) : null;',
    '      const measured = rootElement ?? host;',
    '      observer.observe(measured);',
    '      measured.querySelectorAll("*").forEach((element) => observer.observe(element));',
    '      report();',
    '    };',
    '    observeTree();',
    '    const mutationObserver = new MutationObserver(observeTree);',
    '    mutationObserver.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });',
    '    return () => {',
    '      mutationObserver.disconnect();',
    '      observer.disconnect();',
    '      if (frameHandle !== null) cancelAnimationFrame(frameHandle);',
    '    };',
    '  }, [frame?.frameId, reportDimensions, root]);',
    '  useLayoutEffect(() => {',
    '    if (!isolateDocument) return;',
    '    const host = hostRef.current;',
    '    if (!host) return;',
    '    const hidden: Array<{ element: HTMLElement; display: string }> = [];',
    '    let branch: HTMLElement | null = host;',
    '    while (branch?.parentElement) {',
    '      const parent = branch.parentElement;',
    '      for (const sibling of Array.from(parent.children)) {',
    '        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;',
    '        hidden.push({ element: sibling, display: sibling.style.display });',
    '        sibling.style.display = "none";',
    '      }',
    '      if (parent === document.body) break;',
    '      branch = parent;',
    '    }',
    '    return () => {',
    '      for (const { element, display } of hidden) element.style.display = display;',
    '    };',
    '  }, [frame?.frameId, isolateDocument]);',
    '  const reportError = useCallback((error: unknown) => post("render-error", { code: "render-threw", message: error instanceof Error ? error.message.slice(0, 256) : "renderer failed" }), [post]);',
    '  useEffect(() => {',
    '    if (!frame) return;',
    '    if (stageId) { if (errorCode) post("render-error", { code: errorCode, message: errorMessage ?? "renderer failed" }); return; }',
    '    post("ready");',
    '    if (errorCode) post("render-error", { code: errorCode, message: errorMessage ?? "renderer failed" });',
    '    const heartbeat = stageId ? null : window.setInterval(() => post("heartbeat"), 5000);',
    '    return () => { if (heartbeat !== null) window.clearInterval(heartbeat); };',
    '  }, [errorCode, errorMessage, frame, post, stageId]);',
    '  useLayoutEffect(() => {',
    '    markedRef.current = null;',
    '    if (!root || !hostRef.current) return;',
    '    const candidate = Array.from(hostRef.current.querySelectorAll(root.tag)).find((element) => matchesRoot(element, root));',
    '    if (candidate) markedRef.current = { element: candidate, source: { file: root.source.file, start: root.source.start, end: root.source.end, contentHash: root.source.contentHash } };',
    '  }, [frame?.frameId, root]);',
    '  useEffect(() => {',
    '    const host = hostRef.current;',
    '    if (stageId || !host || !root) return;',
    '    const refresh = () => {',
    '      if (markedRef.current?.element.isConnected) return;',
    '      const candidate = Array.from(host.querySelectorAll(root.tag)).find((element) => matchesRoot(element, root));',
    '      if (candidate) { markedRef.current = { element: candidate, source: { file: root.source.file, start: root.source.start, end: root.source.end, contentHash: root.source.contentHash } }; if (inspectorTreeOn) { inspectorTreeStart(candidate); inspectorTreeSend(candidate); } }',
    '    };',
    '    refresh();',
    '    const observer = new MutationObserver(refresh);',
    '    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });',
    '    return () => observer.disconnect();',
    '  }, [frame?.frameId, frame?.componentId, frame?.generation, root, stageId]);',
    '  useEffect(() => {',
    '    const host = hostRef.current;',
    '    if (stageId || !host || !frame || !root) return;',
    '    const handleClick = (event: MouseEvent) => {',
    '      if (!inspectionActive || inspectorTextEditing) return;',
    '      const marked = markedRef.current;',
    '      if (!marked) return;',
    '      const target = inspectorPointerTarget(marked.element, event.target);',
    '      if (!target) return;',
    '      event.preventDefault(); event.stopPropagation();',
    '      inspectorSelect(marked.element, root, target);',
    '    };',
    '    host.addEventListener("click", handleClick, true);',
    '    return () => host.removeEventListener("click", handleClick, true);',
    '  }, [frame, inspectionActive, post, root, stageId]);',
    '  useEffect(() => {',
    '    const host = hostRef.current;',
    '    if (stageId || !host || !frame || !root || !inspectionActive) return;',
    '    const rootElement = () => markedRef.current?.element ?? null;',
    '    const handlePointerMove = (event: PointerEvent) => { const domRoot = rootElement(); inspectorHover(domRoot, inspectorPointerTarget(domRoot, event.target)); };',
    '    const handlePointerLeave = () => inspectorHover(null, null);',
    '    host.addEventListener("pointermove", handlePointerMove, true);',
    '    host.addEventListener("pointerleave", handlePointerLeave, true);',
    '    return () => { host.removeEventListener("pointermove", handlePointerMove, true); host.removeEventListener("pointerleave", handlePointerLeave, true); };',
    '  }, [frame, inspectionActive, root, stageId]);',
    '  useEffect(() => {',
    '    const host = hostRef.current;',
    '    if (stageId || !host || !frame || !root || !inspectionActive) return;',
    '    const handleDoubleClick = (event: MouseEvent) => { const domRoot = markedRef.current?.element ?? null; const pointer = inspectorPointerTarget(domRoot, event.target); const target = inspectorTextTarget(pointer); if (!target) return; event.preventDefault(); event.stopPropagation(); inspectorStartText(target); };',
    '    const handleKeyDown = (event: KeyboardEvent) => { inspectorHandleTextKeydown(event); if (!inspectorTextEditing) inspectorHandleStructureShortcut(event); };',
    '    host.addEventListener("dblclick", handleDoubleClick, true);',
    '    document.addEventListener("keydown", handleKeyDown, true);',
    '    return () => { host.removeEventListener("dblclick", handleDoubleClick, true); document.removeEventListener("keydown", handleKeyDown, true); };',
    '  }, [frame, inspectionActive, root, stageId]);',
    '  useEffect(() => {',
    '    if (stageId || !frame) return;',
    '    const handleInspectionMessage = (event: MessageEvent) => {',
    '      if (event.source !== window.parent || event.origin !== parentOrigin) return;',
    '      const request = event.data as Record<string, unknown> | null;',
    '      if (!request || request.protocolVersion !== PROTOCOL_VERSION || request.sessionId !== frame.sessionId || request.capabilityToken !== capabilityToken || request.generation !== frame.generation || request.frameId !== frame.frameId || request.componentId !== frame.componentId) return;',
    '      const currentRoot = markedRef.current?.element;',
    '      if (request.type === "ss:activate") { inspectorSetCascadeActive(request.cascade); inspectorSetTextEditable(false); inspectorSetStructureShortcuts(false); setInspectionActive(true); return; }',
    '      if (request.type === "ss:requestTree") { if (currentRoot) { inspectorTreeStart(currentRoot); inspectorTreeSend(currentRoot); } return; }',
    '      if (request.type === "ss:treeOff") { inspectorTreeStop(); return; }',
    '      if (request.type === "ss:selectNode") { const selectionRequestId = request.selectionRequestId === undefined ? undefined : typeof request.selectionRequestId === "string" && request.selectionRequestId.length > 0 && request.selectionRequestId.length <= 128 ? request.selectionRequestId : null; if (selectionRequestId === null) return; if (currentRoot && root) { if (selectionRequestId === undefined) inspectorSelectNode(currentRoot, root, request.id); else inspectorSelectNode(currentRoot, root, request.id, selectionRequestId); } return; }',
    '      if (request.type === "ss:hoverNode") { if (currentRoot) inspectorHoverNode(currentRoot, request.id ?? null); return; }',
    '      if (request.type === "ss:reselect") { if (currentRoot && root) inspectorReselect(currentRoot, root, request.signature); return; }',
    '      if (request.type === "ss:setElementStructureShortcuts") { inspectorSetStructureShortcuts(request.enabled === true); return; }',
    '      if (request.type === "ss:textInfo") { inspectorSetTextEditable(request.editable === true); return; }',
    '      if (request.type === "ss:textRevert") { inspectorRevertText(); return; }',
    '      if (request.type === "ss:deactivate") {',
    '        inspectorDestroy(); inspectorResetCascadeActive();',
    '        setInspectionActive(false);',
    '        return;',
    '      }',
    '      const selected = selectedRef.current;',
    '      if (!selected) return;',
    '      if (request.type === "ss:mutate" && typeof request.className === "string" && request.className.length <= 4096) {',
    '        selected.setAttribute("class", request.className);',
    '        const rules = Array.isArray(request.rules) ? request.rules : [];',
    '        for (const rule of rules.slice(0, 8) as Array<{ decls?: Record<string, unknown> }>) {',
    '          for (const [property, value] of Object.entries(rule.decls ?? {}).slice(0, 64)) {',
    '            if (!/^[a-z][a-z0-9-]{0,63}$/.test(property)) continue;',
    '            if (!previewStylesRef.current.has(property)) previewStylesRef.current.set(property, selected instanceof HTMLElement ? selected.style.getPropertyValue(property) || null : null);',
    '            if (value === null) { if (selected instanceof HTMLElement) selected.style.removeProperty(property); }',
    '            else if (typeof value === "string" && value.length <= 512 && selected instanceof HTMLElement) selected.style.setProperty(property, value);',
    '          }',
    '        }',
    '        return;',
    '      }',
    '      if (request.type === "ss:clearClassPreview") {',
    '        if (baselineClassRef.current !== null) selected.setAttribute("class", baselineClassRef.current);',
    '        if (selected instanceof HTMLElement) for (const [property, value] of previewStylesRef.current) value === null ? selected.style.removeProperty(property) : selected.style.setProperty(property, value);',
    '        previewStylesRef.current.clear(); return;',
    '      }',
    '      if (request.type === "ss:commit") {',
    '        baselineClassRef.current = selected.getAttribute("class") ?? "";',
    '        if (selected instanceof HTMLElement) for (const [property, value] of previewStylesRef.current) value === null ? selected.style.removeProperty(property) : selected.style.setProperty(property, value);',
    '        previewStylesRef.current.clear(); return;',
    '      }',
    '      if (request.type === "ss:setSrc" && typeof request.value === "string" && request.value.length <= 4096 && selected instanceof HTMLImageElement) { selected.src = request.value; }',
    '      if (request.type === "ss:previewRuleText" && typeof request.cssText === "string" && request.cssText.length <= 8192 && typeof request.selector === "string") {',
    '        for (const sheet of Array.from(document.styleSheets)) { try { for (const rule of Array.from(sheet.cssRules)) { if (rule.type === 1 && (rule as CSSStyleRule).selectorText === request.selector) (rule as CSSStyleRule).style.cssText = request.cssText.slice(request.cssText.indexOf("{") + 1, request.cssText.lastIndexOf("}")); } } catch { /* ignore inaccessible sheets */ } }',
    '        return;',
    '      }',
    '      if (request.type === "ss:clearRulePreview" || request.type === "ss:commitRulePreview" || request.type === "ss:deleteRulePreview" || request.type === "ss:suppressReload" || request.type === "ss:reselect") return;',
    '    };',
    '    window.addEventListener("message", handleInspectionMessage);',
    '    return () => window.removeEventListener("message", handleInspectionMessage);',
    '  }, [capabilityToken, frame, parentOrigin, stageId]);',
    '  useEffect(() => { if (stageId) return; return () => inspectorDestroy(); }, [frame?.frameId, frame?.componentId, frame?.generation, root, stageId]);',
    '  useEffect(() => {',
    '    if (!frame) return;',
    '    const handleAccessibilityRequest = (event: MessageEvent) => {',
    '      if (event.source !== window.parent || event.origin !== parentOrigin) return;',
    '      const request = event.data as Record<string, unknown> | null;',
    '      if (!request || request.protocolVersion !== PROTOCOL_VERSION || request.type !== "ss:run-accessibility" || request.sessionId !== frame.sessionId || request.capabilityToken !== capabilityToken || request.generation !== frame.generation || request.frameId !== frame.frameId || request.componentId !== frame.componentId || typeof request.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > 128) return;',
    '      post("accessibility-result", { requestId: request.requestId, findings: inspectAccessibility() });',
    '    };',
    '    window.addEventListener("message", handleAccessibilityRequest);',
    '    return () => window.removeEventListener("message", handleAccessibilityRequest);',
    '  }, [capabilityToken, frame, parentOrigin, post]);',
    '  if (errorCode) return <div data-shipstudio-renderer-error={errorCode}>{errorMessage ?? "Renderer failed"}</div>;',
    '  return <RendererErrorBoundary onError={reportError}><div ref={hostRef} data-shipstudio-renderer-frame={frame?.frameId} style={{ zoom: stageId ? undefined : cameraZoom, width: stageId ? undefined : `calc(100% / ${cameraZoom})`, minHeight: stageId ? undefined : `calc(100% / ${cameraZoom})` }}>{children}</div></RendererErrorBoundary>;',
    '}',
    '',
    'type RendererStageLayout = { frameId: string; x: number; y: number; width: number; height: number; rotation?: number; visible?: boolean };',
    'type RendererStageCamera = { x: number; y: number; zoom: number };',
    'type RendererStageIdentity = { frameId: string; componentId: string; componentRevision: string };',
    'function stageLayoutIsSafe(value: unknown): value is RendererStageLayout {',
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return false;',
    '  const frame = value as Record<string, unknown>;',
    '  return typeof frame.frameId === "string" && frame.frameId.length > 0 && frame.frameId.length <= 256 && typeof frame.x === "number" && Number.isFinite(frame.x) && frame.x >= -10000000 && frame.x <= 10000000 && typeof frame.y === "number" && Number.isFinite(frame.y) && frame.y >= -10000000 && frame.y <= 10000000 && typeof frame.width === "number" && Number.isFinite(frame.width) && frame.width >= 1 && frame.width <= 100000 && typeof frame.height === "number" && Number.isFinite(frame.height) && frame.height >= 1 && frame.height <= 100000 && (frame.rotation === undefined || (typeof frame.rotation === "number" && Number.isFinite(frame.rotation) && frame.rotation >= -360000 && frame.rotation <= 360000)) && (frame.visible === undefined || typeof frame.visible === "boolean");',
    '}',
    'function stageFrameIdentityIsSafe(value: unknown): value is RendererStageIdentity {',
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return false;',
    '  const frame = value as Record<string, unknown>;',
    '  return typeof frame.frameId === "string" && frame.frameId.length > 0 && frame.frameId.length <= 256 && typeof frame.componentId === "string" && frame.componentId.length > 0 && frame.componentId.length <= 256 && typeof frame.componentRevision === "string" && frame.componentRevision.length > 0 && frame.componentRevision.length <= 256;',
    '}',
    'function stageCameraIsSafe(value: unknown): boolean {',
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return false;',
    '  const camera = value as Record<string, unknown>;',
    '  return camera.owner === "parent" && typeof camera.x === "number" && Number.isFinite(camera.x) && camera.x >= -10000000 && camera.x <= 10000000 && typeof camera.y === "number" && Number.isFinite(camera.y) && camera.y >= -10000000 && camera.y <= 10000000 && typeof camera.zoom === "number" && Number.isFinite(camera.zoom) && camera.zoom >= 0.01 && camera.zoom <= 100;',
    '}',
    'function stageIdsAreSafe(value: unknown, identities: RendererStageIdentity[]): boolean {',
    '  return Array.isArray(value) && value.length <= 200 && new Set(value).size === value.length && value.every((id) => typeof id === "string" && identities.some((identity) => identity.frameId === id));',
    '}',
    'function stageSyncFrameIsSafe(frame: Record<string, unknown>, identities: RendererStageIdentity[], sessionId: string, generation: number): boolean {',
    '  const layout = frame.layout;',
    '  return frame.protocolVersion === PROTOCOL_VERSION && frame.sessionId === sessionId && frame.generation === generation && stageFrameIdentityIsSafe(frame) && !!layout && typeof layout === "object" && !Array.isArray(layout) && stageLayoutIsSafe({ ...(layout as Record<string, unknown>), frameId: frame.frameId, visible: frame.visible }) && identities.some((identity) => identity.frameId === frame.frameId && identity.componentId === frame.componentId && identity.componentRevision === frame.componentRevision);',
    '}',
    'function stageLayoutsMatch(left: RendererStageLayout[], identities: RendererStageIdentity[]): boolean {',
    '  return left.length > 0 && left.length === identities.length && left.every((frame, index) => stageLayoutIsSafe(frame) && frame.frameId === identities[index]?.frameId);',
    '}',
    'function stageEvent(type: string, sessionId: string, capabilityToken: string, generation: number, stageId: string, extra: Record<string, unknown> = {}) {',
    '  window.parent.postMessage({ ...extra, protocolVersion: STAGE_PROTOCOL_VERSION, contract: STAGE_CONTRACT, sessionId, capabilityToken, generation, stageId, type, eventId: crypto.randomUUID() }, parentOriginForEvent);',
    '}',
    'let parentOriginForEvent = "";',
    '',
    'export function RendererStageShell({ sessionId, capabilityToken, generation, stageId, parentOrigin, frames, frameIdentities, children }: {',
    '  sessionId: string;',
    '  capabilityToken: string;',
    '  generation: number;',
    '  stageId: string;',
    '  parentOrigin: string;',
    '  frames: RendererStageLayout[];',
    '  frameIdentities: RendererStageIdentity[];',
    '  children?: ReactNode;',
    '}) {',
    '  parentOriginForEvent = parentOrigin;',
    '  const [activeFrames, setActiveFrames] = useState<RendererStageLayout[]>(frames);',
    '  const [activeCamera, setActiveCamera] = useState<RendererStageCamera>({ x: 0, y: 0, zoom: 1 });',
    '  const readyTimersRef = useRef<number[]>([]);',
    '  const childArray = Array.isArray(children) ? children : [children];',
    '  useEffect(() => () => { readyTimersRef.current.forEach((timer) => window.clearTimeout(timer)); }, []);',
    '  useEffect(() => {',
    '    if (!stageLayoutsMatch(frames, frameIdentities)) return;',
    '    stageEvent("stage-ready", sessionId, capabilityToken, generation, stageId, { frameIds: frames.map((frame) => frame.frameId) });',
    '    const heartbeat = window.setInterval(() => stageEvent("heartbeat", sessionId, capabilityToken, generation, stageId), 5000);',
    '    return () => window.clearInterval(heartbeat);',
    '  }, [capabilityToken, frameIdentities, frames, generation, sessionId, stageId]);',
    '  useEffect(() => {',
    '    const handleSync = (event: MessageEvent) => {',
    '      if (event.source !== window.parent || event.origin !== parentOrigin) return;',
    '      const request = event.data as Record<string, unknown> | null;',
    '      if (!request || request.protocolVersion !== STAGE_PROTOCOL_VERSION || request.contract !== STAGE_CONTRACT || request.type !== "sync" || request.sessionId !== sessionId || request.capabilityToken !== capabilityToken || request.generation !== generation || request.stageId !== stageId || !Array.isArray(request.frames) || request.frames.length === 0 || request.frames.length > 200 || !stageCameraIsSafe(request.camera) || !stageIdsAreSafe(request.retainFrameIds, frameIdentities) || !stageIdsAreSafe(request.revealFrameIds, frameIdentities) || (request.selectedFrameId !== null && typeof request.selectedFrameId !== "string") || (request.inputFrameId !== null && typeof request.inputFrameId !== "string")) return;',
    '      const nextFrames = request.frames as Array<Record<string, unknown>>;',
    '      const identities = frameIdentities;',
    '      if (!nextFrames.every((frame) => stageSyncFrameIsSafe(frame, identities, sessionId, generation))) { stageEvent("stage-error", sessionId, capabilityToken, generation, stageId, { code: "stage-sync-invalid", message: "The stage sync payload failed identity or layout validation." }); return; }',
    '      const layouts = nextFrames.map((frame) => ({ ...(frame.layout as RendererStageLayout), frameId: String(frame.frameId), visible: frame.visible !== false }));',
    '      if (!stageLayoutsMatch(layouts, identities)) { stageEvent("stage-error", sessionId, capabilityToken, generation, stageId, { code: "stage-frame-set-changed", message: "Stage frame identity changed without a new host route." }); return; }',
    '      const nextCamera = request.camera as RendererStageCamera;',
    '      setActiveCamera({ x: nextCamera.x, y: nextCamera.y, zoom: nextCamera.zoom });',
    '      setActiveFrames(layouts);',
    '      readyTimersRef.current.forEach((timer) => window.clearTimeout(timer)); readyTimersRef.current = [];',
    '      nextFrames.forEach((frame, index) => { const timer = window.setTimeout(() => stageEvent("frame-ready", sessionId, capabilityToken, generation, stageId, { frameId: frame.frameId, componentId: frame.componentId, componentRevision: frame.componentRevision }), index * 45); readyTimersRef.current.push(timer); });',
    '      if (typeof request.selectedFrameId === "string") { const selected = nextFrames.find((frame) => frame.frameId === request.selectedFrameId); if (selected) stageEvent("frame-activated", sessionId, capabilityToken, generation, stageId, { frameId: selected.frameId, componentId: selected.componentId, componentRevision: selected.componentRevision }); }',
    '    };',
    '    window.addEventListener("message", handleSync);',
    '    return () => window.removeEventListener("message", handleSync);',
    '  }, [capabilityToken, frameIdentities, generation, parentOrigin, sessionId, stageId]);',
    '  const width = Math.max(1, ...activeFrames.map((frame) => frame.x + frame.width));',
    '  const height = Math.max(1, ...activeFrames.map((frame) => frame.y + frame.height));',
    '  const scaledWidth = width * activeCamera.zoom;',
    '  const scaledHeight = height * activeCamera.zoom;',
    '  return <div data-shipstudio-renderer-stage="true" data-shipstudio-renderer-stage-editing="unsupported" style={{ position: "relative", width: "100%", minHeight: `${scaledHeight}px`, overflow: "visible" }}><div style={{ position: "absolute", left: `${activeCamera.x}px`, top: `${activeCamera.y}px`, width: `${scaledWidth}px`, minHeight: `${scaledHeight}px`, overflow: "visible" }}><div style={{ position: "relative", width: `${width}px`, minHeight: `${height}px`, zoom: activeCamera.zoom }}>{activeFrames.map((frame, index) => <div key={frame.frameId} data-shipstudio-renderer-stage-frame={frame.frameId} onClick={() => { const identity = frameIdentities[index]; if (identity) stageEvent("frame-activated", sessionId, capabilityToken, generation, stageId, { frameId: identity.frameId, componentId: identity.componentId, componentRevision: identity.componentRevision }); }} style={{ position: "absolute", left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.width}px`, height: `${frame.height}px`, visibility: frame.visible === false ? "hidden" : "visible", transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined, transformOrigin: "top left" }}>{childArray[index]}</div>)}</div></div></div>;',
    '}',
  ].join('\n');
}

function buildLoadingSource(): string {
  return [
    '/* Ship Studio component renderer host; generated after explicit review. */',
    'export default function ShipStudioRendererLoading() {',
    '  return <div role="status">Loading component renderer…</div>;',
    '}',
  ].join('\n');
}

function allocateRouteSegment(
  projectFiles: ReadonlySet<string>,
  routeDirectory: string,
  sessionId: string,
  router: NextRouterKind
): string | null {
  // Next App Router treats underscore-prefixed folders as private and does not
  // expose them as routes. Keep the generated segment opaque but routable.
  const base = `shipstudio_renderer_${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'session'}`;
  for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const segment = `${base}${suffix}`;
    const routeFile =
      router === 'pages'
        ? `${routeDirectory}/${segment}.tsx`
        : `${routeDirectory}/${segment}/page.tsx`;
    const routeDirectoryPath = `${routeDirectory}/${segment}/`;
    if (
      !projectFiles.has(routeFile) &&
      ![...projectFiles].some((file) => file.startsWith(routeDirectoryPath))
    )
      return segment;
  }
  return null;
}

function relativeImport(fromFile: string, targetFile: string): string {
  const from = normalizeProjectPath(fromFile).split('/');
  from.pop();
  const target = normalizeProjectPath(targetFile)
    .replace(/\.(tsx?|jsx?)$/, '')
    .split('/');
  while (from.length > 0 && target.length > 0 && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  const segments = [...from.map(() => '..'), ...target];
  const result = segments.join('/');
  return result.startsWith('.') ? result : `./${result}`;
}

function hasDirectory(files: ReadonlySet<string>, directory: string): boolean {
  return [...files].some((file) => file === directory || file.startsWith(`${directory}/`));
}

function normalizeProjectPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeWorkspaceRoot(workspaceRoot: string): string | null {
  const normalized = normalizeProjectPath(workspaceRoot).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return '';
  if (
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    return null;
  }
  return normalized;
}

function relativeWorkspacePath(file: string, workspaceRoot: string): string | null {
  if (!workspaceRoot) return file;
  if (file === workspaceRoot) return '';
  const prefix = `${workspaceRoot}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : null;
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  return workspaceRoot ? `${workspaceRoot}/${relativePath}` : relativePath;
}

function isSafeProjectPath(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  return (
    normalized.length > 0 &&
    normalized.length <= 512 &&
    !normalized.startsWith('/') &&
    !normalized.split('/').some((segment) => segment === '' || segment === '..')
  );
}

function isSafeOpaqueValue(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !/[\r\n]/.test(value);
}

function isSafeLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      url.port.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isSafeOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'tauri:') &&
      !url.username &&
      !url.password &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function jsonLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
