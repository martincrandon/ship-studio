import { useCallback, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { DockablePanel, type DockablePanelSurfaceRect } from '../../primitives/DockablePanel';
import { PanelResizeHandle } from '../../primitives/PanelResizeHandle';
import {
  ElementTreePanel,
  type ComponentFocusCrumb,
  type TreeStructureActions,
} from '../../edit/ElementTreePanel';
import {
  CanvasLayersPanel,
  type CanvasLayersPanelProps,
} from '../components-canvas/CanvasLayersPanel';
import type {
  ComponentAwareTreeNode,
  ComponentTreeNode,
  ElementTreeNode,
} from '../../../hooks/useElementTree';
import type { ElementSignature } from '../../../lib/edit';
import type { ComponentDescriptor } from '../../../lib/components/types';
import { maxDockedPanelWidth, TREE_PANEL_MIN_WIDTH_PX } from '../../preview/panelSizing';

/** The component-canvas layer surface that shares the Elements panel shell. */
export type ElementsPanelCanvasLayers = Omit<CanvasLayersPanelProps, 'className'>;

const ELEMENTS_PANEL_MAX_WIDTH_PX = 480;
const ELEMENTS_PANEL_DEFAULT_WIDTH_PX = 240;
const ELEMENTS_PANEL_FLOATING_SIZE = { width: 360, height: 620 };
const ELEMENTS_PANEL_VIEWPORT_RESERVE_PX = 160;
const ELEMENTS_PANEL_WIDTH_STORAGE_KEY = 'elementTreeDockedWidth';

function readElementsPanelWidth(): number | null {
  const saved = Number(localStorage.getItem(ELEMENTS_PANEL_WIDTH_STORAGE_KEY));
  return Number.isFinite(saved) &&
    saved >= TREE_PANEL_MIN_WIDTH_PX &&
    saved <= ELEMENTS_PANEL_MAX_WIDTH_PX
    ? saved
    : null;
}

/** The common model consumed by the singleton Elements surface. */
export interface ElementsPanelModel {
  tree: ElementTreeNode | null;
  componentTree: ComponentAwareTreeNode | null;
  truncated: boolean;
  selectedId: number | null;
  hoveredId: number | null;
  affectedIds: readonly number[];
  selectedComponentKey: string | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  onComponentSelect?: (node: ComponentTreeNode) => void;
  onComponentHover?: (node: ComponentTreeNode | null) => void;
  onComponentFocus?: (node: ComponentTreeNode) => void;
  onComponentFocusParent?: () => void;
  onComponentExitFocus?: () => void;
  selectedSignature?: ElementSignature | null;
  componentFocusPath?: readonly ComponentFocusCrumb[];
  availableComponents?: readonly Pick<ComponentDescriptor, 'id' | 'name'>[];
  canvasLayers?: ElementsPanelCanvasLayers;
  onEditStructuredSlot?: ElementsPanelProps['onEditStructuredSlot'];
  structure?: TreeStructureActions;
  onViewChange?: (view: 'visual' | 'code') => void;
  emptyMessage?: string;
}

/** Selects the model owned by the active workspace surface. */
export function selectElementsPanelModel(
  workspaceTab: string,
  previewModel: ElementsPanelModel | null,
  componentsModel: ElementsPanelModel
): ElementsPanelModel | null {
  if (workspaceTab === 'preview') return previewModel;
  if (workspaceTab === 'components') return componentsModel;
  return null;
}

const EMPTY_ELEMENTS_PANEL_MODEL: ElementsPanelModel = {
  tree: null,
  componentTree: null,
  truncated: false,
  selectedId: null,
  hoveredId: null,
  affectedIds: [],
  selectedComponentKey: null,
  onSelect: () => undefined,
  onHover: () => undefined,
};

export interface ElementsPanelProps {
  model: ElementsPanelModel;
  projectPath: string;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  selectedSignature?: ElementSignature | null;
  componentFocusPath?: readonly ComponentFocusCrumb[];
  availableComponents?: readonly Pick<ComponentDescriptor, 'id' | 'name'>[];
  onEditStructuredSlot?: (
    instanceId: string,
    input: {
      slotName: string;
      operation: 'insert' | 'remove' | 'reorder';
      componentId?: string;
      childInstanceId?: string;
      beforeChildInstanceId?: string;
    }
  ) => void | Promise<void>;
  structure?: TreeStructureActions;
  onViewChange?: (view: 'visual' | 'code') => void;
  emptyMessage?: string;
  visible?: boolean;
  docked: boolean;
  floatingSize: { width: number; height: number };
  initialPosition: () => { left: number; top: number };
  placeholderClassName?: string;
  dockLayoutKey?: string | number;
  surfaceClassName?: string;
  placeholderRef?: RefObject<HTMLDivElement | null>;
  dockedZIndex?: string;
  onSurfaceRectChange?: (rect: DockablePanelSurfaceRect | null) => void;
  /** Optional docked separator, supplied by the owning layout. */
  resize?: {
    value: number;
    min: number;
    max: number;
    label: string;
    onResize: (clientPosition: number) => void;
    onResizeBy: (delta: number) => void;
    onDragChange?: (isDragging: boolean) => void;
    className?: string;
  };
}

export interface WorkspaceElementsPanelProps {
  model?: ElementsPanelModel | null;
  projectPath: string;
  visible: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  selectedSignature?: ElementSignature | null;
  emptyMessage?: string;
  onSurfaceRectChange?: (rect: DockablePanelSurfaceRect | null) => void;
}

/**
 * The only Elements panel shell used by Preview and Components mode. The
 * parent supplies a surface model; this component owns no selection state, so
 * switching the model cannot leak a previous page/frame tree.
 */
export function ElementsPanel({
  model,
  projectPath,
  pinned,
  onTogglePin,
  onClose,
  selectedSignature,
  componentFocusPath,
  availableComponents,
  onEditStructuredSlot,
  structure,
  onViewChange,
  emptyMessage,
  visible = true,
  docked,
  floatingSize,
  initialPosition,
  placeholderClassName,
  dockLayoutKey,
  surfaceClassName,
  placeholderRef,
  dockedZIndex,
  onSurfaceRectChange,
  resize,
}: ElementsPanelProps) {
  return (
    <>
      <DockablePanel
        docked={docked}
        visible={visible}
        ariaLabel="Elements panel"
        positionKey="elementTreeFloatingPosition"
        sizeKey="elementTreeFloatingSize"
        floatingSize={floatingSize}
        initialPosition={initialPosition}
        placeholderClassName={placeholderClassName}
        dockLayoutKey={dockLayoutKey}
        surfaceClassName={surfaceClassName}
        placeholderRef={placeholderRef}
        dockedZIndex={dockedZIndex}
        onSurfaceRectChange={onSurfaceRectChange}
      >
        <div className="elements-panel__content">
          <ElementTreePanel
            tree={model.tree}
            componentTree={model.componentTree}
            truncated={model.truncated}
            selectedId={model.selectedId}
            hoveredId={model.hoveredId}
            affectedIds={model.affectedIds}
            selectedComponentKey={model.selectedComponentKey}
            componentFocusPath={componentFocusPath ?? model.componentFocusPath}
            onSelect={model.onSelect}
            onHover={model.onHover}
            onComponentSelect={model.onComponentSelect}
            onComponentHover={model.onComponentHover}
            onComponentFocus={model.onComponentFocus}
            onComponentFocusParent={model.onComponentFocusParent}
            onComponentExitFocus={model.onComponentExitFocus}
            availableComponents={availableComponents ?? model.availableComponents}
            onEditStructuredSlot={onEditStructuredSlot ?? model.onEditStructuredSlot}
            projectPath={projectPath}
            selectedSignature={selectedSignature ?? model.selectedSignature ?? null}
            onViewChange={onViewChange ?? model.onViewChange}
            structure={structure ?? model.structure}
            pinned={pinned}
            onTogglePin={onTogglePin}
            onClose={onClose}
            topContent={
              model.canvasLayers ? <CanvasLayersPanel {...model.canvasLayers} /> : undefined
            }
            topContentResizable={Boolean(model.canvasLayers)}
            emptyMessage={emptyMessage ?? model.emptyMessage}
          />
        </div>
      </DockablePanel>
      {visible && pinned && resize && <PanelResizeHandle {...resize} orientation="vertical" />}
    </>
  );
}

/**
 * Workspace-level owner for the singleton Elements surface while Components
 * mode owns the main pane. Preview keeps the same panel contract for its page
 * model; this owner only supplies a different model and dock slot, preserving
 * the shared panel's pin, float, and persisted width behavior.
 */
export function WorkspaceElementsPanel({
  model,
  projectPath,
  visible,
  pinned,
  onTogglePin,
  onClose,
  selectedSignature = null,
  emptyMessage,
  onSurfaceRectChange,
}: WorkspaceElementsPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(
    () => readElementsPanelWidth() ?? ELEMENTS_PANEL_DEFAULT_WIDTH_PX
  );
  const [codeView, setCodeView] = useState(false);
  const widthStyle = useMemo(
    () => ({ '--workspace-elements-panel-width': `${width}px` }) as CSSProperties,
    [width]
  );
  const resize = useCallback((clientPosition: number) => {
    const bounds = hostRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const max = maxDockedPanelWidth(
      bounds.width,
      TREE_PANEL_MIN_WIDTH_PX,
      ELEMENTS_PANEL_MAX_WIDTH_PX,
      ELEMENTS_PANEL_VIEWPORT_RESERVE_PX
    );
    const next = Math.max(TREE_PANEL_MIN_WIDTH_PX, Math.min(max, clientPosition - bounds.left));
    setWidth((current) => {
      if (current === next) return current;
      localStorage.setItem(ELEMENTS_PANEL_WIDTH_STORAGE_KEY, String(next));
      return next;
    });
  }, []);
  const resizeBy = useCallback((delta: number) => {
    setWidth((current) => {
      const next = Math.max(
        TREE_PANEL_MIN_WIDTH_PX,
        Math.min(ELEMENTS_PANEL_MAX_WIDTH_PX, current + delta)
      );
      localStorage.setItem(ELEMENTS_PANEL_WIDTH_STORAGE_KEY, String(next));
      return next;
    });
  }, []);
  const onModelViewChange = model?.onViewChange;
  const handleViewChange = useCallback(
    (view: 'visual' | 'code') => {
      setCodeView(view === 'code');
      onModelViewChange?.(view);
    },
    [onModelViewChange]
  );

  return (
    <div
      ref={hostRef}
      className="workspace-elements-panel-host"
      style={widthStyle}
      data-testid="workspace-elements-panel"
    >
      <ElementsPanel
        model={model ?? EMPTY_ELEMENTS_PANEL_MODEL}
        projectPath={projectPath}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onClose={onClose}
        selectedSignature={selectedSignature}
        emptyMessage={emptyMessage}
        visible={visible}
        docked={pinned}
        floatingSize={ELEMENTS_PANEL_FLOATING_SIZE}
        initialPosition={() => ({ left: 72, top: 96 })}
        placeholderClassName="workspace-elements-panel-dock"
        dockLayoutKey={`${pinned ? width : 'floating'}:${codeView ? 'code' : 'visual'}`}
        onSurfaceRectChange={onSurfaceRectChange}
        onViewChange={handleViewChange}
        resize={{
          value: width,
          min: TREE_PANEL_MIN_WIDTH_PX,
          max: ELEMENTS_PANEL_MAX_WIDTH_PX,
          label: 'Resize Elements panel',
          onResize: resize,
          onResizeBy: resizeBy,
          className: 'workspace-elements-panel-resize',
        }}
      />
    </div>
  );
}
