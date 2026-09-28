import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CssCascadePanel } from '../../edit/CssCascadePanel';
import { VisualEditorPanel } from '../../edit/VisualEditorPanel';
import type { EditableSurfaceTarget } from '../../../lib/components/editable-surface';
import { BASE_BREAKPOINT, type ElementSignature } from '../../../lib/edit';
import { useElementTree, type ElementTreeSelection } from '../../../hooks/useElementTree';
import type { useCssAnimations } from '../../../hooks/useCssAnimations';
import type { Selection } from '../../../hooks/useVisualEditor';
import type { ElementSettings } from '../../../hooks/useElementSettings';
import { StyleTab, type StyleTabEditorMode } from './StyleTab';

const SIGNATURE: ElementSignature = {
  tagName: 'button',
  className: 'cta',
  ancestorClasses: ['card'],
  text: 'Open',
  domPath: 'article:0>button:0',
};

const ANIMATIONS_STATE = {
  animations: [],
  loading: false,
  reload: vi.fn(async () => undefined),
  setBody: vi.fn(),
  remove: vi.fn(async () => undefined),
  create: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
} as unknown as ReturnType<typeof useCssAnimations>;

function targetFor(iframe: HTMLIFrameElement): EditableSurfaceTarget {
  return {
    contentWindow: iframe.contentWindow,
    exactOrigin: 'http://127.0.0.1:4321',
    surfaceId: 'component-frame',
    sessionId: 'session-1',
    capabilityToken: 'token-1',
    generation: 1,
    frameId: 'frame-1',
    componentId: 'react:Card',
    componentRevision: 'revision-1',
    capabilities: {
      liveFrame: true,
      snapshots: true,
      accessibility: true,
      editing: true,
    },
  };
}

function sendInspectionMessage(target: EditableSurfaceTarget, data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: target.contentWindow,
        origin: target.exactOrigin,
        data: {
          protocolVersion: 2,
          sessionId: target.sessionId,
          capabilityToken: target.capabilityToken,
          generation: target.generation,
          frameId: target.frameId,
          componentId: target.componentId,
          ...data,
        },
      })
    );
  });
}

function readOnlyReason(readOnly: boolean): string | undefined {
  return readOnly
    ? 'Confirm Edit main to enable style changes to this component definition.'
    : undefined;
}

function TailwindControls({
  selection,
  readOnly,
}: {
  selection: Selection | null;
  readOnly: boolean;
}) {
  return (
    <VisualEditorPanel
      selection={selection}
      projectPath="/project"
      currentClass={SIGNATURE.className}
      textResolution={null}
      imageResolution={null}
      onReplaceImage={async () => undefined}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason(readOnly)}
      breakpoints={[BASE_BREAKPOINT]}
      activeBreakpoint={BASE_BREAKPOINT}
      breakpointTooWide={false}
      onSelectBreakpoint={vi.fn()}
      autoSave={false}
      onToggleAutoSave={vi.fn()}
      onStepGap={vi.fn()}
      onSetSide={vi.fn()}
      onSetPositionSide={vi.fn()}
      onApplyEnum={vi.fn()}
      onReset={vi.fn()}
      multiTarget="all"
      onMultiTargetChange={vi.fn()}
      usage={null}
      onCommit={vi.fn()}
      onClose={vi.fn()}
      embedded
    />
  );
}

function CssControls({
  selection,
  readOnly,
}: {
  selection: ElementTreeSelection | null;
  readOnly: boolean;
}) {
  return (
    <CssCascadePanel
      selection={
        selection?.signature
          ? { signature: selection.signature, instanceCount: selection.count }
          : null
      }
      rows={[]}
      loading={false}
      bodies={{}}
      overridden={{}}
      onChangeBody={vi.fn()}
      onDeleteRule={vi.fn()}
      onWrapRule={vi.fn()}
      onRenameRule={vi.fn()}
      onRenameAtRule={vi.fn()}
      onAddSelector={vi.fn()}
      selectorSuggestions={[]}
      existingSelectors={[]}
      variables={[]}
      animations={[]}
      settings={{} as ElementSettings}
      animationsState={ANIMATIONS_STATE}
      onClose={vi.fn()}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason(readOnly)}
      scope="style"
    />
  );
}

/**
 * Mount the same StyleTab shell and editor panels used by ComponentsWorkspace,
 * with useElementTree as the authenticated current-surface source of truth.
 * This intentionally leaves the write gate unconfirmed: controls must mount
 * for inspection while remaining read-only until Edit main is confirmed.
 */
function ComponentsStyleFlow({
  iframeRef,
  target,
  mode,
}: {
  iframeRef: { current: HTMLIFrameElement | null };
  target: EditableSurfaceTarget;
  mode: StyleTabEditorMode;
}) {
  const [selection, setSelection] = useState<ElementTreeSelection | null>(null);
  const elementTree = useElementTree({
    iframeRef,
    enabled: true,
    surfaceTarget: target,
    onSelectionChange: setSelection,
  });
  const editorSelection: Selection | null = selection?.signature
    ? {
        signature: selection.signature,
        resolution: {
          status: 'resolved',
          file: 'src/components/Card.tsx',
          line: 12,
          column: 3,
          class_name: selection.signature.className,
          confidence: 'dom_path',
        },
        instanceCount: selection.count,
      }
    : null;

  return (
    <StyleTab
      frameStatus={elementTree.inspectionReady ? 'live' : 'loading'}
      frameReason="Waiting for the authenticated component renderer."
      hasSelectedElement={!!selection?.signature}
      sourceStatus={selection?.signature ? 'exact' : 'unproven'}
      editorMode={mode}
      editMainConfirmed={false}
      editingCapability={true}
      renderControls={({ readOnly }) =>
        mode === 'tailwind' ? (
          <TailwindControls selection={editorSelection} readOnly={readOnly} />
        ) : (
          <CssControls selection={selection} readOnly={readOnly} />
        )
      }
    />
  );
}

describe('Components Style inspection flow', () => {
  it.each(['tailwind', 'css'] as const)(
    'moves the real %s controls from loading after an authenticated tree-visible descendant selection',
    (mode) => {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const previewWindow = iframe.contentWindow;
      expect(previewWindow).not.toBeNull();
      vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
      const iframeRef = { current: iframe };
      const target = targetFor(iframe);

      render(<ComponentsStyleFlow iframeRef={iframeRef} target={target} mode={mode} />);
      const styleTab = screen.getByTestId('component-inspector-style-tab');
      expect(styleTab).toHaveAttribute('data-style-tab-state', 'unavailable');

      sendInspectionMessage(target, {
        type: 'ss:tree',
        tree: {
          i: 1,
          t: 'article',
          c: 'card',
          x: '',
          k: [{ i: 2, t: 'button', c: 'cta', x: 'Open', k: [] }],
        },
        truncated: false,
      });
      expect(styleTab).toHaveAttribute('data-style-tab-state', 'prompt');
      expect(screen.getByText(mode === 'tailwind' ? 'Edit' : 'CSS')).toBeInTheDocument();

      sendInspectionMessage(target, {
        type: 'ss:select',
        nodeId: 2,
        affectedNodeIds: [],
        count: 1,
        rect: null,
        signature: SIGNATURE,
      });
      expect(styleTab).toHaveAttribute('data-style-tab-state', 'awaiting-confirmation');
      expect(
        screen.getByTestId('component-inspector-style-tab-awaiting-controls')
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(mode === 'tailwind' ? 'visual-editor-panel' : 'css-cascade-panel')
      ).toBeInTheDocument();

      iframe.remove();
    }
  );
});
