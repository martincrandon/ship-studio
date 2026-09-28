import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasNodeView,
  arrangeUnlockedCanvasNodes,
  boundsForNodes,
  canMutateCanvasNode,
  createCanvasLoadGuard,
  createCanvasHydrationGate,
  createRendererOperationGuard,
  deleteCanvasSelection,
  duplicateCanvasSelection,
  hasLockedCanvasDescendant,
  isCanvasScreenOverlayTarget,
  isCanvasNodeEffectivelyLocked,
  nudgeCanvasSelection,
  orderCanvasNodesForPaint,
  canvasNodeStackingIndex,
  rebaseCanvasTransientFields,
  reorderCanvasLayerNodes,
  reorderCanvasZOrder,
  createCanvasPersistenceScheduler,
  syncComponentCanvasFrameSize,
  shouldResetRendererFrameState,
  rendererInspectionIsReady,
  rendererFrameSnapshotKey,
  hasUsableRendererSnapshotBounds,
} from './ComponentsWorkspace';
import type { ComponentDescriptor } from '../../lib/components/types';
import type { ComponentCanvasNode } from '../../lib/components/canvas';
import type { RendererReadiness } from '../../lib/components/renderer-readiness';
import type { RendererFramePayload } from '../../lib/components/renderer-session';
import { rendererFrameReloadKey } from './RendererFrameHost';
import { RendererSetupModal } from './RendererSetupModal';
import type { NextRendererHostPlan } from '../../lib/components/next-renderer-adapter';
import {
  CanvasSelectionOverlay,
  selectionBoundsForNodes,
} from './components-canvas/CanvasSelectionOverlay';
import {
  adaptCanvasDocument,
  serializeCanvasDocument,
  shouldApplyRendererMeasurement,
} from '../../lib/components/canvas-document';
import { createEmptyCanvasDocument } from '../../lib/components/canvas';
import { CanvasHistory } from '../../lib/components/canvas-history';
import componentWorkspaceSource from './ComponentsWorkspace.tsx?raw';
import workspacePreviewPaneSource from './WorkspacePreviewPane.tsx?raw';
import componentEditPanelSource from './components-inspector/ComponentEditPanel.tsx?raw';

vi.mock('../../lib/ide', () => ({
  getScreenshotBase64: () => Promise.resolve('data:image/png;base64,static-snapshot'),
}));

const node: ComponentCanvasNode = {
  id: 'react:Card#default:all',
  scope: 'all',
  componentId: 'react:Card',
  presetId: null,
  x: 0,
  y: 0,
  width: 320,
  height: 480,
  order: 0,
  collapsed: false,
  generated: true,
  presentation: { background: 'surface', breakpoint: null, locale: null },
};

const component = {
  id: 'react:Card',
  name: 'Card',
  dialect: 'react',
} as ComponentDescriptor;

const supported: RendererReadiness = {
  adapter: 'next',
  live: true,
  label: 'Renderer ready',
  reason: 'The reviewed renderer is available.',
};

const unsupported: RendererReadiness = {
  adapter: 'unsupported',
  live: false,
  label: 'Catalog-only',
  reason: 'This component has no accepted renderer adapter.',
};

const rendererFrame: RendererFramePayload = {
  protocolVersion: 2,
  projectIdentity: '/project',
  sessionId: 'session-1',
  frameId: 'frame-1',
  componentId: 'react:Card',
  componentRevision: 'revision-1',
  generation: 1,
  props: {},
  slots: {},
  presentation: {
    widthMode: 'fixed',
    width: 320,
    height: 480,
    background: 'surface',
    breakpoint: null,
    locale: null,
  },
};

const baseProps = {
  node,
  component,
  selected: false,
  onSelect: vi.fn(),
};

describe('renderer frame publish state', () => {
  it('keeps snapshot identity stable across ephemeral renderer route segments', () => {
    expect(rendererFrameSnapshotKey(rendererFrame, 'shipstudio_renderer_a')).toBe(
      rendererFrameSnapshotKey(rendererFrame, 'shipstudio_renderer_b')
    );
  });

  it('defers snapshot capture until the whole frame is visible', () => {
    const viewport = document.createElement('div');
    viewport.className = 'components-workspace__viewport';
    const iframe = document.createElement('iframe');
    viewport.append(iframe);
    document.body.append(viewport);
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      toJSON: () => ({}),
    });
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 320,
      bottom: 480,
      width: 320,
      height: 480,
      toJSON: () => ({}),
    });

    expect(hasUsableRendererSnapshotBounds(iframe)).toBe(false);

    iframe.remove();
    viewport.remove();
  });

  it('preserves ready across intrinsic size republishes', () => {
    const measuredFrame: RendererFramePayload = {
      ...rendererFrame,
      presentation: { ...rendererFrame.presentation, width: 640, height: 640 },
    };
    const changedFrame: RendererFramePayload = {
      ...measuredFrame,
      props: { title: { kind: 'string', value: 'Changed' } },
    };
    const contentKey = rendererFrameReloadKey(rendererFrame);

    expect(shouldResetRendererFrameState(contentKey, 0, measuredFrame, 0)).toBe(false);
    expect(shouldResetRendererFrameState(contentKey, 0, changedFrame, 0)).toBe(true);
    expect(shouldResetRendererFrameState(contentKey, 0, measuredFrame, 1)).toBe(true);
  });

  it('recovers Style inspection when the tree is valid but the host ready event was missed', () => {
    // This is the reported UI state: the authenticated Elements tree is
    // already visible while the separate host lifecycle latch still says
    // loading. The current surface proof must move Style out of loading.
    expect(rendererInspectionIsReady('loading', true, true)).toBe(true);
    expect(rendererInspectionIsReady('loading', false, true)).toBe(false);
    expect(rendererInspectionIsReady('error', true, true)).toBe(false);
  });
});

describe('CanvasNodeView', () => {
  it('shows an explicit catalog-only reason for unsupported components', () => {
    render(<CanvasNodeView {...baseProps} readiness={unsupported} />);

    expect(screen.getByText('Catalog-only')).toBeInTheDocument();
    expect(screen.getByText(unsupported.reason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up renderer/i })).not.toBeInTheDocument();
  });

  it('keeps Vite catalog cards concise while the adapter is fail-closed', () => {
    render(
      <CanvasNodeView
        {...baseProps}
        readiness={{
          adapter: 'vite',
          live: false,
          label: 'Catalog-only',
          reason: 'Vite stays catalog-only until a reviewed plugin/config integration is accepted.',
        }}
      />
    );

    expect(screen.getByText('Catalog entry')).toBeInTheDocument();
    expect(
      screen.getByText('Live preview is unavailable for this Vite project.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/reviewed plugin\/config integration/)).not.toBeInTheDocument();
  });

  it('keeps renderer enablement out of individual component cards', () => {
    render(<CanvasNodeView {...baseProps} readiness={supported} selected />);

    expect(screen.getByText('Renderer ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /renderer|preview/i })).not.toBeInTheDocument();
  });

  it('exposes selection through the canvas option semantic without changing iframe content', () => {
    render(<CanvasNodeView {...baseProps} readiness={supported} selected />);
    expect(screen.getByRole('option', { name: /Card.*selected/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('uses a multi-select listbox ancestor for canvas options', () => {
    render(
      <div role="listbox" aria-label="Components canvas nodes" aria-multiselectable="true">
        <CanvasNodeView {...baseProps} readiness={supported} selected />
      </div>
    );
    expect(screen.getByRole('listbox', { name: 'Components canvas nodes' })).toHaveAttribute(
      'aria-multiselectable',
      'true'
    );
    expect(screen.getByRole('option', { name: /Card.*selected/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('renders the live frame without intercepting its pointer input', () => {
    const onSelect = vi.fn();
    render(
      <CanvasNodeView
        {...baseProps}
        readiness={supported}
        liveFrame={<iframe data-testid="live-frame" title="Live frame" />}
        onSelect={onSelect}
      />
    );

    expect(screen.getByTestId('live-frame')).toBeInTheDocument();
    expect(screen.queryByText('Renderer ready')).not.toBeInTheDocument();
    expect(document.querySelector('.component-canvas-node__hit-surface')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the loading state visible when a queued frame has no cached poster', () => {
    render(
      <CanvasNodeView
        {...baseProps}
        readiness={supported}
        rendererStatus="queued"
        liveFrame={<iframe data-testid="live-frame" title="Live frame" />}
      />
    );

    expect(screen.getByText('Loading this component in the background.')).toBeInTheDocument();
  });

  it('keeps the cached poster above a queued frame until rendered dimensions arrive', async () => {
    const liveFrame = <iframe data-testid="live-frame" title="Live frame" />;
    const { rerender } = render(
      <CanvasNodeView
        {...baseProps}
        selected
        readiness={supported}
        rendererStatus="queued"
        staticSnapshot={{ snapshotKey: 'card:v2', path: '/project/card.png' }}
        liveFrame={liveFrame}
      />
    );

    expect(await screen.findByTestId('component-canvas-static-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('component-canvas-live-status')).toBeInTheDocument();
    expect(screen.getByText('Loading live preview…')).toBeInTheDocument();
    expect(
      screen.getByText('Using the snapshot until the live component is ready.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('live-frame')).toBeInTheDocument();
    expect(screen.getByTestId('live-frame').parentElement).toHaveClass(
      'component-canvas-node__live-frame--pending'
    );

    rerender(
      <CanvasNodeView
        {...baseProps}
        selected
        readiness={supported}
        rendererStatus="live"
        staticSnapshot={{ snapshotKey: 'card:v2', path: '/project/card.png' }}
        liveFrame={liveFrame}
      />
    );

    expect(screen.queryByTestId('component-canvas-static-snapshot')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-frame').parentElement).not.toHaveClass(
      'component-canvas-node__live-frame--pending'
    );
  });

  it('labels a selected snapshot while a supported live preview is starting', async () => {
    render(
      <CanvasNodeView
        {...baseProps}
        selected
        readiness={supported}
        staticSnapshot={{ snapshotKey: 'card:v2', path: '/project/card.png' }}
      />
    );

    expect(await screen.findByTestId('component-canvas-static-snapshot')).toBeInTheDocument();
    expect(screen.getByText('Loading live preview…')).toBeInTheDocument();
  });

  it('renders an exact static snapshot when a card is outside the live set', async () => {
    render(
      <CanvasNodeView
        {...baseProps}
        readiness={supported}
        rendererStatus="cached"
        staticSnapshot={{ snapshotKey: 'card:v2', path: '/project/card.png' }}
      />
    );

    expect(await screen.findByTestId('component-canvas-static-snapshot')).toBeInTheDocument();
    expect(screen.getByAltText('Card static snapshot')).toBeInTheDocument();
    expect(screen.queryByText('Static snapshot')).not.toBeInTheDocument();
  });

  it('applies the resolved paint stack to overlapping cards', () => {
    render(<CanvasNodeView {...baseProps} readiness={supported} stackingIndex={7} />);
    expect(screen.getByTestId(`component-canvas-node-${node.id}`)).toHaveStyle({ zIndex: '7' });
  });
});

describe('CanvasSelectionOverlay', () => {
  it('exposes accessible rotation hit zones around all four corners', () => {
    const onResizeStart = vi.fn();
    const onResizeKeyboardStart = vi.fn();
    render(
      <CanvasSelectionOverlay
        nodes={[node]}
        selectedIds={[node.id]}
        onResizeStart={onResizeStart}
        onResizeKeyboardStart={onResizeKeyboardStart}
      />
    );

    const rotateHandles = screen.getAllByRole('button', { name: /Rotate selection from/ });
    expect(rotateHandles).toHaveLength(4);
    fireEvent.pointerDown(rotateHandles[0]);
    fireEvent.keyDown(rotateHandles[0], { key: 'Enter' });
    expect(onResizeStart).toHaveBeenCalledWith(expect.anything(), 'rotate');
    expect(onResizeKeyboardStart).toHaveBeenCalledWith(expect.anything(), 'rotate');
  });

  it('computes selection chrome from rotated node corners', () => {
    expect(
      selectionBoundsForNodes([{ id: 'rotated', x: 0, y: 0, width: 100, height: 40, rotation: 90 }])
    ).toEqual({ left: 30, top: -30, right: 70, bottom: 70 });
  });
});

describe('Components canvas persistence boundary', () => {
  it('blocks attempted hydration-time edits and accepts only the matching readable document', () => {
    const gate = createCanvasHydrationGate('/project-a');
    const initial = { ...createEmptyCanvasDocument(), nodes: [{ ...node, x: 12 }] };
    let current = initial;

    gate.begin('/project-b');
    if (gate.canInteract('/project-b')) current = { ...current, nodes: [{ ...node, x: 999 }] };
    expect(current).toBe(initial);

    expect(gate.resolve('/project-a')).toBe(false);
    expect(gate.canInteract('/project-b')).toBe(false);
    expect(gate.resolve('/project-b')).toBe(true);
    if (gate.canInteract('/project-b')) {
      current = { ...createEmptyCanvasDocument(), nodes: [{ ...node, x: 48 }] };
    }
    expect(current.nodes[0]).toMatchObject({ x: 48 });
    expect(current.nodes[0]).not.toMatchObject({ x: 999 });
  });

  it('keeps unreadable hydration read-only after a deferred project switch', () => {
    const gate = createCanvasHydrationGate('/project-a');
    gate.begin('/project-b');
    expect(gate.resolve('/project-b', false)).toBe(true);
    expect(gate.canInteract('/project-b')).toBe(false);
    expect(gate.state).toBe('unreadable');
  });

  it('cancels deferred camera work before it can publish into the next project', () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn();
      const scheduler = createCanvasPersistenceScheduler(180);
      scheduler.schedule(
        createEmptyCanvasDocument() as ReturnType<typeof adaptCanvasDocument>['document'],
        persist
      );
      scheduler.cancel();
      vi.advanceTimersByTime(500);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects deferred pointer and renderer-stop work after a project switch', () => {
    const gate = createCanvasHydrationGate('/project-a');
    const pointerMutation = vi.fn();
    const stopRenderer = vi.fn();
    gate.begin('/project-b');
    if (gate.canInteract('/project-a')) pointerMutation();
    if (gate.canInteract('/project-a')) stopRenderer();
    expect(pointerMutation).not.toHaveBeenCalled();
    expect(stopRenderer).not.toHaveBeenCalled();
  });

  it('persists the first edit of a fresh null-backed workspace document', () => {
    vi.useFakeTimers();
    try {
      const persist = vi.fn();
      const fresh = adaptCanvasDocument(null).document;
      const edited = {
        ...fresh,
        nodes: [{ ...node, x: 48 }],
      };
      const scheduler = createCanvasPersistenceScheduler();

      scheduler.schedule(edited, persist);
      vi.advanceTimersByTime(180);

      expect(persist).toHaveBeenCalledWith(edited);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspends debounce through a long gesture and writes rollback immediately on abort', async () => {
    vi.useFakeTimers();
    try {
      let resolvePersist!: () => void;
      const persist = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvePersist = resolve;
          })
      );
      const initial = { ...createEmptyCanvasDocument(), nodes: [{ ...node, x: 0 }] };
      const intermediate = { ...initial, nodes: [{ ...node, x: 240 }] };
      const rollback = initial;
      const scheduler = createCanvasPersistenceScheduler(180);

      scheduler.beginTransaction();
      scheduler.schedule(intermediate, persist);
      vi.advanceTimersByTime(500);
      expect(persist).not.toHaveBeenCalled();

      scheduler.settle(rollback, persist);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith(rollback);
      resolvePersist();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a late project read after cancellation or project switch', async () => {
    let resolveRead!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    const guard = createCanvasLoadGuard('/project-a');
    guard.cancel();
    resolveRead();
    await deferred;
    expect(guard.accepts('/project-a')).toBe(false);
    expect(createCanvasLoadGuard('/project-a').accepts('/project-b')).toBe(false);
  });

  it('rejects a stale renderer operation after a deferred project switch', async () => {
    let resolveSetup!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    let current = { projectPath: '/project-a', operationVersion: 1 };
    const guard = createRendererOperationGuard('/project-a', 1, () => current);
    current = { projectPath: '/project-b', operationVersion: 2 };
    resolveSetup();
    await deferred;
    expect(guard.isCurrent()).toBe(false);
  });

  it('round-trips scene extensions and unknown fields through the adapted document', () => {
    const source = {
      ...createEmptyCanvasDocument(),
      futureRoot: { keep: true },
      nodes: [
        {
          ...node,
          parentId: null,
          rotation: 15,
          futureNode: 'preserve-me',
        },
      ],
      guides: [{ id: 'guide-1', orientation: 'vertical', position: 120, locked: true }],
    };

    const adapted = adaptCanvasDocument(source).document;
    expect(serializeCanvasDocument(adapted)).toEqual(source);
  });
});

describe('Components canvas control placement', () => {
  it('keeps navigation controls in the canvas toolbar and the editor toggle before Reset layout', () => {
    expect(componentWorkspaceSource.match(/<CanvasToolbar\b/g)).toHaveLength(1);
    expect(componentWorkspaceSource.match(/aria-label="Toggle canvas rulers"/g)).toHaveLength(1);

    const undoPosition = componentWorkspaceSource.indexOf('aria-label="Undo canvas change"');
    const redoPosition = componentWorkspaceSource.indexOf('aria-label="Redo canvas change"');
    const canvasToolbarPosition = componentWorkspaceSource.indexOf('<CanvasToolbar');
    const rulersPosition = componentWorkspaceSource.indexOf('aria-label="Toggle canvas rulers"');
    const resetPosition = componentWorkspaceSource.indexOf('aria-label="Reset layout"');
    const editorTogglePosition = componentWorkspaceSource.indexOf('<VisualEditorToggle');

    expect(undoPosition).toBeLessThan(redoPosition);
    expect(redoPosition).toBeLessThan(canvasToolbarPosition);
    expect(canvasToolbarPosition).toBeLessThan(rulersPosition);
    expect(componentWorkspaceSource).not.toMatch(/>\s*Rulers\s*</);
    expect(componentWorkspaceSource).toContain('<VisualEditorToggle');
    expect(editorTogglePosition).toBeLessThan(resetPosition);
    expect(editorTogglePosition).toBeLessThan(
      componentWorkspaceSource.indexOf('aria-label="Arrange all"')
    );
  });

  it('passes one visual-editor state to both Preview and Components', () => {
    expect(workspacePreviewPaneSource).toContain('const [visualEditorState, setVisualEditorState]');
    expect(workspacePreviewPaneSource).toContain('const visualEditorActive =');
    expect(
      workspacePreviewPaneSource.match(/visualEditorActive={visualEditorActive}/g)
    ).toHaveLength(2);
    expect(
      workspacePreviewPaneSource.match(
        /onVisualEditorActiveChange={handleVisualEditorActiveChange}/g
      )
    ).toHaveLength(2);
    expect(workspacePreviewPaneSource).toContain('handleVisualEditorActiveChange(false)');
  });

  it('keeps workspace actions icon-only with the default variant and 4px group spacing', () => {
    const toolbarStart = componentWorkspaceSource.indexOf(
      '<div className="components-workspace__toolbar-actions components-workspace__toolbar-actions--canvas">'
    );
    const toolbarEnd = componentWorkspaceSource.indexOf('</header>', toolbarStart);
    const toolbar = componentWorkspaceSource.slice(toolbarStart, toolbarEnd);

    expect(toolbar).toContain('aria-label="Reset layout"');
    expect(toolbar).toContain('aria-label="Arrange all"');
    expect(toolbar).toContain('aria-label="Arrange selection"');
    expect(toolbar).toContain(": 'Stop previews'");
    expect(toolbar).toContain('<StopIcon size={14} />');
    expect(toolbar).not.toContain('<CloseIcon size={14} />');
    expect(toolbar.match(/<IconButton\b/g)).toHaveLength(4);
    expect(toolbar).toContain('variant="default"');
    expect(toolbar).not.toContain('size="compact"');
    expect(toolbar).not.toContain('<Button');
  });

  it('starts approved previews automatically without exposing a routine start control', () => {
    expect(componentWorkspaceSource).not.toContain('Start previews');
    expect(componentWorkspaceSource).not.toContain("id: 'components.startRenderer'");
    expect(componentWorkspaceSource).toContain(
      'void prepareRenderer(rendererConsent.integrationVersion)'
    );
    expect(componentWorkspaceSource).toContain('Retry');
  });

  it('starts the canvas scope tabs with all components', () => {
    const allComponentsPosition = componentWorkspaceSource.indexOf(
      '<TabsTab value="all" disabled={!canvasInteractive}>'
    );
    const focusPosition = componentWorkspaceSource.indexOf(
      '<TabsTab value="focus" disabled={!canvasInteractive}>'
    );
    const variantsPosition = componentWorkspaceSource.indexOf(
      '<TabsTab value="variants" disabled={!canvasInteractive}>'
    );

    expect(allComponentsPosition).toBeLessThan(focusPosition);
    expect(focusPosition).toBeLessThan(variantsPosition);
  });

  it('publishes the selected component edit surface to the shared dock', () => {
    expect(componentWorkspaceSource).toContain('onEditPanelChange(renderEditPanel)');
    expect(componentWorkspaceSource).toContain(
      'className="components-workspace__component-style-panel"'
    );
    expect(componentWorkspaceSource).toContain(
      "context={panel.styleEditorMode === 'css' ? 'CSS' : 'Visual Editor'}"
    );
    expect(componentWorkspaceSource).toContain('if (!rendererEditMode)');
    expect(componentWorkspaceSource).toContain('onVisualEditorActiveChange?.(false)');
    expect(componentWorkspaceSource).toContain('rendererEditMode,');
    expect(componentWorkspaceSource).not.toContain('<DockablePanel');
    expect(componentWorkspaceSource).not.toContain('Component inspector sections');
  });

  it('keeps Component, Frame, and QA content in the extracted edit panel', () => {
    expect(componentEditPanelSource).toContain('<TabsTab value="component">Component</TabsTab>');
    expect(componentEditPanelSource).toContain('<TabsTab value="frame">Frame</TabsTab>');
    expect(componentEditPanelSource).toContain('<TabsTab value="qa">QA</TabsTab>');
    expect(componentEditPanelSource).toContain('!canRunAccessibility ||');
  });

  it('publishes canvas layers to the shared Elements panel without a native inspector aside', () => {
    expect(componentWorkspaceSource).not.toContain('components-workspace__inspector');
    expect(componentWorkspaceSource).toContain('onCanvasLayersChange?:');
    expect(componentWorkspaceSource).toContain('elementsPanelCanvasLayers');
    expect(componentWorkspaceSource).toContain(
      'onCanvasLayersChange?.(canvasInteractive ? elementsPanelCanvasLayers : null)'
    );
  });
});

describe('Components canvas document history boundary', () => {
  it('syncs a resized component frame across every canvas scope without moving it', () => {
    const nodes: ComponentCanvasNode[] = [
      { ...node, id: 'react:Card#focus', scope: 'focus', x: 12, y: 24 },
      {
        ...node,
        id: 'react:Card#variant:variants',
        scope: 'variants',
        x: 240,
        y: 48,
        width: 360,
        height: 640,
      },
      {
        ...node,
        id: 'react:Card#all',
        scope: 'all',
        x: -120,
        y: 96,
        width: 280,
        height: 360,
      },
      { ...node, id: 'react:Button#all', componentId: 'react:Button', x: 800, y: 160 },
    ];

    const resized = syncComponentCanvasFrameSize(nodes, 'react:Card', 420, 560);

    expect(
      resized.slice(0, 3).every((candidate) => candidate.width === 420 && candidate.height === 560)
    ).toBe(true);
    expect(resized.slice(0, 3).every((candidate) => candidate.sizeMode === 'fixed')).toBe(true);
    expect(resized.slice(0, 3).map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 12, y: 24 },
      { x: 240, y: 48 },
      { x: -120, y: 96 },
    ]);
    expect(resized[3]).toEqual(nodes[3]);
  });

  it('keeps fixed resize geometry authoritative against late renderer telemetry', () => {
    expect(shouldApplyRendererMeasurement({ sizeMode: 'fixed' })).toBe(false);
    expect(shouldApplyRendererMeasurement({ sizeMode: 'fixed' }, { activeResize: true })).toBe(
      false
    );
    expect(shouldApplyRendererMeasurement({ sizeMode: 'auto' })).toBe(true);
  });

  it('keeps pan and renderer measurement updates out of scene undo/redo', () => {
    const initial = { ...createEmptyCanvasDocument(), nodes: [{ ...node }] };
    const scene = {
      ...initial,
      nodes: [{ ...node, x: 48 }],
    };
    const history = new CanvasHistory(initial);
    history.record('Move canvas node', initial, scene);

    const measured = {
      ...scene,
      nodes: [{ ...scene.nodes[0], width: 420 }],
    };
    const measuredHistoryState = history.replaceCurrent(measured, (entry) => ({
      ...entry,
      before: rebaseCanvasTransientFields(entry.before, scene, measured),
      after: rebaseCanvasTransientFields(entry.after, scene, measured),
    }));
    expect(measuredHistoryState).toBe(measured);

    const panned = {
      ...measured,
      scopes: {
        ...measured.scopes,
        all: { ...measured.scopes.all, camera: { x: 120, y: -24, zoom: 1.2 } },
      },
    };
    history.replaceCurrent(panned, (entry) => ({
      ...entry,
      before: rebaseCanvasTransientFields(entry.before, measured, panned),
      after: rebaseCanvasTransientFields(entry.after, measured, panned),
    }));

    const undone = history.undo();
    expect(undone.nodes[0]).toMatchObject({ x: 0, width: 420 });
    expect(undone.scopes.all.camera).toEqual(panned.scopes.all.camera);
    const redone = history.redo();
    expect(redone.nodes[0]).toMatchObject({ x: 48, width: 420 });
    expect(redone.scopes.all.camera).toEqual(panned.scopes.all.camera);
  });

  it('records preset and guide mutations as independent undoable entries', () => {
    const initial = createEmptyCanvasDocument();
    const withPreset = {
      ...initial,
      nodes: [{ ...node, presetId: 'preset-1', generated: false }],
    };
    const withGuide = {
      ...withPreset,
      guides: [{ id: 'guide-1', orientation: 'vertical' as const, position: 128 }],
    };
    const history = new CanvasHistory(initial);
    history.record('Create canvas preset', initial, withPreset);
    history.record('Update canvas guides', withPreset, withGuide);

    expect(history.undo()).toEqual(withPreset);
    expect(history.undo()).toEqual(initial);
    expect(history.redo()).toEqual(withPreset);
    expect(history.redo()).toEqual(withGuide);
  });
});

describe('Components canvas multi-selection mutations', () => {
  it('duplicates a normalized hierarchy selection with stable IDs and parent links', () => {
    const parent = { ...node, id: 'parent', x: 10, y: 20, order: 0 };
    const child = { ...node, id: 'child', x: 5, y: 6, order: 1, parentId: 'parent' };
    const sibling = { ...node, id: 'sibling', x: 200, y: 20, order: 2 };
    const result = duplicateCanvasSelection(
      [parent, child, sibling],
      ['child', 'parent', 'sibling']
    );

    expect(result.refused).toBe(false);
    expect(result.affectedIds).toEqual(['parent-copy', 'sibling-copy']);
    expect(result.nodes.find((candidate) => candidate.id === 'parent-copy')).toMatchObject({
      parentId: null,
    });
    expect(result.nodes.find((candidate) => candidate.id === 'sibling-copy')).toMatchObject({
      x: 224,
      y: 44,
    });
  });

  it('deletes normalized roots and descendants while leaving selection targets valid', () => {
    const parent = { ...node, id: 'parent', order: 0, presetId: 'preset-parent' };
    const child = { ...node, id: 'child', order: 1, parentId: 'parent', presetId: 'preset-child' };
    const sibling = { ...node, id: 'sibling', order: 2, presetId: 'preset-sibling' };
    const result = deleteCanvasSelection([parent, child, sibling], ['parent', 'child']);

    expect(result.refused).toBe(false);
    expect(result.affectedIds).toEqual(['parent', 'child']);
    expect(result.nodes.map((candidate) => candidate.id)).toEqual(['sibling']);
  });

  it('refuses deleting a parent when it would strand a locked descendant', () => {
    const parent = { ...node, id: 'parent', order: 0 };
    const lockedChild = { ...node, id: 'locked-child', order: 1, parentId: 'parent', locked: true };
    const result = deleteCanvasSelection([parent, lockedChild], ['parent']);
    expect(result.refused).toBe(true);
    expect(result.affectedIds).toEqual([]);
    expect(result.nodes).toEqual([parent, lockedChild]);
  });

  it('keeps locked nodes unchanged during layout reset', () => {
    const locked = { ...node, id: 'locked', x: 999, y: 777, order: 0, locked: true };
    const movable = { ...node, id: 'movable', x: 0, y: 0, order: 1 };
    expect(arrangeUnlockedCanvasNodes([locked, movable])[0]).toEqual(locked);
  });

  it('keeps each canvas scope on its own reset grid', () => {
    const allFirst = { ...node, id: 'all-first', x: 900, y: 900, order: 0 };
    const allSecond = { ...node, id: 'all-second', x: 1200, y: 900, order: 1 };
    const focus = { ...node, id: 'focus', scope: 'focus' as const, x: -400, y: 700, order: 0 };
    const arranged = arrangeUnlockedCanvasNodes([focus, allSecond, allFirst]);

    expect(arranged.find((candidate) => candidate.id === 'all-first')).toMatchObject({
      x: 32,
      y: 32,
    });
    expect(arranged.find((candidate) => candidate.id === 'all-second')).toMatchObject({
      x: 376,
      y: 32,
    });
    expect(arranged.find((candidate) => candidate.id === 'focus')).toMatchObject({
      x: 32,
      y: 32,
    });
  });

  it('arranges hierarchy roots while preserving child parent-local geometry', () => {
    const first = { ...node, id: 'first', x: 900, y: 40, order: 0 };
    const child = { ...node, id: 'child', parentId: 'first', x: 24, y: 36, order: 0 };
    const second = { ...node, id: 'second', x: 20, y: 800, order: 1 };
    const arranged = arrangeUnlockedCanvasNodes([first, child, second]);
    expect(arranged.find((candidate) => candidate.id === 'child')).toMatchObject({
      x: 24,
      y: 36,
      parentId: 'first',
    });
    expect(arranged.find((candidate) => candidate.id === 'first')).not.toMatchObject({
      x: 900,
      y: 40,
    });
    expect(arranged.find((candidate) => candidate.id === 'second')).not.toMatchObject({
      x: 20,
      y: 800,
    });
  });

  it('arranges a selected normalized root without moving its descendants', () => {
    const parent = { ...node, id: 'parent', x: 900, y: 40, order: 0 };
    const child = { ...node, id: 'child', parentId: 'parent', x: 24, y: 36, order: 0 };
    const sibling = { ...node, id: 'sibling', x: 20, y: 800, order: 1 };
    const arranged = arrangeUnlockedCanvasNodes([parent, child, sibling], ['parent', 'child']);
    expect(arranged.find((candidate) => candidate.id === 'child')).toMatchObject({
      x: 24,
      y: 36,
      parentId: 'parent',
    });
    expect(arranged.find((candidate) => candidate.id === 'sibling')).toMatchObject({
      x: 20,
      y: 800,
    });
  });

  it('uses persisted order and hierarchy for deterministic paint stacking', () => {
    const back = { ...node, id: 'back', order: 4 };
    const front = { ...node, id: 'front', order: 1 };
    const child = { ...node, id: 'child', parentId: 'front', order: 0 };
    expect(orderCanvasNodesForPaint([back, child, front]).map((candidate) => candidate.id)).toEqual(
      ['front', 'child', 'back']
    );
    expect(canvasNodeStackingIndex('front', [back, child, front])).toBeLessThan(
      canvasNodeStackingIndex('back', [back, child, front])
    );
    expect(canvasNodeStackingIndex('child', [back, child, front])).toBeGreaterThan(
      canvasNodeStackingIndex('front', [back, child, front])
    );
  });

  it('treats locked ancestors and locked descendants as immutable subtrees', () => {
    const lockedParent = { ...node, id: 'locked-parent', locked: true };
    const child = { ...node, id: 'child', parentId: 'locked-parent' };
    const parent = { ...node, id: 'parent' };
    const lockedChild = { ...node, id: 'locked-child', parentId: 'parent', locked: true };
    const nodes = [lockedParent, child, parent, lockedChild];
    expect(isCanvasNodeEffectivelyLocked('child', nodes)).toBe(true);
    expect(hasLockedCanvasDescendant('parent', nodes)).toBe(true);
    expect(canMutateCanvasNode('child', nodes)).toBe(false);
    expect(canMutateCanvasNode('parent', nodes)).toBe(false);
  });

  it('normalizes parent and child selection before a world-space nudge', () => {
    const parent = { ...node, id: 'parent', x: 100, y: 80 };
    const child = { ...node, id: 'child', x: 10, y: 12, parentId: 'parent' };
    const next = nudgeCanvasSelection([parent, child], ['parent', 'child'], 1, 0, 8);
    expect(next.find((candidate) => candidate.id === 'parent')).toMatchObject({ x: 108, y: 80 });
    expect(next.find((candidate) => candidate.id === 'child')).toMatchObject({ x: 10, y: 12 });
  });

  it.each(['into', 'before', 'after'] as const)(
    'rejects %s drops onto an unlocked container with a locked descendant',
    (position) => {
      const dragged = { ...node, id: 'dragged', order: 0 };
      const target = { ...node, id: 'target', order: 1 };
      const lockedChild = {
        ...node,
        id: 'locked-child',
        parentId: 'target',
        order: 0,
        locked: true,
      };
      const nodes = [dragged, target, lockedChild];
      const result = reorderCanvasLayerNodes(nodes, {
        draggedId: 'dragged',
        targetId: 'target',
        position,
      });
      expect(result.accepted).toBe(false);
      expect(result.nodes).toEqual(nodes);
    }
  );

  it('does not renumber or reparent effectively locked siblings during a drop', () => {
    const lockedParent = { ...node, id: 'locked-parent', order: 0, locked: true };
    const lockedChild = {
      ...node,
      id: 'locked-child',
      parentId: 'locked-parent',
      order: 7,
      x: 12,
      y: 18,
    };
    const dragged = { ...node, id: 'dragged', order: 1 };
    const target = { ...node, id: 'target', order: 2 };
    const nodes = [lockedParent, lockedChild, dragged, target];
    const result = reorderCanvasLayerNodes(nodes, {
      draggedId: 'dragged',
      targetId: 'target',
      position: 'after',
    });
    expect(result.accepted).toBe(true);
    expect(result.nodes.find((candidate) => candidate.id === 'locked-parent')).toEqual(
      lockedParent
    );
    expect(result.nodes.find((candidate) => candidate.id === 'locked-child')).toEqual(lockedChild);
  });

  it('keeps effectively locked z-order slots immutable while moving movable nodes', () => {
    const locked = { ...node, id: 'locked', order: 1, locked: true };
    const first = { ...node, id: 'first', order: 0 };
    const second = { ...node, id: 'second', order: 2 };
    const result = reorderCanvasZOrder([first, locked, second], ['first'], 1);

    expect(result.find((candidate) => candidate.id === 'locked')).toEqual(locked);
    expect(result.find((candidate) => candidate.id === 'first')).toMatchObject({ order: 2 });
    expect(result.find((candidate) => candidate.id === 'second')).toMatchObject({ order: 0 });
  });

  it('includes rotated extents in fit bounds', () => {
    expect(boundsForNodes([{ ...node, x: 0, y: 0, width: 100, height: 40, rotation: 90 }])).toEqual(
      {
        x: 30,
        y: -30,
        width: 40,
        height: 100,
      }
    );
  });
});

describe('canvas screen-space controls', () => {
  it('keeps HUD controls out of the canvas gesture handler', () => {
    const overlay = document.createElement('div');
    overlay.className = 'components-workspace__screen-overlay';
    const button = document.createElement('button');
    overlay.append(button);
    document.body.append(overlay);

    expect(isCanvasScreenOverlayTarget(button)).toBe(true);
    expect(isCanvasScreenOverlayTarget(document.createElement('div'))).toBe(false);

    overlay.remove();
  });
});

describe('RendererSetupModal', () => {
  const plan: NextRendererHostPlan = {
    supported: true,
    router: 'app',
    routeSegment: 'shipstudio_renderer_next-host-v1',
    routeFile: 'app/shipstudio_renderer_next-host-v1/page.tsx',
    files: [
      {
        relativePath: 'app/shipstudio_renderer_next-host-v1/page.tsx',
        contents: 'preflight only',
        kind: 'route',
      },
    ],
    supportedComponentIds: ['react:Card'],
    sourceRevision: 'revision-1',
    setupReason: 'Uses the project runtime.',
  };

  it('shows the proposed files before collecting first project consent', () => {
    const onEnable = vi.fn();
    render(
      <RendererSetupModal
        isOpen
        adapterEnabled
        approved={false}
        phase="review"
        plan={plan}
        error={null}
        onEnable={onEnable}
        onReset={vi.fn()}
        onDisable={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(plan.routeFile)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow and enable live previews' }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });
});
