import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { buildRendererRegistry } from './renderer-registry';
import {
  buildNextRendererHostPlan,
  detectNextRouter,
  encodeNextRendererStageId,
  inspectNextPagesRuntimeCompatibility,
  isNextRendererStagePayload,
} from './next-renderer-adapter';
import { buildRendererInspectorRuntimeSource } from './renderer-inspector-runtime';
import type { ComponentIndex } from './types';

function index(files: string[]): ComponentIndex {
  return {
    revision: 'index-revision',
    partial: false,
    profile: {} as ComponentIndex['profile'],
    components: [
      {
        id: 'react:Card',
        dialect: 'react',
        kind: 'component',
        name: 'Card',
        localName: 'Card',
        exportName: 'Card',
        description: null,
        definition: {
          file: files[0] ?? 'src/components/Card.tsx',
          start: 0,
          end: 10,
          line: 1,
          column: 1,
          contentHash: 'hash',
        },
        renderRoot: {
          tag: 'article',
          classTokens: ['card'],
          id: null,
          source: {
            file: files[0] ?? 'src/components/Card.tsx',
            start: 1,
            end: 42,
            line: 2,
            column: 3,
            contentHash: 'hash',
          },
        },
        props: [],
        slots: [],
        variantProps: [],
        usageCount: 1,
        capabilities: { catalog: true } as ComponentIndex['components'][number]['capabilities'],
        diagnostics: [],
      },
    ],
    instances: [],
    importEdges: [],
    diagnostics: [],
  };
}

describe('next renderer adapter planning', () => {
  it('validates bounded authenticated stage descriptors and encodes only the opaque stage id', () => {
    const payload = {
      protocolVersion: 2 as const,
      sessionId: 'renderer-session',
      generation: 3,
      frames: [
        {
          protocolVersion: 2 as const,
          projectIdentity: 'project-1',
          sessionId: 'renderer-session',
          frameId: 'node-a',
          componentId: 'react:Card',
          componentRevision: 'revision-1',
          generation: 3,
          props: {},
          slots: {},
          presentation: {
            widthMode: 'fixed' as const,
            width: 320,
            height: 240 as const,
            background: 'surface' as const,
            breakpoint: null,
            locale: null,
          },
        },
      ],
    };
    expect(isNextRendererStagePayload(payload)).toBe(true);
    expect(encodeNextRendererStageId('stage-opaque-1')).toBe('stage-opaque-1');
    expect(
      isNextRendererStagePayload({
        ...payload,
        frames: [payload.frames[0], payload.frames[0]],
      })
    ).toBe(false);
    expect(() => encodeNextRendererStageId('../stage')).not.toThrow();
    expect(() => encodeNextRendererStageId('')).toThrow();
  });

  it('emits the shared-runtime stage route and authenticated absolute-layout host', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      ['app/layout.tsx', 'src/components/Card.tsx'],
      {
        sessionId: 'session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
        routeIdentity: 'next-host-v2',
      }
    );
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    const routeSource = plan.files.find((file) => file.kind === 'route')?.contents ?? '';
    const shellSource = plan.files.find((file) => file.kind === 'client-shell')?.contents ?? '';
    expect(routeSource).toContain('stageId');
    expect(routeSource).toContain('/stage?stageId=');
    expect(routeSource).toContain('readStageFrames');
    expect(routeSource).toContain('parseStageResponse');
    expect(shellSource).toContain('export function RendererStageShell');
    expect(shellSource).toContain('request.type !== "sync"');
    expect(shellSource).toContain('stageEvent("stage-ready"');
    expect(shellSource).toContain('stageEvent("frame-ready"');
    expect(shellSource).toContain('position: "absolute"');
    expect(shellSource).toContain('isolateDocument = true');
  });

  it('detects one router and rejects ambiguous trees', () => {
    expect(detectNextRouter(['src/app/layout.tsx', 'src/app/page.tsx'])).toEqual({
      kind: 'app',
      root: 'src',
    });
    expect(detectNextRouter(['pages/_app.tsx', 'pages/index.tsx'])).toEqual({
      kind: 'pages',
      root: 'root',
    });
    expect(detectNextRouter(['app/page.tsx', 'pages/index.tsx'])).toMatchObject({
      kind: 'unsupported',
    });
  });

  it('detects a router inside the active monorepo workspace', () => {
    expect(
      detectNextRouter(
        ['apps/admin/src/app/layout.tsx', 'apps/admin/src/app/page.tsx'],
        'apps/admin'
      )
    ).toEqual({ kind: 'app', root: 'src' });
  });

  it('allocates a collision-safe App Router route and emits reviewed imports', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      [
        'src/app/layout.tsx',
        'src/app/shipstudio_renderer_session/page.tsx',
        'src/components/Card.tsx',
      ],
      {
        sessionId: 'session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
      }
    );
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.routeFile).toBe('src/app/shipstudio_renderer_session-2/page.tsx');
    expect(plan.files[0]?.contents).toContain('import { Card as ShipStudioComponent0 }');
    expect(plan.files[0]?.contents).toContain('SESSION_ENDPOINT');
    expect(plan.files.some((file) => file.kind === 'registry')).toBe(true);
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'RendererErrorBoundary'
    );
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'post("heartbeat")'
    );
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'ss:run-accessibility'
    );
    expect(plan.files[0]?.contents).toContain('renderRoot');
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'element-selection'
    );
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'collectCascadeRules'
    );
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'inspectorPost("ss:cascade"'
    );
    expect(plan.files.find((file) => file.kind === 'client-shell')?.contents).toContain(
      'sibling.style.display = "none"'
    );
    const shellSource = plan.files.find((file) => file.kind === 'client-shell')?.contents ?? '';
    expect(shellSource).toContain('post("rendered-dimensions"');
    expect(shellSource).toContain('zoom: paintZoom');
    expect(shellSource).toContain('(candidateRect.right - rect.left) / paintZoom');
    expect(shellSource).toContain('(candidateRect.bottom - rect.top) / paintZoom');
    expect(shellSource).toContain('type !== "ss:set-camera"');
    expect(shellSource).toContain('safeRendererZoom(request.zoom)');
    expect(shellSource).toContain('width: stageId ? undefined : `calc(100% / ${cameraZoom})`');
    expect(shellSource).toContain('const mutationObserver = new MutationObserver(observeTree)');
    expect(shellSource).toContain('inspectorTreeStart(currentRoot)');
    expect(shellSource).toContain('inspectorTreeSend(currentRoot)');
    expect(shellSource).toContain('inspectorHoverNode(currentRoot, request.id ?? null)');
    expect(shellSource).toContain('inspectorPointerTarget(marked.element, event.target)');
    expect(shellSource).toContain('inspectorSelect(marked.element, root, target)');
    expect(shellSource).toContain('inspectorSelectNode(currentRoot, root, request.id)');
    expect(shellSource).toContain('inspectorHover(null, null)');
    expect(shellSource).toContain('request.componentId !== frame.componentId');
    expect(shellSource).toContain('ss:setElementStructureShortcuts');
    expect(shellSource).toContain('ss:textInfo');
    expect(shellSource).toContain('ss:textRevert');
    expect(shellSource).toContain('inspectorHandleTextKeydown');
    expect(shellSource).toContain('inspectorStartText(target)');
    expect(shellSource).toContain('inspectorDestroy()');
    expect(shellSource).toContain('inspectorSetCascadeActive(request.cascade)');
    expect(shellSource).toContain('inspectorResetCascadeActive()');
    expect(shellSource).not.toContain('selectedRef.current = marked.element;');
    expect(shellSource).toContain('inspectorTreeById = new Map<number, Element>()');
    expect(
      ts.transpileModule(shellSource, {
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).diagnostics
    ).toHaveLength(0);
  });

  it('keeps generated host files inside the active monorepo workspace', () => {
    const componentIndex = index(['apps/admin/src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      [
        'apps/admin/src/app/layout.tsx',
        'apps/admin/src/app/shipstudio_renderer_next-host-v1/page.tsx',
        'apps/admin/src/components/Card.tsx',
      ],
      {
        sessionId: 'session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
        workspaceRoot: 'apps/admin',
        routeIdentity: 'next-host-v1',
      }
    );
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.routeFile).toBe('apps/admin/src/app/shipstudio_renderer_next-host-v1-2/page.tsx');
    expect(plan.files.map((file) => file.relativePath)).toEqual([
      plan.routeFile,
      'apps/admin/src/app/shipstudio_renderer_next-host-v1-2/__shipstudio_renderer_shell.tsx',
      '.shipstudio/component-renderer/registry.json',
      'apps/admin/src/app/shipstudio_renderer_next-host-v1-2/loading.tsx',
    ]);
  });

  it('checks Pages Router compatibility relative to the active workspace', () => {
    const componentIndex = index(['apps/admin/src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      ['apps/admin/src/pages/index.tsx', 'apps/admin/next.config.ts'],
      {
        sessionId: 'session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
        workspaceRoot: 'apps/admin',
        runtimeFiles: [
          {
            file: 'apps/admin/next.config.ts',
            content: 'export default { basePath: "/admin" };',
          },
        ],
        runtimeSnapshotComplete: true,
      }
    );
    expect(plan.supported).toBe(false);
    if (plan.supported) return;
    expect(plan.reason).toContain('basePath');
  });

  it('generates Pages Router host files under the active workspace', () => {
    const componentIndex = index(['apps/admin/src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      ['apps/admin/src/pages/index.tsx'],
      {
        sessionId: 'session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
        workspaceRoot: 'apps/admin',
      }
    );
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.routeFile).toBe('apps/admin/src/pages/shipstudio_renderer_session.tsx');
    expect(plan.files.find((file) => file.kind === 'client-shell')?.relativePath).toBe(
      'apps/admin/.shipstudio/component-renderer/shipstudio_renderer_session/shell.tsx'
    );
  });

  it('keeps preflight and live route paths stable across session credentials', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const makePlan = (sessionId: string) =>
      buildNextRendererHostPlan(
        componentIndex,
        registry,
        ['src/app/layout.tsx', 'src/components/Card.tsx'],
        {
          sessionId,
          capabilityToken: `token-${sessionId}`,
          sessionEndpoint: 'http://127.0.0.1:4312/renderer',
          parentOrigin: 'tauri://localhost',
          routeIdentity: 'next-host-v1',
        }
      );

    const preflight = makePlan('preflight');
    const live = makePlan('live-session');
    expect(preflight.supported).toBe(true);
    expect(live.supported).toBe(true);
    if (!preflight.supported || !live.supported) return;
    expect(live.files.map((file) => file.relativePath)).toEqual(
      preflight.files.map((file) => file.relativePath)
    );
    expect(live.files[0]?.contents).not.toBe(preflight.files[0]?.contents);
  });

  it('keeps the Pages Router page under pages so _app remains the runtime boundary', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      ['pages/_app.tsx', 'pages/index.tsx'],
      {
        sessionId: 'pages-session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
      }
    );
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.router).toBe('pages');
    expect(plan.routeFile).toMatch(/^pages\/shipstudio_renderer_/);
    expect(plan.files.find((file) => file.kind === 'client-shell')?.relativePath).toMatch(
      /^\.shipstudio\/component-renderer\//
    );
    const routeSource = plan.files.find((file) => file.kind === 'route')?.contents ?? '';
    expect(routeSource).toContain('getServerSideProps');
    expect(routeSource).toContain('readFrame(frameId ?? "")');
    expect(routeSource).toContain('export default function ShipStudioRendererPage');
    expect(
      ts.transpileModule(routeSource, {
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).diagnostics
    ).toHaveLength(0);
  });

  it('rejects unsafe explicit setup paths before generating host code', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(componentIndex, registry, ['app/layout.tsx'], {
      sessionId: 'session',
      capabilityToken: 'token',
      sessionEndpoint: 'http://127.0.0.1:4312/renderer',
      parentOrigin: 'tauri://localhost',
      explicitDecoratorModule: '../provider.tsx',
    });
    expect(plan).toEqual({
      supported: false,
      reason: 'The selected decorator module is not a safe project-relative path.',
    });
  });

  it('supports a reviewed named decorator and refuses stale registry revisions', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(componentIndex, registry, ['app/layout.tsx'], {
      sessionId: 'session',
      capabilityToken: 'token',
      sessionEndpoint: 'http://127.0.0.1:4312/renderer',
      parentOrigin: 'tauri://localhost',
      explicitDecoratorModule: 'src/Provider.tsx',
      explicitDecoratorExportName: 'Provider',
    });
    expect(plan.supported).toBe(true);
    if (plan.supported) expect(plan.files[0]?.contents).toContain('Provider as Decorator');

    expect(
      buildNextRendererHostPlan(
        componentIndex,
        { ...registry, sourceRevision: 'stale' },
        ['app/layout.tsx'],
        {
          sessionId: 'session',
          capabilityToken: 'token',
          sessionEndpoint: 'http://127.0.0.1:4312/renderer',
          parentOrigin: 'tauri://localhost',
        }
      )
    ).toEqual({
      supported: false,
      reason: 'The reviewed renderer registry is stale; refresh the component catalog first.',
    });
  });

  it('fails closed for Pages Router base paths, asset prefixes, locales, and middleware', () => {
    const files = [
      {
        file: 'next.config.mjs',
        content:
          "export default { basePath: '/docs', assetPrefix: 'https://cdn.example.test', i18n: { locales: ['en'], defaultLocale: 'en' } }",
      },
      { file: 'middleware.ts', content: 'export function middleware() { return undefined; }' },
      {
        file: 'pages/[locale]/index.tsx',
        content: 'export default function Page() { return null; }',
      },
    ];
    const compatibility = inspectNextPagesRuntimeCompatibility(files);
    expect(compatibility.supported).toBe(false);
    expect(compatibility.configFiles).toEqual(['next.config.mjs']);
    expect(compatibility.middlewareFiles).toEqual(['middleware.ts']);
    expect(compatibility.blockers.join(' ')).toContain('basePath');
    expect(compatibility.blockers.join(' ')).toContain('assetPrefix');
    expect(compatibility.blockers.join(' ')).toContain('locale');
    expect(compatibility.blockers.join(' ')).toContain('Middleware');
  });

  it('does not generate a Pages Router route when compatibility needs review', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    const plan = buildNextRendererHostPlan(
      componentIndex,
      registry,
      ['pages/_app.tsx', 'pages/index.tsx'],
      {
        sessionId: 'pages-session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
        runtimeFiles: [
          {
            file: 'next.config.js',
            content: 'module.exports = { basePath: process.env.BASE_PATH };',
          },
        ],
      }
    );
    expect(plan.supported).toBe(false);
    if (plan.supported) throw new Error('Expected dynamic basePath to be rejected.');
    expect(plan.reason).toContain('dynamic basePath');
  });

  it('refuses a partial Pages Router source snapshot', () => {
    const componentIndex = index(['src/components/Card.tsx']);
    const registry = buildRendererRegistry(componentIndex, { revision: componentIndex.revision });
    expect(
      buildNextRendererHostPlan(componentIndex, registry, ['pages/index.tsx'], {
        sessionId: 'pages-session',
        capabilityToken: 'token',
        sessionEndpoint: 'http://127.0.0.1:4312/renderer',
        parentOrigin: 'tauri://localhost',
        runtimeFiles: [],
        runtimeSnapshotComplete: false,
      })
    ).toEqual({
      supported: false,
      reason:
        'Pages Router compatibility cannot be verified from a partial source snapshot; refresh the catalog first.',
    });
  });
});

describe('generated inspector runtime', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('round-trips a root-scoped tree, descendant select/hover, and teardown', () => {
    const compiled = ts.transpileModule(
      `${buildRendererInspectorRuntimeSource()}
return {
  setPost: (post) => { inspectorPost = post; },
  start: inspectorTreeStart,
  send: inspectorTreeSend,
  selectNode: inspectorSelectNode,
  hoverNode: inspectorHoverNode,
  destroy: inspectorDestroy,
};`,
      { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 } }
    ).outputText;
    const runtime = new Function(compiled)() as {
      setPost: (post: (type: string, extra?: Record<string, unknown>) => void) => void;
      start: (root: Element) => void;
      send: (root: Element) => void;
      selectNode: (domRoot: Element, metadataRoot: Record<string, unknown>, id: unknown) => void;
      hoverNode: (root: Element | null, id: unknown) => void;
      destroy: () => void;
    };
    const messages: Array<{ type: string; extra: Record<string, unknown> }> = [];
    runtime.setPost((type, extra = {}) => messages.push({ type, extra }));
    const host = document.createElement('div');
    const root = document.createElement('article');
    root.className = 'card';
    const child = document.createElement('button');
    child.className = 'cta';
    child.textContent = 'Open';
    root.append(child);
    host.append(root);
    document.body.append(host);
    const metadataRoot = {
      tag: 'article',
      classTokens: ['card'],
      id: null,
      source: {
        file: 'src/components/Card.tsx',
        start: 10,
        end: 42,
        line: 2,
        column: 3,
        contentHash: 'card-hash',
      },
    };
    runtime.start(root);
    runtime.send(root);

    const tree = messages.find((message) => message.type === 'ss:tree')?.extra.tree as {
      i: number;
      t: string;
      k: Array<{ i: number; t: string }>;
    };
    expect(tree.t).toBe('article');
    expect(tree.k).toHaveLength(1);
    expect(tree.k[0]?.t).toBe('button');
    expect(messages.find((message) => message.type === 'ss:tree')?.extra).not.toHaveProperty(
      'host'
    );

    runtime.selectNode(root, metadataRoot, tree.k[0]?.i);
    const selection = messages.filter((message) => message.type === 'ss:select').pop();
    expect(selection?.extra.nodeId).toBe(tree.k[0]?.i);
    expect((selection?.extra.signature as { sourceFile?: string }).sourceFile).toBe(
      metadataRoot.source.file
    );
    // A descendant selection must not claim the component root's range as its
    // own source location; the host resolves the signature against the
    // indexed definition before enabling writes.
    expect(selection?.extra).not.toHaveProperty('componentBoundary');
    expect(selection?.extra).not.toHaveProperty('sourceRange');
    runtime.hoverNode(root, tree.k[0]?.i);
    expect(messages.filter((message) => message.type === 'ss:hover').pop()?.extra.nodeId).toBe(
      tree.k[0]?.i
    );
    runtime.hoverNode(null, null);
    expect(
      messages.filter((message) => message.type === 'ss:hover').pop()?.extra.nodeId
    ).toBeNull();
    runtime.selectNode(root, metadataRoot, tree.i);
    expect(messages.filter((message) => message.type === 'element-selection').pop()?.extra).toEqual(
      expect.objectContaining({ sourceRange: metadataRoot.source })
    );
    runtime.destroy();
    expect(document.querySelector('[data-ss-overlay]')).toBeNull();
  });

  it('exposes text editing, HMR reselect, and negotiated structure shortcuts', () => {
    const runtimeSource = buildRendererInspectorRuntimeSource();
    expect(runtimeSource).toContain('let inspectorTextEditable = false;');
    expect(runtimeSource).toContain('let inspectorStructureShortcuts = false;');
    expect(runtimeSource).toContain('inspectorStartText');
    expect(runtimeSource).toContain('inspectorFinalizeTextPending');
    expect(runtimeSource).toContain('inspectorHandleStructureShortcut');
    expect(runtimeSource).toContain('inspectorHandleTextKeydown');
  });

  it('merges shared activation requests without allowing plain activation to disable CSS cascade', () => {
    const compiled = ts.transpileModule(
      `${buildRendererInspectorRuntimeSource()}
return {
  activate: inspectorSetCascadeActive,
  reset: inspectorResetCascadeActive,
  isCascadeActive: () => inspectorCascadeActiveRef.current,
};`,
      { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 } }
    ).outputText;
    const runtime = new Function(compiled)() as {
      activate: (requested: unknown) => void;
      reset: () => void;
      isCascadeActive: () => boolean;
    };

    runtime.reset();
    runtime.activate(true);
    runtime.activate(false);
    expect(runtime.isCascadeActive()).toBe(true);
    runtime.reset();
    expect(runtime.isCascadeActive()).toBe(false);
  });
});
