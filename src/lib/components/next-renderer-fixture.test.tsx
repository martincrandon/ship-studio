/**
 * Runtime smoke coverage for the generated Next host.
 *
 * This intentionally evaluates the generated client shell (including the
 * extracted inspector runtime) in jsdom. The fixture packages stay pinned and
 * are not installed or started here; their source and route boundaries are
 * loaded as the reviewed host inputs, while React mounts the exact generated
 * shell around representative Card markup.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRendererRegistry } from './renderer-registry';
import {
  buildNextRendererHostPlan,
  type NextRouterKind,
} from './next-renderer-adapter';
import {
  COMPONENT_CANVAS_MAX_LIVE_FRAMES,
  type ComponentCanvasNode,
} from './canvas';
import { RendererFrameLifecycle } from './renderer-lifecycle';
import {
  boundInspectionMessage,
} from './inspection-transport';
import {
  isEditableSurfaceMessage,
  validateRendererFrameEditContext,
  type EditableSurfaceTarget,
  type RendererFrameEditContext,
} from './editable-surface';
import type { ComponentIndex, SourceRef } from './types';

const FIXTURE_ROOT = resolve(process.cwd(), 'scripts/fixtures/component-renderer');
const PARENT_ORIGIN = 'http://localhost';

type FixtureCase = {
  router: NextRouterKind;
  fixtureDirectory: 'next-app' | 'next-pages';
  componentFile: string;
  routeFile: string;
  boundaryFile: string;
  title: string;
  tone: 'accent' | 'neutral';
  childrenText: string;
};

const FIXTURES: FixtureCase[] = [
  {
    router: 'app',
    fixtureDirectory: 'next-app',
    componentFile: 'src/components/Card.tsx',
    routeFile: 'app/page.tsx',
    boundaryFile: 'app/layout.tsx',
    title: 'App Router',
    tone: 'accent',
    childrenText: 'Static child content',
  },
  {
    router: 'pages',
    fixtureDirectory: 'next-pages',
    componentFile: 'src/components/Card.tsx',
    routeFile: 'pages/index.tsx',
    boundaryFile: 'pages/_app.tsx',
    title: 'Pages Router',
    tone: 'neutral',
    childrenText: 'Static page child',
  },
];

type GeneratedFrame = {
  protocolVersion: 2;
  sessionId: string;
  capabilityToken: string;
  generation: number;
  frameId: string;
  componentId: string;
  componentRevision: string;
};

type RendererRootMetadata = {
  tag: string;
  classTokens: string[];
  id: string | null;
  source: SourceRef;
};

type GeneratedShell = (props: {
  frame: GeneratedFrame;
  root: RendererRootMetadata;
  capabilityToken: string;
  parentOrigin: string;
  children: React.ReactNode;
}) => React.ReactElement;

type MountedShell = {
  container: HTMLDivElement;
  reactRoot: Root;
  domRoot: HTMLElement;
  frame: GeneratedFrame;
  metadataRoot: RendererRootMetadata;
};

const mountedRoots: Root[] = [];

/** Compile the generated TSX shell, leaving React hooks and DOM globals real. */
function evaluateGeneratedShell(source: string): GeneratedShell {
  const withoutImports = source
    .replace(/^import [^\n]*\n/gm, '')
    .replace('export default function RendererFrameShell', 'function RendererFrameShell');
  const compiled = ts.transpileModule(withoutImports, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  return new Function(
    'React',
    'Component',
    'useCallback',
    'useEffect',
    'useLayoutEffect',
    'useRef',
    'useState',
    `${compiled}\nreturn RendererFrameShell;`
  )(
    React,
    React.Component,
    React.useCallback,
    React.useEffect,
    React.useLayoutEffect,
    React.useRef,
    React.useState
  ) as GeneratedShell;
}

function sourceRef(file: string, end: number, contentHash: string): SourceRef {
  return { file, start: 0, end, line: 1, column: 1, contentHash };
}

function buildFixtureHost(fixture: FixtureCase) {
  const fixtureRoot = `${FIXTURE_ROOT}/${fixture.fixtureDirectory}`;
  const componentFile = `${fixture.fixtureDirectory}/${fixture.componentFile}`;
  const routeFile = `${fixture.fixtureDirectory}/${fixture.routeFile}`;
  const boundaryFile = `${fixture.fixtureDirectory}/${fixture.boundaryFile}`;
  const componentSource = readFileSync(resolve(FIXTURE_ROOT, componentFile), 'utf8');
  const routeSource = readFileSync(resolve(FIXTURE_ROOT, routeFile), 'utf8');
  const boundarySource = readFileSync(resolve(FIXTURE_ROOT, boundaryFile), 'utf8');
  const packageJson = JSON.parse(
    readFileSync(resolve(fixtureRoot, 'package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };

  // Keep the smoke tied to the reviewed fixture inputs, not a hand-written
  // component that could drift away from the App/Pages router examples.
  expect(packageJson.dependencies?.next).toBe('14.2.30');
  expect(packageJson.dependencies?.react).toBe('18.3.1');
  expect(componentSource).toContain('<article');
  expect(componentSource).toContain('card-${tone}');
  expect(routeSource).toContain(fixture.title);
  expect(routeSource).toContain(fixture.childrenText);
  expect(boundarySource).toContain(fixture.router === 'app' ? 'children' : 'Component');

  const contentHash = `${fixture.router}-card-content-hash`;
  const definition = sourceRef(componentFile, componentSource.length, contentHash);
  const index: ComponentIndex = {
    revision: `${fixture.router}-index-revision`,
    partial: false,
    profile: {} as ComponentIndex['profile'],
    components: [
      {
        id: 'react:Card',
        dialect: 'react',
        kind: 'component',
        name: 'Card',
        localName: 'Card',
        exportName: fixture.router === 'app' ? 'Card' : 'default',
        description: null,
        definition,
        renderRoot: { tag: 'article', classTokens: ['fixture-card', `card-${fixture.tone}`], id: null, source: definition },
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
  const registry = buildRendererRegistry(index, { revision: index.revision });
  const plan = buildNextRendererHostPlan(
    index,
    registry,
    [
      fixture.router === 'app' ? 'app/layout.tsx' : 'pages/_app.tsx',
      fixture.routeFile,
      fixture.componentFile,
    ],
    {
      sessionId: `fixture-${fixture.router}`,
      capabilityToken: `fixture-token-${fixture.router}`,
      sessionEndpoint: 'http://127.0.0.1:4312/component-renderer',
      parentOrigin: PARENT_ORIGIN,
      routeIdentity: `fixture-${fixture.router}`,
    }
  );
  expect(plan.supported).toBe(true);
  if (!plan.supported) throw new Error(plan.reason);
  const shellSource = plan.files.find((file) => file.kind === 'client-shell')?.contents;
  expect(shellSource).toBeTruthy();
  return {
    shell: evaluateGeneratedShell(shellSource!),
    frame: {
      protocolVersion: 2 as const,
      sessionId: `fixture-${fixture.router}`,
      capabilityToken: `fixture-token-${fixture.router}`,
      generation: 3,
      frameId: `frame-${fixture.router}`,
      componentId: 'react:Card',
      componentRevision: index.revision,
    },
    metadataRoot: {
      tag: 'article',
      classTokens: ['fixture-card', `card-${fixture.tone}`],
      id: null,
      source: definition,
    } satisfies RendererRootMetadata,
    definition,
    contentHash,
  };
}

function renderCardMarkup(fixture: FixtureCase) {
  return React.createElement(
    'article',
    { className: `fixture-card card-${fixture.tone}` },
    React.createElement(
      'style',
      null,
      '.fixture-card { color: rgb(1, 2, 3); } .fixture-card .cta { background: rgb(4, 5, 6); }'
    ),
    React.createElement('h1', null, fixture.title),
    React.createElement(
      'div',
      { className: 'card-body' },
      React.createElement('button', { className: 'cta' }, 'Open')
    ),
    // The tree must not expose framework or inspector internals, even when a
    // project component happens to render one of these nodes.
    React.createElement('script', { type: 'application/json' }, '{"framework":true}')
  );
}

async function mountShell(
  shell: GeneratedShell,
  frame: GeneratedFrame,
  metadataRoot: RendererRootMetadata,
  fixture: FixtureCase
): Promise<MountedShell> {
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  mountedRoots.push(reactRoot);
  await act(async () => {
    reactRoot.render(
      React.createElement(shell, {
        frame,
        root: metadataRoot,
        capabilityToken: frame.capabilityToken,
        parentOrigin: PARENT_ORIGIN,
        children: renderCardMarkup(fixture),
      })
    );
  });
  const domRoot = container.querySelector('article');
  if (!(domRoot instanceof HTMLElement)) throw new Error('Generated Card root did not mount.');
  return { container, reactRoot, domRoot, frame, metadataRoot };
}

function installDomRuntimeShims(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class ResizeObserverShim {
    constructor(_callback: ResizeObserverCallback) {}
    observe(_target: Element): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverShim);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
}

function identityEnvelope(frame: GeneratedFrame) {
  return {
    protocolVersion: frame.protocolVersion,
    sessionId: frame.sessionId,
    capabilityToken: frame.capabilityToken,
    generation: frame.generation,
    frameId: frame.frameId,
    componentId: frame.componentId,
  };
}

function sendToGeneratedFrame(
  frame: GeneratedFrame,
  type: string,
  extra: Record<string, unknown> = {},
  overrides: Partial<ReturnType<typeof identityEnvelope>> = {}
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: PARENT_ORIGIN,
      data: { ...identityEnvelope(frame), ...overrides, ...extra, type },
    })
  );
}

function outboundMessages(posted: unknown[]): Array<Record<string, unknown>> {
  return posted.filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
  );
}

function latestMessage(posted: unknown[], type: string): Record<string, unknown> | undefined {
  const matches = outboundMessages(posted).filter((value) => value.type === type);
  return matches[matches.length - 1];
}

function fixtureTarget(frame: GeneratedFrame, editing: boolean): EditableSurfaceTarget {
  return {
    contentWindow: window,
    exactOrigin: PARENT_ORIGIN,
    surfaceId: frame.frameId,
    sessionId: frame.sessionId,
    capabilityToken: frame.capabilityToken,
    generation: frame.generation,
    frameId: frame.frameId,
    componentId: frame.componentId,
    componentRevision: frame.componentRevision,
    capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing },
  };
}

function fixtureNode(id: string): ComponentCanvasNode {
  return {
    id,
    scope: 'all',
    componentId: 'react:Card',
    presetId: null,
    x: 0,
    y: 0,
    width: 320,
    height: 480,
    order: Number(id.slice(1)),
    collapsed: false,
    generated: true,
    presentation: { background: 'surface', breakpoint: null, locale: null },
  };
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => root.unmount());
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('generated Next renderer fixture acceptance', () => {
  it.each(FIXTURES)(
    '$router router executes the generated inspector runtime against the fixture Card',
    async (fixture) => {
      installDomRuntimeShims();
      const posted: unknown[] = [];
      vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
        posted.push(message);
      }) as typeof window.postMessage);

      const generated = buildFixtureHost(fixture);
      const mounted = await mountShell(
        generated.shell,
        generated.frame,
        generated.metadataRoot,
        fixture
      );

      // The host protocol is exact-origin and identity scoped. Activation is
      // inspection-only; mutation gates stay disabled until the host proves a
      // source target and confirms Edit main.
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:activate', { cascade: true });
        sendToGeneratedFrame(generated.frame, 'ss:requestTree');
      });
      const treeMessage = latestMessage(posted, 'ss:tree');
      expect(treeMessage).toBeDefined();
      expect(treeMessage && boundInspectionMessage(treeMessage)).toMatchObject({ type: 'ss:tree' });
      const tree = treeMessage?.tree as {
        i: number;
        t: string;
        k: Array<{ i: number; t: string; k: Array<{ i: number; t: string }> }>;
      };
      expect(tree.t).toBe('article');
      expect(tree.k.map((child) => child.t)).toEqual(['h1', 'div']);
      expect(tree.k[1]?.k[0]?.t).toBe('button');
      expect(tree.k.some((child) => child.t === 'script')).toBe(false);
      expect(treeMessage && (treeMessage.protocolVersion as number)).toBe(2);
      expect(treeMessage && (treeMessage.sessionId as string)).toBe(generated.frame.sessionId);
      expect(treeMessage && (treeMessage.frameId as string)).toBe(generated.frame.frameId);

      const button = mounted.container.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Fixture button did not mount.');
      const buttonNodeId = tree.k[1]!.k[0]!.i;
      const beforeDirectClick = outboundMessages(posted).length;
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      const directSelection = latestMessage(posted, 'ss:select');
      expect(outboundMessages(posted).length).toBeGreaterThan(beforeDirectClick);
      expect(directSelection?.nodeId).toBe(buttonNodeId);
      expect((directSelection?.signature as { tagName: string }).tagName).toBe('button');
      expect((directSelection?.signature as { sourceFile: string }).sourceFile).toBe(
        generated.definition.file
      );
      expect(latestMessage(posted, 'ss:cascade')?.nodeId).toBe(buttonNodeId);
      expect(latestMessage(posted, 'ss:cascade')?.rules).toBeInstanceOf(Array);
      // jsdom does not implement the full browser cascade, so pin the
      // computed value locally while still asserting the generated cascade
      // message and exact selected node above.
      button.style.backgroundColor = 'rgb(4, 5, 6)';
      expect(getComputedStyle(button).backgroundColor).toBe('rgb(4, 5, 6)');

      // Elements -> frame selection and hover round-trip through the same
      // reverse map that was emitted by ss:tree.
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:selectNode', { id: tree.k[0]!.i });
        sendToGeneratedFrame(generated.frame, 'ss:hoverNode', { id: buttonNodeId });
      });
      expect(latestMessage(posted, 'ss:select')?.nodeId).toBe(tree.k[0]!.i);
      expect(latestMessage(posted, 'ss:hover')?.nodeId).toBe(buttonNodeId);
      button.dispatchEvent(new Event('pointermove', { bubbles: true }));
      expect(latestMessage(posted, 'ss:hover')?.nodeId).toBe(buttonNodeId);
      button.dispatchEvent(new Event('pointerleave', { bubbles: true }));
      expect(latestMessage(posted, 'ss:hover')?.nodeId).toBeNull();

      // The generated tree is bounded before it crosses the host boundary.
      for (let index = 0; index < 257; index += 1) {
        const extra = document.createElement('span');
        extra.textContent = `extra-${index}`;
        mounted.domRoot.append(extra);
      }
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:requestTree');
      });
      const boundedTreeMessage = latestMessage(posted, 'ss:tree');
      expect(boundedTreeMessage?.truncated).toBe(true);
      expect((boundedTreeMessage?.tree as { k: unknown[] }).k.length).toBeLessThanOrEqual(256);
      expect(
        boundedTreeMessage &&
          boundInspectionMessage(boundedTreeMessage)
      ).toMatchObject({ type: 'ss:tree' });

      // Mutation dirtiness is scoped to the root and turns off cleanly.
      const dirtyBefore = outboundMessages(posted).filter(
        (message) => message.type === 'ss:treeDirty'
      ).length;
      const changed = document.createElement('span');
      changed.textContent = 'changed';
      mounted.domRoot.append(changed);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 350));
      expect(
        outboundMessages(posted).filter((message) => message.type === 'ss:treeDirty').length
      ).toBeGreaterThan(dirtyBefore);
      await act(async () => sendToGeneratedFrame(generated.frame, 'ss:treeOff'));
      const dirtyAfterOff = outboundMessages(posted).filter(
        (message) => message.type === 'ss:treeDirty'
      ).length;
      mounted.domRoot.append(document.createElement('span'));
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 350));
      expect(
        outboundMessages(posted).filter((message) => message.type === 'ss:treeDirty').length
      ).toBe(dirtyAfterOff);

      // Restore the button as the active selection after the tree click above
      // (treeOff intentionally clears the reverse map) so style/text previews
      // target the same descendant as the frame.
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });

      // Read-only gates reject text and structure entry points until the host
      // explicitly grants them; once enabled, both messages are observable.
      const beginBefore = outboundMessages(posted).filter(
        (message) => message.type === 'ss:textBegin'
      ).length;
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      expect(
        outboundMessages(posted).filter((message) => message.type === 'ss:textBegin').length
      ).toBe(beginBefore);
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:textInfo', { editable: true });
        sendToGeneratedFrame(generated.frame, 'ss:setElementStructureShortcuts', {
          enabled: true,
        });
      });
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      expect(latestMessage(posted, 'ss:textBegin')).toBeDefined();
      const editableTarget = document.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!editableTarget) throw new Error('Generated text editor did not mount.');
      editableTarget.textContent = 'Edited';
      editableTarget.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', metaKey: true })
      );
      expect(latestMessage(posted, 'ss:textCommit')?.text).toBe('Edited');
      button.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'c', metaKey: true })
      );
      expect(latestMessage(posted, 'ss:elementShortcut')?.key).toBe('c');
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:setElementStructureShortcuts', {
          enabled: false,
        });
      });
      const shortcutsBefore = outboundMessages(posted).filter(
        (message) => message.type === 'ss:elementShortcut'
      ).length;
      button.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'c', metaKey: true })
      );
      expect(
        outboundMessages(posted).filter((message) => message.type === 'ss:elementShortcut').length
      ).toBe(shortcutsBefore);

      // Tailwind/class and CSS previews are local to the selected element. A
      // host-side source proof (below) is required before any confirmed write.
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:mutate', {
          className: 'cta text-lg',
          rules: [],
        });
      });
      expect(button.className).toBe('cta text-lg');
      await act(async () => sendToGeneratedFrame(generated.frame, 'ss:commit'));
      expect(button.className).toBe('cta text-lg');
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:mutate', {
          className: 'cta text-lg',
          rules: [{ decls: { color: 'rgb(9, 8, 7)' } }],
        });
      });
      expect(button.style.color).toBe('rgb(9, 8, 7)');
      await act(async () => sendToGeneratedFrame(generated.frame, 'ss:clearClassPreview'));
      expect(button.style.color).toBe('');

      // Replacing the root simulates HMR. The old reverse-map id is detached,
      // while the stable signature can reselect the replacement after refresh.
      const oldSignature = directSelection?.signature;
      const replacement = document.createElement('article');
      replacement.className = `fixture-card card-${fixture.tone}`;
      replacement.innerHTML = '<h1>Reloaded</h1><div class="card-body"><button class="cta">Open</button></div>';
      mounted.domRoot.replaceWith(replacement);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 0));
      await act(async () => {
        sendToGeneratedFrame(generated.frame, 'ss:requestTree');
        sendToGeneratedFrame(generated.frame, 'ss:reselect', { signature: oldSignature });
      });
      expect(latestMessage(posted, 'ss:select')?.nodeId).toBeDefined();
      expect((latestMessage(posted, 'ss:select')?.signature as { tagName: string }).tagName).toBe(
        'button'
      );

      // Every hostile/stale request is ignored without producing a renderer
      // response, even though it has a plausible message type.
      const responseCountBeforeHostile = outboundMessages(posted).length;
      sendToGeneratedFrame(generated.frame, 'ss:requestTree', {}, { generation: 4 });
      sendToGeneratedFrame(generated.frame, 'ss:requestTree', {}, { frameId: 'wrong-frame' });
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: 'https://evil.example',
          data: { ...identityEnvelope(generated.frame), type: 'ss:requestTree' },
        })
      );
      expect(outboundMessages(posted).length).toBe(responseCountBeforeHostile);

      const negotiatedTarget = fixtureTarget(generated.frame, true);
      expect(
        isEditableSurfaceMessage(negotiatedTarget, {
          ...identityEnvelope(generated.frame),
          type: 'ss:tree',
        })
      ).toBe(true);
      expect(
        isEditableSurfaceMessage(negotiatedTarget, {
          ...identityEnvelope(generated.frame),
          generation: generated.frame.generation + 1,
        })
      ).toBe(false);
      const context: RendererFrameEditContext = {
        componentId: generated.frame.componentId,
        indexedRevision: generated.frame.componentRevision,
        definition: generated.definition,
        descendant: {
          file: generated.definition.file,
          start: 8,
          end: 32,
          contentHash: generated.contentHash,
        },
        confidence: 'exact',
        proof: {
          sessionId: generated.frame.sessionId,
          frameId: generated.frame.frameId,
          componentRevision: generated.frame.componentRevision,
        },
      };
      expect(validateRendererFrameEditContext(negotiatedTarget, context).status).toBe('valid');
      expect(
        validateRendererFrameEditContext(negotiatedTarget, {
          ...context,
          descendant: { ...context.descendant, end: generated.definition.end + 1 },
        }).status
      ).toBe('refused');
      expect(
        validateRendererFrameEditContext(negotiatedTarget, {
          ...context,
          descendant: { ...context.descendant, contentHash: 'stale-hash' },
        }).status
      ).toBe('refused');
      expect(validateRendererFrameEditContext(fixtureTarget(generated.frame, false), context).status).toBe(
        'refused'
      );

      await act(async () => sendToGeneratedFrame(generated.frame, 'ss:deactivate'));
      expect(document.querySelector('[data-ss-overlay]')).toBeNull();
      const afterDeactivate = outboundMessages(posted).length;
      replacement.querySelector('button')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
      expect(outboundMessages(posted).length).toBe(afterDeactivate);
    }
  );

  it('keeps the live renderer pool bounded at six frames', () => {
    const lifecycle = new RendererFrameLifecycle();
    const candidates = Array.from({ length: COMPONENT_CANVAS_MAX_LIVE_FRAMES + 1 }, (_, index) => ({
      node: fixtureNode(`f${index}`),
      visible: true,
      distanceToViewportCenter: index,
      selected: index === 0,
      recentlyUsedAt: index,
    }));
    const queued = lifecycle.setCandidates(candidates);
    queued.forEach((frameId) => lifecycle.markLive(frameId));
    const snapshot = lifecycle.snapshot();
    expect(snapshot.liveFrameIds).toHaveLength(COMPONENT_CANVAS_MAX_LIVE_FRAMES);
    expect(snapshot.liveFrameIds.length + snapshot.queuedFrameIds.length).toBeLessThanOrEqual(
      COMPONENT_CANVAS_MAX_LIVE_FRAMES
    );
  });
});
