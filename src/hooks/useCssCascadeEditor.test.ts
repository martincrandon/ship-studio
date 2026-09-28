import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/edit', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit')>();
  return { ...actual, resolveClassnameSource: vi.fn() };
});

vi.mock('../lib/cssCascade', async (importActual) => {
  const actual = await importActual<typeof import('../lib/cssCascade')>();
  return {
    ...actual,
    applyCssRuleText: vi.fn(),
    locateCssRules: vi.fn(),
    listCssClasses: vi.fn(),
    listCssSelectors: vi.fn(),
    listCssVariables: vi.fn(),
  };
});

import { useCssCascadeEditor } from './useCssCascadeEditor';
import {
  locateCssRules,
  applyCssRuleText,
  listCssClasses,
  listCssSelectors,
  listCssVariables,
  rowKey,
} from '../lib/cssCascade';
import { resolveClassnameSource } from '../lib/edit';
import type { EditableSurfaceTarget } from '../lib/components/editable-surface';
import type { ComponentFocusContext } from '../lib/components/focus';
import type { SourceRef } from '../lib/components/types';

function makeSurface(editing: boolean) {
  const contentWindow = { postMessage: vi.fn() } as unknown as Window;
  const target: EditableSurfaceTarget = {
    contentWindow,
    exactOrigin: 'http://127.0.0.1:4312',
    surfaceId: 'component-frame',
    sessionId: 'session-1',
    capabilityToken: 'token-1',
    generation: 2,
    frameId: 'frame-1',
    componentId: 'react:Card',
    componentRevision: 'revision-1',
    capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing },
  };
  return { contentWindow, target };
}

const selection = {
  type: 'ss:select',
  protocolVersion: 2,
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  generation: 2,
  frameId: 'frame-1',
  componentId: 'react:Card',
  nodeId: 1,
  affectedNodeIds: [1],
  count: 1,
  rect: { top: 0, left: 0, width: 100, height: 40 },
  signature: { tagName: 'button', className: 'card', ancestorClasses: [], domPath: 'button:0' },
};

const cascade = {
  type: 'ss:cascade',
  protocolVersion: 2,
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  generation: 2,
  frameId: 'frame-1',
  componentId: 'react:Card',
  nodeId: 1,
  rules: [
    {
      selector: '.card',
      declarations: [{ prop: 'color', value: 'red', important: false, active: true }],
      specificity: [0, 1, 0],
      sourceOrder: 0,
      mediaText: null,
      mediaMinPx: null,
      inactiveMedia: false,
      layer: null,
      container: null,
      supports: null,
      href: 'http://127.0.0.1:4312/styles.css',
      origin: 'author',
    },
  ],
};

const childSource: SourceRef = {
  file: 'components/Card.tsx',
  start: 10,
  end: 20,
  line: 1,
  column: 1,
  contentHash: 'component-hash',
};

const componentFocus: ComponentFocusContext = {
  indexRevision: 'index-1',
  routeKey: null,
  componentId: 'react:Card',
  instanceId: 'instance-1',
  name: 'Card',
  definition: {
    file: 'components/Card.tsx',
    start: 0,
    end: 100,
    line: 1,
    column: 1,
    contentHash: 'component-hash',
  },
  invocation: {
    file: 'app/page.tsx',
    start: 0,
    end: 12,
    line: 1,
    column: 1,
    contentHash: 'page-hash',
  },
  ancestry: [],
  capabilities: { editMain: true, focusedVisualEditing: true },
  usageCount: 1,
  affectsAllUsages: true,
  selectedChild: childSource,
};

function resolvedCssLocation(source: SourceRef, innerText = '\n  color: red;\n') {
  return {
    status: 'resolved' as const,
    file: source.file,
    line: source.line,
    inner_text: innerText,
    source_start: source.start,
    source_end: source.end,
    source_hash: source.contentHash,
  };
}

async function dispatch(
  surface: ReturnType<typeof makeSurface>,
  data: Record<string, unknown>,
  origin = surface.target.exactOrigin,
  source: MessageEventSource = surface.contentWindow
) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source, origin, data }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderFocusedEditor(
  surface: ReturnType<typeof makeSurface>,
  sourceEditGuard: NonNullable<Parameters<typeof useCssCascadeEditor>[0]['sourceEditGuard']>
) {
  const componentFocusRef = { current: componentFocus };
  return renderHook(() =>
    useCssCascadeEditor({
      iframeRef: { current: null },
      surfaceTarget: surface.target,
      projectPath: '/project',
      enabled: true,
      inspectionEnabled: true,
      writeEnabled: true,
      componentFocusRef,
      sourceEditGuard,
      sourceBoundary: componentFocus.definition,
      onToast: vi.fn(),
    })
  );
}

async function saveBody(hook: ReturnType<typeof renderFocusedEditor>) {
  const row = hook.result.current.rows[0];
  expect(row).toBeDefined();
  if (!row) return;
  act(() => {
    hook.result.current.setBody(rowKey(row), {
      items: [{ kind: 'decl', prop: 'color', value: 'blue', important: false }],
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useCssCascadeEditor negotiated read-only surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listCssClasses).mockResolvedValue([]);
    vi.mocked(listCssSelectors).mockResolvedValue([]);
    vi.mocked(listCssVariables).mockResolvedValue([]);
    vi.mocked(locateCssRules).mockResolvedValue([
      { status: 'resolved', file: 'styles.css', line: 1, inner_text: '\n  color: red;\n' },
    ]);
  });

  it('loads authenticated selection and cascade data while editing is disabled', async () => {
    const surface = makeSurface(false);
    const hook = renderHook(() =>
      useCssCascadeEditor({
        iframeRef: { current: null },
        surfaceTarget: surface.target,
        projectPath: '/project',
        enabled: false,
        inspectionEnabled: true,
        writeEnabled: false,
        onToast: vi.fn(),
      })
    );

    await dispatch(surface, { ...selection, className: undefined });
    expect(hook.result.current.selection?.signature.tagName).toBe('button');

    await dispatch(surface, cascade);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.rows[0]).toMatchObject({
      selector: '.card',
      editable: true,
      file: 'styles.css',
    });
    expect(hook.result.current.focusedSource).toEqual(null);

    await dispatch(surface, { ...selection, className: undefined }, 'https://evil.test');
    expect(hook.result.current.selection?.signature.tagName).toBe('button');
  });

  it('refuses CSS preview/source writes when writeEnabled is false', async () => {
    const surface = makeSurface(true);
    const hook = renderHook(() =>
      useCssCascadeEditor({
        iframeRef: { current: null },
        surfaceTarget: surface.target,
        projectPath: '/project',
        enabled: true,
        inspectionEnabled: true,
        writeEnabled: false,
        onToast: vi.fn(),
      })
    );

    await dispatch(surface, selection);
    await dispatch(surface, cascade);
    const row = hook.result.current.rows[0];
    expect(row).toBeDefined();

    act(() => {
      hook.result.current.setBody(row ? `${row.file}|${row.selector}|0|${row.index}` : '', {
        items: [{ kind: 'decl', prop: 'color', value: 'blue', important: false }],
      });
    });

    expect(applyCssRuleText).not.toHaveBeenCalled();
    expect(
      (surface.contentWindow.postMessage as ReturnType<typeof vi.fn>).mock.calls.some(
        ([message]) =>
          message?.type === 'ss:previewRuleText' || message?.type === 'ss:commitRulePreview'
      )
    ).toBe(false);
  });

  it('requires an exact stylesheet source target inside the component definition', async () => {
    vi.useFakeTimers();
    const surface = makeSurface(true);
    const ruleSource: SourceRef = {
      file: 'components/Card.tsx',
      start: 30,
      end: 52,
      line: 2,
      column: 1,
      contentHash: 'component-hash',
    };
    vi.mocked(resolveClassnameSource).mockResolvedValue({
      status: 'resolved',
      file: childSource.file,
      line: childSource.line,
      column: childSource.column,
      class_name: 'card',
      source_start: childSource.start,
      source_end: childSource.end,
      source_hash: childSource.contentHash,
      confidence: 'source',
    });
    vi.mocked(locateCssRules).mockResolvedValue([resolvedCssLocation(ruleSource)]);
    vi.mocked(applyCssRuleText).mockResolvedValue(undefined);
    const sourceEditGuard = vi.fn((source: SourceRef | null) =>
      source &&
      source.file === componentFocus.definition.file &&
      source.start >= componentFocus.definition.start &&
      source.end <= componentFocus.definition.end &&
      source.contentHash === componentFocus.definition.contentHash
        ? { status: 'valid' as const, source }
        : { status: 'refused' as const, reason: 'outside component definition' }
    );
    const hook = renderFocusedEditor(surface, sourceEditGuard);

    await dispatch(surface, selection);
    await dispatch(surface, cascade);
    expect(hook.result.current.focusedSource).toEqual(ruleSource);
    await saveBody(hook);

    expect(applyCssRuleText).toHaveBeenCalledWith(
      '/project',
      ruleSource.file,
      '.card',
      null,
      '\n  color: red;\n',
      '\n  color: blue;\n'
    );
    expect(sourceEditGuard.mock.calls.some(([source]) => source?.start === ruleSource.start)).toBe(
      true
    );
  });

  it.each([
    {
      name: 'a global stylesheet rule',
      location: resolvedCssLocation({
        file: 'styles/global.css',
        start: 30,
        end: 52,
        line: 2,
        column: 1,
        contentHash: 'global-hash',
      }),
    },
    {
      name: 'a rule outside the definition range',
      location: resolvedCssLocation({
        file: componentFocus.definition.file,
        start: 150,
        end: 172,
        line: 8,
        column: 1,
        contentHash: componentFocus.definition.contentHash,
      }),
    },
  ])('rejects $name before any source write', async ({ location }) => {
    vi.useFakeTimers();
    const surface = makeSurface(true);
    vi.mocked(resolveClassnameSource).mockResolvedValue({
      status: 'resolved',
      file: childSource.file,
      line: childSource.line,
      column: childSource.column,
      class_name: 'card',
      source_start: childSource.start,
      source_end: childSource.end,
      source_hash: childSource.contentHash,
      confidence: 'source',
    });
    vi.mocked(locateCssRules).mockResolvedValue([location]);
    const sourceEditGuard = vi.fn((source: SourceRef | null) =>
      source &&
      source.file === componentFocus.definition.file &&
      source.start >= componentFocus.definition.start &&
      source.end <= componentFocus.definition.end &&
      source.contentHash === componentFocus.definition.contentHash
        ? { status: 'valid' as const, source }
        : { status: 'refused' as const, reason: 'outside component definition' }
    );
    const hook = renderFocusedEditor(surface, sourceEditGuard);

    await dispatch(surface, selection);
    await dispatch(surface, cascade);
    expect(hook.result.current.focusedSource).toBeNull();
    await saveBody(hook);

    expect(applyCssRuleText).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'an ambiguous rule location',
      refreshed: { status: 'multiple' as const, files: ['a.css', 'b.css'] },
    },
    {
      name: 'a stale rule location',
      refreshed: resolvedCssLocation({
        ...childSource,
        file: componentFocus.definition.file,
        start: 30,
        end: 52,
        line: 2,
        contentHash: 'stale-hash',
      }),
    },
  ])('rejects $name without falling back to another stylesheet target', async ({ refreshed }) => {
    vi.useFakeTimers();
    const surface = makeSurface(true);
    const ruleSource: SourceRef = {
      file: componentFocus.definition.file,
      start: 30,
      end: 52,
      line: 2,
      column: 1,
      contentHash: componentFocus.definition.contentHash,
    };
    vi.mocked(resolveClassnameSource).mockResolvedValue({
      status: 'resolved',
      file: childSource.file,
      line: childSource.line,
      column: childSource.column,
      class_name: 'card',
      source_start: childSource.start,
      source_end: childSource.end,
      source_hash: childSource.contentHash,
      confidence: 'source',
    });
    vi.mocked(locateCssRules)
      .mockResolvedValueOnce([resolvedCssLocation(ruleSource)])
      .mockResolvedValue([refreshed]);
    const sourceEditGuard = vi.fn((source: SourceRef | null) =>
      source
        ? { status: 'valid' as const, source }
        : { status: 'refused' as const, reason: 'missing' }
    );
    const hook = renderFocusedEditor(surface, sourceEditGuard);

    await dispatch(surface, selection);
    await dispatch(surface, cascade);
    await saveBody(hook);

    expect(applyCssRuleText).not.toHaveBeenCalled();
  });
});

describe('useCssCascadeEditor controlled edit mode', () => {
  beforeEach(() => {
    vi.mocked(listCssClasses).mockResolvedValue([]);
    vi.mocked(listCssSelectors).mockResolvedValue([]);
    vi.mocked(listCssVariables).mockResolvedValue([]);
  });

  it('follows workspace-owned edit mode and reports toggle intent', () => {
    const onEditModeChange = vi.fn();
    const hook = renderHook(
      ({ active }) =>
        useCssCascadeEditor({
          iframeRef: { current: null },
          projectPath: '/project',
          enabled: true,
          editMode: active,
          onEditModeChange,
          onToast: vi.fn(),
        }),
      { initialProps: { active: false } }
    );

    expect(hook.result.current.editMode).toBe(false);

    act(() => hook.result.current.toggleEditMode());
    expect(onEditModeChange).toHaveBeenCalledWith(true);
    expect(hook.result.current.editMode).toBe(false);

    act(() => hook.rerender({ active: true }));
    expect(hook.result.current.editMode).toBe(true);

    act(() => hook.result.current.toggleEditMode());
    expect(onEditModeChange).toHaveBeenLastCalledWith(false);
  });
});
