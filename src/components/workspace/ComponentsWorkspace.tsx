import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AlignJustifyIcon,
  ComponentsIcon,
  GridIcon,
  InfoIcon,
  RedoIcon,
  ResetIcon,
  RulerIcon,
  StopIcon,
  UndoIcon,
} from '@/components/icons';
import { useCommands } from '../../commands/useCommands';
import { useInvoke } from '../../hooks/useInvoke';
import { useComponentCatalog } from '../../hooks/useComponentCatalog';
import type { ProjectType } from '../../lib/static-server';
import type {
  ComponentDescriptor,
  ComponentId,
  ComponentPropDescriptor,
  SourceRef,
  StaticValue,
} from '../../lib/components/types';
import type { ComponentsNavigation } from './workspaceViewState';
import {
  autoLayoutCanvasNodes,
  arrangeCanvasNodes,
  CANVAS_SCOPE_ORDER,
  COMPONENT_CANVAS_MAX_LIVE_FRAMES,
  componentCanvasNodeId,
  componentPreviewPresetStorageKey,
  createEmptyCanvasDocument,
  duplicateCanvasNode,
  expandFiniteVariantMatrix,
  ensureCanvasNodeLimit,
  resolveGeneratedCanvasVariant,
  resolveGeneratedCanvasVariantForComponent,
  type CanvasScope,
  type CanvasFrameHeight,
  type ComponentCanvasNode,
  type ComponentCanvasGuide,
  type GeneratedCanvasVariant,
} from '../../lib/components/canvas';
import {
  flushComponentCanvasWrites,
  readAdaptedComponentCanvasDocument,
  writeAdaptedComponentCanvasDocument,
} from '../../lib/components/canvas-storage';
import {
  shouldApplyRendererMeasurement,
  type CanvasDocumentV2,
} from '../../lib/components/canvas-document';
import {
  animateCamera,
  CANVAS_KEYBOARD_ZOOM_STEP,
  fitBounds,
  pan,
  quantizeZoom,
  screenToWorld,
  wheelPanDelta,
  wheelZoomDelta,
  worldToScreen,
  zoomBy,
  zoomAt,
  CANVAS_DRAG_THRESHOLD_PX,
  type CameraBounds,
  type CanvasCameraState,
} from '../../lib/components/canvas-camera';
import { cullCanvasNodes } from '../../lib/components/canvas-culling';
import {
  CanvasHistory,
  type CanvasHistoryEntry,
  type CanvasHistoryTransaction,
} from '../../lib/components/canvas-history';
import {
  mapCanvasKeyboardIntent,
  shouldIgnoreCanvasKeyboardEvent,
  isCanvasTextInputTarget,
} from '../../lib/components/canvas-input';
import {
  canvasNodeWorldPosition,
  canvasWorldToLocalPosition,
  normalizeCanvasHierarchySelection,
  reparentCanvasNodes,
  toCanvasWorldNodes,
} from '../../lib/components/canvas-hierarchy';
import {
  readComponentPreviewPresetStore,
  createComponentPreviewPreset,
  deleteComponentPreviewPreset,
  duplicateComponentPreviewPreset,
  reconcileComponentPreviewPresets,
  writeComponentPreviewPresetStore,
  type ComponentPreviewPreset,
} from '../../lib/components/presets';
import {
  stopComponentRendererSession,
  installComponentRendererHost,
  installComponentRendererRegistry,
  prepareComponentRendererSession,
  publishComponentRendererFrame,
  cleanupComponentRendererSession,
  toRendererSessionDescriptor,
  getComponentRendererConsent,
  grantComponentRendererConsent,
  revokeComponentRendererConsent,
  COMPONENT_RENDERER_INTEGRATION_VERSION,
} from '../../lib/components/canvas-storage';
import { buildRendererRegistry } from '../../lib/components/renderer-registry';
import { rendererReadiness, type RendererReadiness } from '../../lib/components/renderer-readiness';
import {
  componentRendererEditingEnabled,
  componentRendererStageEnabled,
  COMPONENT_RENDERER_FLAGS,
} from '../../lib/components/feature-flags';
import {
  buildNextRendererHostPlan,
  type NextRendererHostPlan,
} from '../../lib/components/next-renderer-adapter';
import type { ComponentSourceSnapshot } from '../../lib/components/types';
import type { ComponentRendererSession } from '../../lib/components/canvas-storage';
import type {
  RendererFramePayload,
  RendererSessionDescriptor,
  RendererHostEvent,
  RendererA11yFinding,
} from '../../lib/components/renderer-session';
import type { ElementTreeSelection } from '../../hooks/useElementTree';
import {
  rectFromNode,
  rotatedRectBounds,
  snapCanvasRect,
  type CanvasGuide,
} from '../../lib/components/canvas-geometry';
import {
  deactivateEditableSurface,
  postToEditableSurface,
  validateRendererFrameEditContext,
  type EditableSurfaceTarget,
  type RendererFrameEditContext,
} from '../../lib/components/editable-surface';
import { RendererFrameHost, rendererFrameReloadKey } from './RendererFrameHost';
import { PixelLoader } from '../primitives/PixelLoader';
import { RendererSetupModal } from './RendererSetupModal';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ContextMenu, ContextMenuTrigger } from '../primitives/ContextMenu';
import { EmptyState } from '../primitives/EmptyState';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { ModalFrame } from '../primitives/ModalFrame';
import { EditPanelShell } from '../edit/EditPanelShell';
import { VisualEditorPanel } from '../edit/VisualEditorPanel';
import { VisualEditorToggle } from '../edit/VisualEditorToggle';
import { CssCascadePanel } from '../edit/CssCascadePanel';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useVisualEditor } from '../../hooks/useVisualEditor';
import { useCssCascadeEditor } from '../../hooks/useCssCascadeEditor';
import { useTextEditing } from '../../hooks/useTextEditing';
import { useElementStructure } from '../../hooks/useElementStructure';
import { useElementSettings } from '../../hooks/useElementSettings';
import { useCssAnimations } from '../../hooks/useCssAnimations';
import { useCssVariables } from '../../hooks/useCssVariables';
import { useBreakpoints } from '../../hooks/useBreakpoints';
import {
  BASE_BREAKPOINT,
  type ElementSignature,
  isTailwindActive,
  projectUsesReact,
  type Breakpoint,
} from '../../lib/edit';
import { resolveEditorMode } from '../../lib/editorGate';
import { RendererPerformanceTracker } from '../../lib/components/renderer-performance';
import {
  RendererFrameLifecycle,
  rendererSnapshotCommitIsCurrent,
} from '../../lib/components/renderer-lifecycle';
import { captureRendererFrameSnapshot } from '../../lib/components/renderer-snapshot';
import {
  RendererSnapshotCache,
  type RendererStaticSnapshot,
} from '../../lib/components/renderer-snapshot-cache';
import {
  persistRendererSnapshot,
  readRendererSnapshots,
} from '../../lib/components/renderer-snapshot-storage';
import { componentSnapshotCacheKey } from '../../lib/components/renderer-scheduler';
import type { RendererFrameStatus } from '../../lib/components/renderer-lifecycle';
import { COMPONENT_RENDERER_ACCESSIBILITY_TIMEOUT_MS } from '../../lib/components/renderer-session';
import {
  CanvasSelectionOverlay,
  selectionBoundsForNodes,
  type CanvasResizeHandle,
} from './components-canvas/CanvasSelectionOverlay';
import { CanvasContextMenu } from './components-canvas/CanvasContextMenu';
import { ComponentsCanvas } from './components-canvas/ComponentsCanvas';
import { ComponentCanvasStage } from './components-canvas/ComponentCanvasStage';
import type { RendererStageEvent, RendererStageFrame } from '../../lib/components/renderer-stage';
import type { CanvasLayerDropIntent } from './components-canvas/CanvasLayersPanel';
import {
  canvasRectContains,
  normalizeCanvasRect,
  type CanvasMarquee,
} from './components-canvas/CanvasGestureController';
import { CanvasToolbar } from './components-canvas/CanvasToolbar';
import { CanvasGuidesOverlay } from './components-canvas/CanvasGuidesOverlay';
import { CanvasRulersOverlay } from './components-canvas/CanvasRulersOverlay';
import {
  preloadRendererStaticSnapshot,
  RendererStaticSnapshotView,
} from './RendererStaticSnapshot';
import { ComponentEditPanel } from './components-inspector/ComponentEditPanel';
import { StyleTab } from './components-inspector/StyleTab';
import { ElementToolbar } from '../edit/ElementToolbar';
import { mapSelectionRectToComponentsViewport } from './components-inspector/component-frame-toolbar-geometry';
import type { TreeStructureActions } from '../edit/ElementTreePanel';
import type { ElementsPanelCanvasLayers } from './components-inspector/ElementsPanel';
import { isSourceRefInside, sourceRefFromResolution } from '../../lib/components/focus';
import { presentedComponentName } from '../../lib/components/component-name';

interface ComponentsWorkspaceProps {
  projectPath: string;
  projectType: ProjectType;
  devServerPort: number;
  navigation: ComponentsNavigation;
  onNavigate: (navigation: ComponentsNavigation) => void;
  onOpenSource: (source: SourceRef) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void | Promise<void>;
  onRedo: () => void | Promise<void>;
  /** Space occupied by persistent Preview panels while this workspace is active. */
  panelInsets?: { left: number; right: number };
  /** Publishes the selected live frame's negotiated inspection target. */
  onRendererTargetChange?: (target: EditableSurfaceTarget | null) => void;
  /** Publishes the selected frame iframe for the workspace Elements owner. */
  onRendererFrameElementChange?: (element: HTMLIFrameElement | null) => void;
  /** Selection sent by the shared Elements tree; read-only until Edit main. */
  elementTreeSelection?: ElementTreeSelection | null;
  /** True only after the shared tree transport accepts a current-surface response. */
  componentInspectionReady?: boolean;
  /** Publishes the selected frame's structure actions to the singleton Elements panel. */
  onTreeStructureActionsChange?: (actions: TreeStructureActions | null) => void;
  /** Publishes the canvas component list to the singleton Elements panel. */
  onCanvasLayersChange?: (layers: ElementsPanelCanvasLayers | null) => void;
  /** Publishes the component edit panel to the workspace's shared edit dock. */
  onEditPanelChange?: (panel: ComponentEditPanelRenderer | null) => void;
  /** Shared Preview/Components visual-editor state. */
  visualEditorActive?: boolean;
  /** Updates the shared Preview/Components visual-editor state. */
  onVisualEditorActiveChange?: (active: boolean) => void;
}

export interface ComponentEditPanelHostProps {
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}

export type ComponentEditPanelRenderer = (props: ComponentEditPanelHostProps) => ReactNode;

function defaultNode(
  component: ComponentDescriptor,
  scope: CanvasScope,
  index: number,
  frameSize?: { width: number; height: number; sizeMode: 'fixed' }
): ComponentCanvasNode {
  return {
    id: componentCanvasNodeId(component.id, null, scope),
    scope,
    componentId: component.id,
    presetId: null,
    x: 0,
    y: 0,
    width: frameSize?.width ?? 320,
    height: frameSize?.height ?? 480,
    order: index,
    collapsed: false,
    generated: true,
    ...(frameSize ? { sizeMode: frameSize.sizeMode } : {}),
    presentation: { background: 'surface', breakpoint: null, locale: null },
  };
}

function nodeForPreset(
  component: ComponentDescriptor,
  presetId: string,
  scope: CanvasScope,
  index: number,
  frameSize?: { width: number; height: number; sizeMode: 'fixed' }
): ComponentCanvasNode {
  return {
    ...defaultNode(component, scope, index, frameSize),
    id: componentCanvasNodeId(component.id, presetId, scope),
    presetId,
    generated: false,
  };
}

function sharedCanvasFrameSize(
  nodes: readonly ComponentCanvasNode[],
  componentId: string
): { width: number; height: number; sizeMode: 'fixed' } | undefined {
  const fixedNode = nodes.find(
    (node) => node.componentId === componentId && node.sizeMode === 'fixed'
  );
  return fixedNode
    ? { width: fixedNode.width, height: fixedNode.height, sizeMode: 'fixed' }
    : undefined;
}

export function syncComponentCanvasFrameSize(
  nodes: readonly ComponentCanvasNode[],
  componentId: string,
  width: number,
  height: number
): ComponentCanvasNode[] {
  return nodes.map((node) =>
    node.componentId === componentId ? { ...node, width, height, sizeMode: 'fixed' as const } : node
  );
}

export function boundsForNodes(nodes: readonly ComponentCanvasNode[]): CameraBounds {
  if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const bounds = nodes.map((node) =>
    rotatedRectBounds(
      { x: node.x, y: node.y, width: node.width, height: node.height },
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      nodeRotation(node)
    )
  );
  const left = Math.min(...bounds.map((rect) => rect.x));
  const top = Math.min(...bounds.map((rect) => rect.y));
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function createCanvasLoadGuard(projectPath: string) {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    accepts(currentProjectPath: string) {
      return !cancelled && currentProjectPath === projectPath;
    },
  };
}

/**
 * A canvas is interactive only after the document for the currently selected
 * project has been accepted by the identity guard. Keeping this gate separate
 * from React state lets stale event/animation callbacks fail closed during the
 * render immediately following a project switch.
 */
export function createCanvasHydrationGate(projectPath: string | null = null) {
  let activeProjectPath = projectPath;
  let state: 'loading' | 'ready' | 'unreadable' = 'loading';

  return {
    begin(nextProjectPath: string) {
      activeProjectPath = nextProjectPath;
      state = 'loading';
    },
    resolve(nextProjectPath: string, readable = true) {
      if (nextProjectPath !== activeProjectPath) return false;
      state = readable ? 'ready' : 'unreadable';
      return true;
    },
    canInteract(nextProjectPath: string) {
      return state === 'ready' && nextProjectPath === activeProjectPath;
    },
    get state() {
      return state;
    },
  };
}

export function createRendererOperationGuard(
  projectPath: string,
  operationVersion: number,
  getCurrent: () => { projectPath: string; operationVersion: number }
) {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    isCurrent() {
      const current = getCurrent();
      return (
        !cancelled &&
        current.projectPath === projectPath &&
        current.operationVersion === operationVersion
      );
    },
  };
}

/**
 * A measurement may arrive after the first auto-layout pass. Reflow only when
 * every node still matches that canonical layout; a hand-positioned canvas is
 * user-authored and must never jump just because another frame measured itself.
 */
function isCanonicalCanvasLayout(nodes: readonly ComponentCanvasNode[]): boolean {
  const canonical = new Map(autoLayoutCanvasNodes(nodes).map((node) => [node.id, node]));
  return nodes.every((node) => {
    const expected = canonical.get(node.id);
    return expected?.x === node.x && expected?.y === node.y;
  });
}

function nearestCanvasFrameHeight(value: number): CanvasFrameHeight {
  const heights: CanvasFrameHeight[] = [240, 360, 480, 640, 800];
  return heights.reduce((nearest, height) =>
    Math.abs(height - value) < Math.abs(nearest - value) ? height : nearest
  );
}

const COMPONENT_PROP_PREVIEW_DEBOUNCE_MS = 180;
// Keep the canvas card usable while allowing the project root to determine its
// rendered bounds. The header is outside the iframe, so its height is added to
// the renderer's intrinsic content height before it becomes the node height.
const COMPONENT_CANVAS_MIN_WIDTH = 240;
const COMPONENT_CANVAS_MAX_WIDTH = 960;

type RendererSnapshotJob = {
  nodeId: string;
  snapshotKey: string;
  rendererReloadKey: string;
  retryNonce: number;
  captureEpoch: number;
  projectPath: string;
  rendererVersion: string;
};

/**
 * Persistence gate for the canvas document. Camera and renderer updates may
 * remain debounced, but a gesture owns an authoritative transaction: while it
 * is active no intermediate geometry is scheduled, and both commit and abort
 * write the settled document immediately.
 */
export function createCanvasPersistenceScheduler(delayMs = COMPONENT_PROP_PREVIEW_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let transactionActive = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const write = (document: CanvasDocumentV2, persist: (document: CanvasDocumentV2) => unknown) => {
    void Promise.resolve(persist(document));
  };

  return {
    beginTransaction() {
      transactionActive = true;
      cancel();
    },
    schedule(document: CanvasDocumentV2, persist: (document: CanvasDocumentV2) => unknown) {
      cancel();
      if (transactionActive) return;
      timer = setTimeout(() => {
        timer = null;
        write(document, persist);
      }, delayMs);
    },
    settle(document: CanvasDocumentV2, persist: (document: CanvasDocumentV2) => unknown) {
      transactionActive = false;
      cancel();
      write(document, persist);
    },
    cancel,
    get transactionActive() {
      return transactionActive;
    },
  };
}

/**
 * Interaction-only scene extensions. The persisted v2 document is still the
 * source of truth for known fields; rotation and hierarchy stay in this
 * compatibility adapter until the versioned scene envelope is adopted.
 */
type CanvasInteractionNode = ComponentCanvasNode & {
  parentId?: string | null;
  rotation?: number;
  name?: string;
  visible?: boolean;
  locked?: boolean;
};

function interactionNode(node: ComponentCanvasNode): CanvasInteractionNode {
  return node as CanvasInteractionNode;
}

function nodeRotation(node: ComponentCanvasNode): number {
  const value = interactionNode(node).rotation;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nodeParentId(node: ComponentCanvasNode): string | null {
  const value = interactionNode(node).parentId;
  return typeof value === 'string' ? value : null;
}

/** A locked ancestor makes the whole descendant subtree non-editable. */
export function isCanvasNodeEffectivelyLocked(
  nodeId: string,
  nodes: readonly ComponentCanvasNode[]
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current = byId.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (nodeLayerExtension(current).locked) return true;
    const parentId = nodeParentId(current);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return false;
}

/** A parent cannot move if that would also move a locked descendant. */
export function hasLockedCanvasDescendant(
  nodeId: string,
  nodes: readonly ComponentCanvasNode[]
): boolean {
  const children = new Map<string, ComponentCanvasNode[]>();
  nodes.forEach((node) => {
    const parentId = nodeParentId(node);
    if (!parentId) return;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  });
  const visited = new Set<string>();
  const visit = (parentId: string): boolean => {
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    return (children.get(parentId) ?? []).some(
      (child) => isCanvasNodeEffectivelyLocked(child.id, nodes) || visit(child.id)
    );
  };
  return visit(nodeId);
}

export function canMutateCanvasNode(
  nodeId: string,
  nodes: readonly ComponentCanvasNode[]
): boolean {
  return !isCanvasNodeEffectivelyLocked(nodeId, nodes) && !hasLockedCanvasDescendant(nodeId, nodes);
}

function nodeLayerExtension(node: ComponentCanvasNode): CanvasInteractionNode {
  return interactionNode(node);
}

function nodeIsVisible(node: ComponentCanvasNode): boolean {
  return nodeLayerExtension(node).visible !== false;
}

export interface CanvasSelectionMutationResult {
  nodes: ComponentCanvasNode[];
  affectedIds: string[];
  refused: boolean;
}

function stableDuplicateId(nodes: readonly ComponentCanvasNode[], sourceId: string): string {
  const existing = new Set(nodes.map((node) => node.id));
  const base = `${sourceId}-copy`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Duplicates the normalized selection with deterministic IDs and hierarchy. */
export function duplicateCanvasSelection(
  nodes: readonly ComponentCanvasNode[],
  selectedIds: readonly string[]
): CanvasSelectionMutationResult {
  const normalized = normalizeCanvasHierarchySelection(selectedIds, nodes).ids;
  const selected = new Set(normalized);
  const ordered = nodes
    .filter((node) => selected.has(node.id) && canMutateCanvasNode(node.id, nodes))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  let next = [...nodes];
  const duplicateIds = new Map<string, string>();
  let refused = false;
  for (const source of ordered) {
    const newId = stableDuplicateId(next, source.id);
    const result = duplicateCanvasNode(next, source.id, newId);
    if (result.refused) {
      refused = true;
      continue;
    }
    const duplicate = result.nodes.find((node) => node.id === newId);
    if (!duplicate) continue;
    duplicateIds.set(source.id, newId);
    const parentId = nodeParentId(source);
    const duplicateParentId = parentId ? duplicateIds.get(parentId) : undefined;
    next = result.nodes.map((node) =>
      node.id === newId
        ? {
            ...node,
            parentId: duplicateParentId ?? parentId,
            x: duplicateParentId ? source.x : duplicate.x,
            y: duplicateParentId ? source.y : duplicate.y,
          }
        : node
    );
  }
  return {
    nodes: next,
    affectedIds: ordered.map((node) => duplicateIds.get(node.id)).filter(Boolean) as string[],
    refused,
  };
}

/** Deletes normalized roots and their descendants without leaving orphans. */
export function deleteCanvasSelection(
  nodes: readonly ComponentCanvasNode[],
  selectedIds: readonly string[]
): CanvasSelectionMutationResult {
  const normalized = normalizeCanvasHierarchySelection(selectedIds, nodes).ids;
  const roots = new Set(normalized);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const deleted = new Set<string>();
  const isDescendantOfRoot = (node: ComponentCanvasNode): boolean => {
    let current: ComponentCanvasNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const parentId = nodeParentId(current);
      if (!parentId) return false;
      if (roots.has(parentId)) return true;
      current = byId.get(parentId);
    }
    return false;
  };
  let refused = false;
  const candidateIds = new Set(
    nodes.filter((node) => roots.has(node.id) || isDescendantOfRoot(node)).map((node) => node.id)
  );
  // Refuse a subtree delete when it would strand a locked descendant (or
  // remove a canonical generated node). This keeps the whole scene safe.
  if (
    nodes.some(
      (node) =>
        candidateIds.has(node.id) &&
        (!canMutateCanvasNode(node.id, nodes) || (node.scope === 'all' && node.presetId === null))
    )
  ) {
    return { nodes: [...nodes], affectedIds: [], refused: true };
  }
  for (const node of nodes) {
    if (!roots.has(node.id) && !isDescendantOfRoot(node)) continue;
    if (!canMutateCanvasNode(node.id, nodes) || (node.scope === 'all' && node.presetId === null)) {
      refused = true;
      continue;
    }
    deleted.add(node.id);
  }
  return {
    nodes: nodes.filter((node) => !deleted.has(node.id)),
    affectedIds: [...deleted],
    refused,
  };
}

/** Arranges only unlocked nodes while preserving locked nodes byte-for-byte. */
export function arrangeUnlockedCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  selectedIds?: readonly string[]
): ComponentCanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = nodes.filter((node) => {
    const parentId = nodeParentId(node);
    return !parentId || !byId.has(parentId);
  });
  const normalizedSelection = selectedIds?.length
    ? normalizeCanvasHierarchySelection(selectedIds, nodes).ids
    : undefined;
  const targets = normalizedSelection ?? roots.map((node) => node.id);
  const movable = nodes.filter(
    (node) => targets.includes(node.id) && canMutateCanvasNode(node.id, nodes)
  );
  const selected = normalizedSelection
    ? normalizedSelection.filter((id) => movable.some((node) => node.id === id))
    : undefined;
  const arrangedById = new Map<string, ComponentCanvasNode>();
  for (const scope of CANVAS_SCOPE_ORDER) {
    const scopedMovable = movable.filter((node) => node.scope === scope);
    if (scopedMovable.length === 0) continue;
    const scopedIds = new Set(scopedMovable.map((node) => node.id));
    const scopedSelection = selected?.filter((id) => scopedIds.has(id));
    if (selected && scopedSelection?.length === 0) continue;
    const arranged = arrangeCanvasNodes(scopedMovable, scopedSelection);
    for (const node of arranged) arrangedById.set(node.id, node);
  }
  return nodes.map((node) => arrangedById.get(node.id) ?? node);
}

/**
 * Returns the deterministic paint order for the canvas world. Persisted order
 * is the sibling z-order; descendants paint after their parent. Reversing this
 * list produces the layer tree's topmost-first order.
 */
export function orderCanvasNodesForPaint(
  nodes: readonly ComponentCanvasNode[]
): ComponentCanvasNode[] {
  const byParent = new Map<string | null, ComponentCanvasNode[]>();
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parentId = nodeParentId(node);
    const parent = parentId && ids.has(parentId) ? parentId : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(node);
    byParent.set(parent, siblings);
  }
  const result: ComponentCanvasNode[] = [];
  const visited = new Set<string>();
  const sortSiblings = (siblings: readonly ComponentCanvasNode[]) =>
    [...siblings].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id)
    );
  const visit = (parentId: string | null) => {
    for (const node of sortSiblings(byParent.get(parentId) ?? [])) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      result.push(node);
      visit(node.id);
    }
  };
  visit(null);
  // Malformed cycles are already sanitized at persistence time, but keep the
  // renderer deterministic if an in-memory extension is edited concurrently.
  for (const node of sortSiblings(nodes.filter((candidate) => !visited.has(candidate.id)))) {
    visited.add(node.id);
    result.push(node);
    visit(node.id);
  }
  return result;
}

/** Screen-space HUD controls must not be interpreted as canvas gestures. */
export function isCanvasScreenOverlayTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('.components-workspace__screen-overlay') !== null
  );
}

export function canvasNodeStackingIndex(
  nodeId: string,
  nodes: readonly ComponentCanvasNode[]
): number {
  const index = orderCanvasNodesForPaint(nodes).findIndex((node) => node.id === nodeId);
  return index < 0 ? 0 : index + 1;
}

export function nudgeCanvasSelection(
  nodes: readonly ComponentCanvasNode[],
  selectedIds: readonly string[],
  dx: number,
  dy: number,
  amount: number
): ComponentCanvasNode[] {
  const roots = new Set(normalizeCanvasHierarchySelection(selectedIds, nodes).ids);
  return nodes.map((node) => {
    if (!roots.has(node.id) || !canMutateCanvasNode(node.id, nodes)) return node;
    const world = canvasNodeWorldPosition(node.id, nodes);
    return {
      ...node,
      ...canvasWorldToLocalPosition(
        node.id,
        { x: world.x + dx * amount, y: world.y + dy * amount },
        nodes
      ),
    };
  });
}

/**
 * Rebase non-undoable document fields onto existing scene-history entries.
 * Camera persistence and renderer measurements are authoritative state, but
 * they must not make a later undo restore stale camera or measured geometry.
 */
export function rebaseCanvasTransientFields(
  base: CanvasDocumentV2,
  previous: CanvasDocumentV2,
  next: CanvasDocumentV2
): CanvasDocumentV2 {
  let result = base;
  const scopes = (['focus', 'variants', 'all'] as const).filter(
    (scope) => previous.scopes[scope].camera !== next.scopes[scope].camera
  );
  if (scopes.length > 0) {
    result = {
      ...result,
      scopes: {
        ...result.scopes,
        ...Object.fromEntries(
          scopes.map((scope) => [
            scope,
            { ...result.scopes[scope], camera: next.scopes[scope].camera },
          ])
        ),
      },
    } as CanvasDocumentV2;
  }

  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const transientGeometryChanged = (node: ComponentCanvasNode) => {
    const previousNode = previousNodes.get(node.id);
    return (
      previousNode !== undefined &&
      (previousNode.x !== node.x ||
        previousNode.y !== node.y ||
        previousNode.width !== node.width ||
        previousNode.height !== node.height ||
        previousNode.order !== node.order)
    );
  };
  const addedNodes = next.nodes.filter((node) => !previousNodes.has(node.id));
  const rebasedNodes = result.nodes.map((node) => {
    const nextNode = nextNodes.get(node.id);
    const previousNode = nextNode ? previousNodes.get(nextNode.id) : undefined;
    if (!nextNode || !previousNode || !transientGeometryChanged(nextNode)) return node;
    return {
      ...node,
      ...(previousNode.x !== nextNode.x ? { x: nextNode.x } : {}),
      ...(previousNode.y !== nextNode.y ? { y: nextNode.y } : {}),
      ...(previousNode.width !== nextNode.width ? { width: nextNode.width } : {}),
      ...(previousNode.height !== nextNode.height ? { height: nextNode.height } : {}),
      ...(previousNode.order !== nextNode.order ? { order: nextNode.order } : {}),
    };
  });
  if (addedNodes.length > 0) {
    const existingIds = new Set(rebasedNodes.map((node) => node.id));
    rebasedNodes.push(...addedNodes.filter((node) => !existingIds.has(node.id)));
  }
  if (
    rebasedNodes.length !== result.nodes.length ||
    rebasedNodes.some((node, index) => node !== result.nodes[index])
  ) {
    result = { ...result, nodes: rebasedNodes };
  }
  return result;
}

export function reorderCanvasLayerNodes(
  nodes: readonly ComponentCanvasNode[],
  intent: CanvasLayerDropIntent
): { nodes: ComponentCanvasNode[]; accepted: boolean } {
  if (intent.draggedId === intent.targetId) return { nodes: [...nodes], accepted: false };
  const target = nodes.find((node) => node.id === intent.targetId);
  if (!target) return { nodes: [...nodes], accepted: false };
  if (!canMutateCanvasNode(intent.draggedId, nodes) || !canMutateCanvasNode(target.id, nodes)) {
    return { nodes: [...nodes], accepted: false };
  }
  const nextParentId = intent.position === 'into' ? target.id : nodeParentId(target);
  const reparented = reparentCanvasNodes(
    nodes as readonly (ComponentCanvasNode & Record<string, unknown>)[],
    [intent.draggedId],
    nextParentId
  );
  if (!reparented.accepted) return { nodes: [...nodes], accepted: false };
  const targetOrder = intent.position === 'into' ? target.order + 1 : target.order;
  const positioned = (reparented.nodes as ComponentCanvasNode[]).map((node) =>
    node.id === intent.draggedId
      ? { ...node, order: targetOrder + (intent.position === 'before' ? -0.5 : 0.5) }
      : node
  );
  const groups = new Map<string | null, ComponentCanvasNode[]>();
  positioned.forEach((node) => {
    const siblings = groups.get(nodeParentId(node)) ?? [];
    siblings.push(node);
    groups.set(nodeParentId(node), siblings);
  });
  const normalized = new Map<string, ComponentCanvasNode>();
  groups.forEach((siblings) => {
    const sorted = siblings.sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id)
    );
    const lockedOrders = new Set(
      sorted.filter((node) => !canMutateCanvasNode(node.id, positioned)).map((node) => node.order)
    );
    let nextOrder = 0;
    sorted.forEach((node) => {
      if (!canMutateCanvasNode(node.id, positioned)) {
        normalized.set(node.id, node);
        return;
      }
      while (lockedOrders.has(nextOrder)) nextOrder += 1;
      normalized.set(node.id, { ...node, order: nextOrder });
      nextOrder += 1;
    });
  });
  return { nodes: positioned.map((node) => normalized.get(node.id) ?? node), accepted: true };
}

/**
 * Reorders only movable nodes into the existing movable order slots. Locked
 * nodes therefore keep their exact `order` values (and their relative slots)
 * even when a movable node crosses one of them.
 */
export function reorderCanvasZOrder(
  nodes: readonly ComponentCanvasNode[],
  selectedIds: readonly string[],
  direction: -1 | 1,
  toEdge = false
): ComponentCanvasNode[] {
  const ordered = [...nodes].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id)
  );
  const movable = ordered.filter((node) => canMutateCanvasNode(node.id, nodes));
  const movableSelected = new Set(
    movable.filter((node) => selectedIds.includes(node.id)).map((node) => node.id)
  );
  if (movableSelected.size === 0) return [...nodes];

  const reordered = [...movable];
  if (toEdge) {
    const selected = reordered.filter((node) => movableSelected.has(node.id));
    const remaining = reordered.filter((node) => !movableSelected.has(node.id));
    reordered.splice(
      0,
      reordered.length,
      ...(direction > 0 ? [...remaining, ...selected] : [...selected, ...remaining])
    );
  } else if (direction > 0) {
    for (let index = reordered.length - 2; index >= 0; index -= 1) {
      if (
        movableSelected.has(reordered[index].id) &&
        !movableSelected.has(reordered[index + 1].id)
      ) {
        [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
      }
    }
  } else {
    for (let index = 1; index < reordered.length; index += 1) {
      if (
        movableSelected.has(reordered[index].id) &&
        !movableSelected.has(reordered[index - 1].id)
      ) {
        [reordered[index], reordered[index - 1]] = [reordered[index - 1], reordered[index]];
      }
    }
  }

  const movableOrderSlots = movable.map((node) => node.order);
  let movableIndex = 0;
  return ordered.map((node) => {
    if (!canMutateCanvasNode(node.id, nodes)) return node;
    const replacement = reordered[movableIndex];
    const order = movableOrderSlots[movableIndex];
    movableIndex += 1;
    return replacement ? { ...replacement, order } : node;
  });
}

function rendererFramePublishKey(frame: RendererFramePayload, retryNonce: number): string {
  return JSON.stringify({ frame, retryNonce });
}

/**
 * Loading belongs to a renderer content/retry transition, not to a
 * measurement-only frame republish. RendererFrameHost uses the same content
 * identity, so a width/height update can be published without dropping a
 * completed handshake.
 */
export function shouldResetRendererFrameState(
  previousContentKey: string | undefined,
  previousRetryNonce: number | undefined,
  frame: RendererFramePayload,
  retryNonce: number
): boolean {
  return (
    previousContentKey === undefined ||
    previousContentKey !== rendererFrameReloadKey(frame) ||
    previousRetryNonce !== retryNonce
  );
}

/**
 * A renderer can prove inspection readiness through either its host lifecycle
 * event or an authenticated current-surface tree/selection response. The
 * surface identity check is mandatory in both cases; the verified tree signal
 * only recovers a missed host-ready event and never grants source authority.
 */
export function rendererInspectionIsReady(
  frameState: 'idle' | 'loading' | 'ready' | 'error',
  surfaceMatchesSelectedFrame: boolean,
  verifiedInspectionReady: boolean
): boolean {
  return (
    surfaceMatchesSelectedFrame &&
    (frameState === 'ready' || (frameState !== 'error' && verifiedInspectionReady))
  );
}

export function rendererFrameSnapshotKey(
  frame: RendererFramePayload,
  _rendererVersion?: string
): string {
  return componentSnapshotCacheKey({
    componentRevision: frame.componentRevision,
    presetFingerprint: JSON.stringify({
      componentId: frame.componentId,
      props: frame.props,
      slots: frame.slots,
      widthMode: frame.presentation.widthMode,
    }),
    width: frame.presentation.width,
    height: frame.presentation.height,
    background: frame.presentation.background,
    breakpoint: frame.presentation.breakpoint,
    locale: frame.presentation.locale,
    // Snapshot files are project data, so their identity must survive the
    // short-lived renderer session and its generated route segment.
    // Change the snapshot schema whenever parent-window capture composition
    // changes, so posters polluted by old canvas chrome are never reused.
    rendererVersion: `${COMPONENT_RENDERER_INTEGRATION_VERSION}:capture-v2`,
  });
}

export function hasUsableRendererSnapshotBounds(frame: HTMLIFrameElement): boolean {
  if (!frame.isConnected) return false;
  const frameRect = frame.getBoundingClientRect();
  if (
    !Number.isFinite(frameRect.width) ||
    !Number.isFinite(frameRect.height) ||
    frameRect.width <= 0 ||
    frameRect.height <= 0
  ) {
    return false;
  }
  const viewport = frame.closest<HTMLElement>('.components-workspace__viewport');
  if (!viewport) return true;
  const viewportRect = viewport.getBoundingClientRect();
  // A crop of a partially visible frame would be a misleading poster. Wait
  // for the complete frame to enter the viewport; this also keeps a deferred
  // offscreen card eligible when the user pans to it later.
  const tolerance = 1;
  return (
    frameRect.left >= viewportRect.left - tolerance &&
    frameRect.top >= viewportRect.top - tolerance &&
    frameRect.right <= viewportRect.right + tolerance &&
    frameRect.bottom <= viewportRect.bottom + tolerance
  );
}

export function CanvasNodeView({
  node,
  component,
  readiness,
  selected,
  stackingIndex,
  liveFrame,
  staticSnapshot,
  rendererStatus,
  zoom = 1,
  onSelect,
}: {
  node: ComponentCanvasNode;
  component: ComponentDescriptor;
  readiness: RendererReadiness;
  selected: boolean;
  stackingIndex?: number;
  liveFrame?: ReactNode;
  staticSnapshot?: RendererStaticSnapshot;
  rendererStatus?: RendererFrameStatus | null;
  zoom?: number;
  onSelect: (
    id: string,
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>
  ) => void;
}) {
  const rotation = nodeRotation(node);
  const canvasZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const contentScaleStyle = {
    width: '100%',
    height: '100%',
  } as CSSProperties;
  // A queued frame has mounted eagerly, but it is not paint-ready until the
  // authenticated rendered-dimensions event marks it live. Keep the exact
  // cached image over that frame for the whole handshake so promotion is one
  // atomic paint instead of a snapshot -> blank iframe -> live frame sequence.
  const liveFrameNeedsPaint = Boolean(liveFrame && rendererStatus !== 'live');
  const showSnapshot = Boolean(staticSnapshot && (!liveFrame || liveFrameNeedsPaint));
  const showRendererFallback =
    !liveFrame ||
    rendererStatus === 'error' ||
    rendererStatus === 'placeholder' ||
    rendererStatus === 'suspended' ||
    rendererStatus === 'cached';
  const snapshotStatus =
    selected && staticSnapshot && showSnapshot
      ? rendererStatus === 'error'
        ? 'error'
        : rendererStatus === 'cached' || rendererStatus === 'suspended'
          ? 'paused'
          : liveFrameNeedsPaint ||
              rendererStatus === 'queued' ||
              rendererStatus === 'placeholder' ||
              rendererStatus === 'live'
            ? 'pending'
            : readiness.live
              ? 'pending'
              : null
      : null;
  return (
    <article
      className={`component-canvas-node${selected ? ' component-canvas-node--selected' : ''}`}
      style={{
        left: node.x * canvasZoom,
        top: node.y * canvasZoom,
        width: node.width * canvasZoom,
        height: node.height * canvasZoom,
        zIndex: stackingIndex ?? node.order,
        transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
      }}
      data-testid={`component-canvas-node-${node.id}`}
      data-component-canvas-node="true"
      data-canvas-node-id={node.id}
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${component.name}, ${node.generated ? 'generated default' : 'saved preset'}${selected ? ', selected' : ''}`}
      onClick={(event) => onSelect(node.id, event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id, event);
        }
      }}
    >
      <div className="component-canvas-node__content">
        <div className="component-canvas-node__content-scale" style={contentScaleStyle}>
          {liveFrame && (
            <div
              className={`component-canvas-node__live-frame${liveFrameNeedsPaint ? ' component-canvas-node__live-frame--pending' : ''}`}
              aria-hidden={liveFrameNeedsPaint}
            >
              {liveFrame}
            </div>
          )}
          {staticSnapshot && showSnapshot ? (
            <div
              className={`component-canvas-node__snapshot-poster${snapshotStatus ? ` component-canvas-node__snapshot-poster--${snapshotStatus}` : ''}`}
            >
              <RendererStaticSnapshotView
                componentName={component.name}
                snapshot={staticSnapshot}
              />
              {snapshotStatus && (
                <div
                  className={`component-canvas-node__snapshot-status component-canvas-node__snapshot-status--${snapshotStatus}`}
                  data-testid="component-canvas-live-status"
                  role="status"
                  aria-live="polite"
                  aria-busy={snapshotStatus === 'pending'}
                >
                  {snapshotStatus === 'pending' ? (
                    <PixelLoader size="lg" label={`Loading ${component.name}`} />
                  ) : (
                    <InfoIcon size={24} aria-hidden="true" />
                  )}
                  <strong>
                    {snapshotStatus === 'pending'
                      ? 'Loading live preview…'
                      : snapshotStatus === 'paused'
                        ? 'Live preview paused'
                        : 'Live preview unavailable'}
                  </strong>
                  <span>
                    {snapshotStatus === 'pending'
                      ? 'Using the snapshot until the live component is ready.'
                      : 'The saved snapshot is shown instead.'}
                  </span>
                </div>
              )}
            </div>
          ) : showRendererFallback ? (
            <div
              className={`component-canvas-node__body${
                liveFrame ? ' component-canvas-node__body--pending' : ''
              }`}
            >
              <InfoIcon size={18} aria-hidden="true" />
              <strong>
                {rendererStatus === 'error'
                  ? 'Preview unavailable'
                  : rendererStatus === 'queued'
                    ? 'Rendering preview…'
                    : rendererStatus === 'suspended' || rendererStatus === 'cached'
                      ? 'Preview paused'
                      : readiness.adapter === 'vite'
                        ? 'Catalog entry'
                        : readiness.label}
              </strong>
              <span>
                {rendererStatus === 'error'
                  ? 'Ship Studio could not render this component.'
                  : rendererStatus === 'queued'
                    ? 'Loading this component in the background.'
                    : rendererStatus === 'suspended' || rendererStatus === 'cached'
                      ? 'A static snapshot is not available for these render inputs yet.'
                      : readiness.adapter === 'vite'
                        ? 'Live preview is unavailable for this Vite project.'
                        : readiness.reason}
              </span>
            </div>
          ) : null}
          {liveFrameNeedsPaint && !showSnapshot && !showRendererFallback && (
            <div className="component-canvas-node__loading-overlay">
              <PixelLoader size="lg" label={`Loading ${component.name}`} />
              <strong>Rendering preview…</strong>
              <span>Loading this component in the background.</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function ComponentsWorkspace({
  projectPath,
  projectType,
  devServerPort,
  navigation,
  onNavigate,
  onOpenSource,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  panelInsets = { left: 0, right: 0 },
  onRendererTargetChange,
  onRendererFrameElementChange,
  elementTreeSelection = null,
  componentInspectionReady = false,
  onTreeStructureActionsChange,
  onCanvasLayersChange,
  onEditPanelChange,
  visualEditorActive,
  onVisualEditorActiveChange,
}: ComponentsWorkspaceProps) {
  const { showToast } = useOptionalToast();
  const onToast = useCallback(
    (message: string, type?: 'success' | 'error' | 'info') => showToast(message, type),
    [showToast]
  );
  const { index, error, refresh } = useComponentCatalog({
    projectPath,
    projectType,
    enabled: true,
  });
  const [selectedComponentId, setSelectedComponentId] = useState<ComponentId | null>(
    navigation.componentId ?? null
  );
  const [document, setDocument] = useState<CanvasDocumentV2>(
    () => createEmptyCanvasDocument() as CanvasDocumentV2
  );
  const documentRef = useRef(document);
  documentRef.current = document;
  const canvasHistoryRef = useRef(new CanvasHistory<CanvasDocumentV2>(document));
  const canvasHydrationGateRef = useRef(createCanvasHydrationGate(projectPath));
  const canvasMutationProjectPathRef = useRef<string | null>(projectPath);
  const canvasMutationEnabledRef = useRef(false);
  const publishCanvasDocument = useCallback(
    (
      next: CanvasDocumentV2,
      mode: 'transient' | 'history' | 'reset' | 'current' = 'transient',
      label = 'Update canvas document'
    ) => {
      const previous = documentRef.current;
      if (next === previous) return previous;
      if (
        mode !== 'reset' &&
        (!canvasMutationEnabledRef.current ||
          !canvasHydrationGateRef.current.canInteract(currentProjectPathRef.current))
      ) {
        return previous;
      }
      if (mode === 'history') {
        canvasHistoryRef.current.record(label, previous, next);
      } else if (mode === 'reset') {
        canvasHistoryRef.current.clear();
        canvasHistoryRef.current.replaceCurrent(next);
      } else if (mode === 'current') {
        canvasHistoryRef.current.replaceCurrent(next);
      } else {
        canvasHistoryRef.current.replaceCurrent(
          next,
          (entry: CanvasHistoryEntry<CanvasDocumentV2>) => ({
            ...entry,
            before: rebaseCanvasTransientFields(entry.before, previous, next),
            after: rebaseCanvasTransientFields(entry.after, previous, next),
          })
        );
      }
      documentRef.current = next;
      setDocument(next);
      return next;
    },
    []
  );
  const activeCanvasTransactionRef = useRef<CanvasHistoryTransaction<CanvasDocumentV2> | null>(
    null
  );
  const activeCanvasTransactionProjectPathRef = useRef<string | null>(null);
  const [scope, setScope] = useState<CanvasScope>(navigation.scope);
  const [hydrated, setHydrated] = useState(false);
  const currentProjectPathRef = useRef(projectPath);
  currentProjectPathRef.current = projectPath;
  const hydratedProjectPathRef = useRef<string | null>(null);
  const [unreadableCanvasPayload, setUnreadableCanvasPayload] = useState<unknown>(undefined);
  const canvasIdentityReady =
    hydrated &&
    hydratedProjectPathRef.current === projectPath &&
    canvasHydrationGateRef.current.state !== 'loading';
  const canvasInteractive =
    canvasIdentityReady &&
    unreadableCanvasPayload === undefined &&
    canvasHydrationGateRef.current.canInteract(projectPath) &&
    canvasMutationEnabledRef.current;
  const canvasReadOnly = canvasIdentityReady && !canvasInteractive;
  const canInteractWithCanvas = useCallback(
    () =>
      canvasMutationEnabledRef.current &&
      canvasHydrationGateRef.current.canInteract(currentProjectPathRef.current),
    []
  );
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(
    () => navigation.selectedNodeIds ?? []
  );
  const [contextNodeId, setContextNodeId] = useState<string | null>(null);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [rulersVisible, setRulersVisible] = useState(true);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [componentEditTab, setComponentEditTab] = useState('component');
  const [editMainConfirmOpen, setEditMainConfirmOpen] = useState(false);
  const [editMainConfirmed, setEditMainConfirmed] = useState(false);
  const [rendererBreakpointOverride, setRendererBreakpointOverride] = useState<string | null>(null);
  const [generatedVariants, setGeneratedVariants] = useState<
    Record<string, GeneratedCanvasVariant[]>
  >({});
  const [variantNotice, setVariantNotice] = useState<string | null>(null);
  const [rendererSessionId, setRendererSessionId] = useState<string | null>(null);
  const [rendererSessionState, setRendererSessionState] = useState<
    'not-started' | 'starting' | 'live' | 'stopping' | 'stopped'
  >('not-started');
  const [rendererSession, setRendererSession] = useState<RendererSessionDescriptor | null>(null);
  const [rendererRouteSegment, setRendererRouteSegment] = useState<string | null>(null);
  const [rendererFrameState, setRendererFrameState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [rendererFrameError, setRendererFrameError] = useState<string | null>(null);
  const [rendererRetryNonce, setRendererRetryNonce] = useState(0);
  const [rendererCircuitOpen, setRendererCircuitOpen] = useState(false);
  const [liveRendererNodeIds, setLiveRendererNodeIds] = useState<string[]>([]);
  const [rendererAccessVersion, setRendererAccessVersion] = useState(0);
  const [rendererSnapshotVersion, setRendererSnapshotVersion] = useState(0);
  const [rendererSurfaceTarget, setRendererSurfaceTarget] = useState<EditableSurfaceTarget | null>(
    null
  );
  const [rendererFrameElement, setRendererFrameElement] = useState<HTMLIFrameElement | null>(null);
  const rendererIframeRef = useRef<HTMLIFrameElement | null>(null);
  const selectedRendererFrameIdRef = useRef<string | null>(null);
  const [rendererElementSelection, setRendererElementSelection] = useState<{
    signature: ElementSignature;
    sourceRange: RendererFrameEditContext['descendant'] | null;
  } | null>(null);
  const [rendererSnapshotPath, setRendererSnapshotPath] = useState<string | null>(null);
  const [rendererSnapshotError, setRendererSnapshotError] = useState<string | null>(null);
  const [rendererSnapshotState, setRendererSnapshotState] = useState<
    'idle' | 'capturing' | 'ready'
  >('idle');
  const [rendererA11yFindings, setRendererA11yFindings] = useState<RendererA11yFinding[]>([]);
  const [rendererA11yState, setRendererA11yState] = useState<'idle' | 'running' | 'ready'>('idle');
  const [rendererA11yError, setRendererA11yError] = useState<string | null>(null);
  const [rendererEditContext, setRendererEditContext] = useState<RendererFrameEditContext | null>(
    null
  );
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupPhase, setSetupPhase] = useState<
    'review' | 'preparing' | 'host-ready' | 'installing' | 'ready'
  >('review');
  const [setupPlan, setSetupPlan] = useState<NextRendererHostPlan | null>(null);
  const [setupSession, setSetupSession] = useState<ComponentRendererSession | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [rendererConsent, setRendererConsent] = useState<{
    integrationVersion: string;
    approvedAt: number;
  } | null>(null);
  const [rendererConsentProjectPath, setRendererConsentProjectPath] = useState<string | null>(null);
  const rendererConsentLoaded = rendererConsentProjectPath === projectPath;
  const [rendererPreflight, setRendererPreflight] = useState<{
    status: 'idle' | 'checking' | 'ready' | 'blocked';
    message?: string;
  }>({ status: 'idle' });
  const autoSetupAttemptRef = useRef<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const [marquee, setMarquee] = useState<CanvasMarquee | null>(null);
  const [snapGuides, setSnapGuides] = useState<CanvasGuide[]>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contextMenuFocusRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    nodeIds: string[];
    start: { x: number; y: number };
    origin: Record<string, { x: number; y: number }>;
    moved: boolean;
    additive: boolean;
  } | null>(null);
  const pendingCameraRef = useRef<CanvasCameraState | null>(null);
  const cameraFrameRef = useRef<number | null>(null);
  const cameraAnimationCancelRef = useRef<(() => void) | null>(null);
  const canvasPointerCaptureRef = useRef<{
    element: HTMLElement;
    pointerId: number;
  } | null>(null);
  const cameraPanCleanupRef = useRef<(() => void) | null>(null);
  const spaceHeldRef = useRef(false);
  const [spacePanHeld, setSpacePanHeld] = useState(false);
  const [cameraPanActive, setCameraPanActive] = useState(false);

  useEffect(() => {
    const clearSpacePan = () => {
      cameraPanCleanupRef.current?.();
      spaceHeldRef.current = false;
      setSpacePanHeld(false);
      setCameraPanActive(false);
    };
    window.addEventListener('blur', clearSpacePan);
    return () => window.removeEventListener('blur', clearSpacePan);
  }, []);

  const resizeRef = useRef<{
    nodeId: string;
    handle: CanvasResizeHandle;
    start: { x: number; y: number };
    origin: ComponentCanvasNode;
    moved: boolean;
  } | null>(null);
  const rotationRef = useRef<{
    nodeId: string;
    center: { x: number; y: number };
    startAngle: number;
    origin: number;
    moved: boolean;
  } | null>(null);
  const suppressNodeClickRef = useRef(false);
  const focusedCameraKeyRef = useRef<string | null>(null);
  const previousNavigationRef = useRef<ComponentsNavigation | null>(null);
  const rendererPerformanceRef = useRef(new RendererPerformanceTracker());
  const rendererLifecycleRef = useRef(
    new RendererFrameLifecycle({
      liveLimit: COMPONENT_CANVAS_MAX_LIVE_FRAMES,
      retainLiveFrames: true,
    })
  );
  const rendererA11yRequestIdRef = useRef<string | null>(null);
  const rendererA11yTimeoutRef = useRef<number | null>(null);
  const rendererPublishedFrameKeysRef = useRef(new Map<string, string>());
  const rendererPublishedFrameReloadKeysRef = useRef(new Map<string, string>());
  const rendererPublishedFrameRetryNoncesRef = useRef(new Map<string, number>());
  const rendererLastAccessedAtRef = useRef(new Map<string, number>());
  const rendererAccessSequenceRef = useRef(0);
  const rendererSnapshotCacheRef = useRef(new RendererSnapshotCache());
  const rendererSnapshotPendingRef = useRef(new Map<string, RendererSnapshotJob>());
  const rendererSnapshotFailedRef = useRef(new Map<string, string>());
  const rendererSnapshotDeferredRef = useRef(new Map<string, string>());
  const rendererSnapshotQueueRef = useRef<RendererSnapshotJob[]>([]);
  const rendererSnapshotCaptureRunningRef = useRef(false);
  const rendererFrameElementsRef = useRef(new Map<string, HTMLIFrameElement>());
  const rendererFramesRef = useRef(new Map<string, RendererFramePayload>());
  const rendererSnapshotProjectPathRef = useRef(projectPath);
  const rendererSnapshotEpochRef = useRef(0);
  const rendererSessionIdRef = useRef<string | null>(null);
  const rendererSessionProjectPathRef = useRef(projectPath);
  const rendererOperationVersionRef = useRef(0);
  const markRendererNodeAccessed = useCallback((nodeId: string) => {
    rendererAccessSequenceRef.current += 1;
    rendererLastAccessedAtRef.current.set(nodeId, rendererAccessSequenceRef.current);
    rendererSnapshotFailedRef.current.delete(nodeId);
    rendererSnapshotDeferredRef.current.delete(nodeId);
    setRendererAccessVersion((version) => version + 1);
  }, []);
  // Keep the old owner available until project-switch cleanup has captured and
  // finished stopping it. A transient React state reset must not erase that
  // ownership before the cleanup boundary runs.
  if (rendererSessionId !== null || rendererSessionIdRef.current === null) {
    rendererSessionIdRef.current = rendererSessionId;
  }
  // A project prop change renders before its hydration effect runs. Close the
  // mutation gate during that render so the previous document is never an
  // interactive bridge into the newly selected project. Cancel transient
  // camera and pointer work at the same boundary.
  if (canvasMutationProjectPathRef.current !== projectPath) {
    rendererOperationVersionRef.current += 1;
    cameraAnimationCancelRef.current?.();
    cameraAnimationCancelRef.current = null;
    if (cameraFrameRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(cameraFrameRef.current);
      else window.clearTimeout(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }
    pendingCameraRef.current = null;
    const pointerCapture = canvasPointerCaptureRef.current;
    if (pointerCapture?.element.hasPointerCapture(pointerCapture.pointerId)) {
      pointerCapture.element.releasePointerCapture(pointerCapture.pointerId);
    }
    canvasPointerCaptureRef.current = null;
    dragRef.current = null;
    resizeRef.current = null;
    rotationRef.current = null;
    spaceHeldRef.current = false;
    suppressNodeClickRef.current = false;
    canvasMutationProjectPathRef.current = projectPath;
    canvasHydrationGateRef.current.begin(projectPath);
    canvasMutationEnabledRef.current = false;
    rendererLastAccessedAtRef.current.clear();
    rendererAccessSequenceRef.current = 0;
  }
  if (rendererSnapshotProjectPathRef.current !== projectPath) {
    rendererSnapshotProjectPathRef.current = projectPath;
    rendererSnapshotEpochRef.current += 1;
    rendererSnapshotCacheRef.current.clear();
    rendererSnapshotPendingRef.current.clear();
    rendererSnapshotFailedRef.current.clear();
    rendererSnapshotDeferredRef.current.clear();
    rendererSnapshotQueueRef.current = [];
    rendererFrameElementsRef.current.clear();
  }
  const [tailwindActive, setTailwindActive] = useState(false);
  const [viteUsesReact, setViteUsesReact] = useState(false);

  useEffect(
    () => () => {
      rendererOperationVersionRef.current += 1;
      rendererSnapshotEpochRef.current += 1;
      rendererSnapshotPendingRef.current.clear();
      rendererSnapshotFailedRef.current.clear();
      rendererSnapshotDeferredRef.current.clear();
      rendererSnapshotQueueRef.current = [];
      if (rendererA11yTimeoutRef.current !== null) {
        window.clearTimeout(rendererA11yTimeoutRef.current);
      }
    },
    []
  );

  // Snapshot paths are project data rather than renderer-session state. Load
  // them before the session is ready so the first paint after reopening can
  // use the last known poster while the approved renderer warms in the
  // background. The render-input key is still checked at the point of use.
  useEffect(() => {
    let cancelled = false;
    const requestedProjectPath = projectPath;
    void readRendererSnapshots(requestedProjectPath)
      .then((records) => {
        if (cancelled || currentProjectPathRef.current !== requestedProjectPath) return;
        for (const record of records) {
          if (
            !record ||
            typeof record.nodeId !== 'string' ||
            typeof record.snapshotKey !== 'string' ||
            typeof record.path !== 'string' ||
            !record.nodeId ||
            !record.snapshotKey ||
            !record.path
          ) {
            continue;
          }
          rendererSnapshotCacheRef.current.set(record.nodeId, {
            snapshotKey: record.snapshotKey,
            path: record.path,
          });
        }
        setRendererSnapshotVersion((version) => version + 1);
      })
      .catch(() => {
        // A missing or unreadable cache should never make the canvas unusable;
        // the renderer can simply produce fresh snapshots in the background.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (projectType !== 'vite' || !projectPath) {
      setViteUsesReact(false);
      return;
    }
    let cancelled = false;
    void projectUsesReact(projectPath)
      .then((isReact) => !cancelled && setViteUsesReact(isReact))
      .catch(() => !cancelled && setViteUsesReact(false));
    return () => {
      cancelled = true;
    };
  }, [projectPath, projectType]);

  const editorFramework =
    projectType === 'nextjs' ||
    projectType === 'astro' ||
    projectType === 'shopifytheme' ||
    (projectType === 'vite' && viteUsesReact);
  useEffect(() => {
    if (!projectPath || !editorFramework) {
      setTailwindActive(false);
      return;
    }
    let cancelled = false;
    void isTailwindActive(projectPath)
      .then((active) => !cancelled && setTailwindActive(active))
      .catch(() => !cancelled && setTailwindActive(false));
    return () => {
      cancelled = true;
    };
  }, [editorFramework, projectPath]);

  const qualifiedEditorMode = resolveEditorMode({ projectType, tailwindActive, viteUsesReact });
  const editorBreakpoints = useBreakpoints(
    projectPath,
    qualifiedEditorMode === 'tailwind' && !!rendererSurfaceTarget?.capabilities.editing
  );

  useEffect(() => {
    const previousProjectPath = rendererSessionProjectPathRef.current;
    const activeSessionId = rendererSessionIdRef.current;
    if (previousProjectPath !== projectPath) {
      rendererOperationVersionRef.current += 1;
      if (activeSessionId) {
        const owningProjectPath = previousProjectPath;
        void (async () => {
          await stopComponentRendererSession(owningProjectPath, activeSessionId).catch(
            () => undefined
          );
          await cleanupComponentRendererSession(owningProjectPath, activeSessionId).catch(
            () => undefined
          );
          if (rendererSessionIdRef.current === activeSessionId) {
            rendererSessionIdRef.current = null;
          }
        })();
      }
      setRendererSessionId(null);
      setRendererSession(null);
      setRendererSessionState('stopped');
      setRendererRouteSegment(null);
      setSetupSession(null);
      setSetupPlan(null);
      setSetupPhase('review');
      setRendererSurfaceTarget(null);
      setRendererFrameElement(null);
      setRendererEditContext(null);
      setRendererElementSelection(null);
      setRendererSnapshotPath(null);
      setRendererSnapshotError(null);
      setRendererSnapshotState('idle');
      setRendererFrameState('idle');
      setRendererFrameError(null);
      setSetupOpen(false);
      setEditMainConfirmOpen(false);
      setEditMainConfirmed(false);
      setSelectedNodeIds([]);
      setContextNodeId(null);
      setContextMenuOpen(false);
      setSelectedGuideId(null);
      setMarquee(null);
      setSnapGuides([]);
      rendererPublishedFrameKeysRef.current.clear();
      rendererPublishedFrameReloadKeysRef.current.clear();
      rendererPublishedFrameRetryNoncesRef.current.clear();
      autoSetupAttemptRef.current = null;
    }
    rendererSessionProjectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(
    () => () => {
      const activeSessionId = rendererSessionIdRef.current;
      if (!activeSessionId) return;
      const activeProjectPath = rendererSessionProjectPathRef.current;
      void stopComponentRendererSession(activeProjectPath, activeSessionId)
        .catch(() => undefined)
        .then(() => cleanupComponentRendererSession(activeProjectPath, activeSessionId))
        .catch(() => undefined);
    },
    []
  );

  // Hydration can render the workspace before the canvas ref exists. Rerun the
  // measurement when interactivity mounts the canvas so ruler geometry is real.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      setViewportSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [canvasInteractive]);

  const { execute: loadSourceSnapshot } = useInvoke<ComponentSourceSnapshot>(
    'get_component_source_snapshot',
    { latestOnly: true }
  );
  const savedPresets = useMemo(
    () =>
      readComponentPreviewPresetStore(localStorage, componentPreviewPresetStorageKey(projectPath)),
    [projectPath]
  );
  const [presetStore, setPresetStore] = useState(savedPresets);
  const [presetName, setPresetName] = useState('');
  useEffect(() => {
    // A project switch gets a fresh project-scoped preset store.
    setPresetStore(savedPresets);
  }, [savedPresets]);
  const reconciledPresets = useMemo(
    () =>
      index ? reconcileComponentPreviewPresets(presetStore, index) : { active: [], orphaned: [] },
    [index, presetStore]
  );
  const { execute: persistCanvasDocument, error: persistError } = useAsyncState(
    async (request: { projectPath: string; document: CanvasDocumentV2 }) =>
      writeAdaptedComponentCanvasDocument(request.projectPath, request.document),
    { latestOnly: true }
  );
  const committedDocumentsRef = useRef(new WeakSet<object>());
  const canvasPersistenceSchedulerRef = useRef(createCanvasPersistenceScheduler());
  const persistCommittedCanvasDocument = useCallback(
    (next: CanvasDocumentV2) => {
      if (
        !hydrated ||
        hydratedProjectPathRef.current !== projectPath ||
        unreadableCanvasPayload !== undefined
      )
        return;
      // The normal document effect also observes this identity. Mark it so a
      // committed write is immediate without scheduling a duplicate debounce.
      committedDocumentsRef.current.add(next);
      canvasPersistenceSchedulerRef.current.settle(next, (document) =>
        persistCanvasDocument({ projectPath, document })
      );
    },
    [hydrated, persistCanvasDocument, projectPath, unreadableCanvasPayload]
  );
  const componentsById = useMemo(
    () => new Map((index?.components ?? []).map((component) => [component.id, component])),
    [index?.components]
  );
  const rendererRegistry = useMemo(
    () =>
      index
        ? buildRendererRegistry(index, { revision: index.revision }, 'react', {
            currentSourceRevision: index.revision,
          })
        : null,
    [index]
  );
  const registryByComponentId = useMemo(
    () => new Map((rendererRegistry?.entries ?? []).map((entry) => [entry.componentId, entry])),
    [rendererRegistry]
  );
  const rendererInspectorAvailable = useMemo(
    () => rendererRegistry?.entries.some((entry) => entry.supported && !!entry.renderRoot) === true,
    [rendererRegistry]
  );
  const selectedComponent = selectedComponentId
    ? (componentsById.get(selectedComponentId) ?? null)
    : null;

  const prepareRenderer = useCallback(
    async (consentVersion: string) => {
      if (!canInteractWithCanvas()) return;
      if (!index || !rendererRegistry || devServerPort <= 0) {
        setSetupError('Start the project development server before setting up the renderer.');
        return;
      }
      if (!COMPONENT_RENDERER_FLAGS.nextAppRouter && !COMPONENT_RENDERER_FLAGS.nextPagesRouter) {
        setSetupError('The Next renderer is disabled until its runtime acceptance matrix passes.');
        return;
      }
      setSetupPhase('preparing');
      setSetupError(null);
      const requestedProjectPath = projectPath;
      const guard = createRendererOperationGuard(
        requestedProjectPath,
        rendererOperationVersionRef.current,
        () => ({
          projectPath: currentProjectPathRef.current,
          operationVersion: rendererOperationVersionRef.current,
        })
      );
      let nativeSession: ComponentRendererSession | null = null;
      const disposeNativeSession = async () => {
        const session = nativeSession;
        nativeSession = null;
        if (!session) return;
        await stopComponentRendererSession(requestedProjectPath, session.sessionId).catch(
          () => undefined
        );
        await cleanupComponentRendererSession(requestedProjectPath, session.sessionId).catch(
          () => undefined
        );
      };
      try {
        const supportedComponentIds = rendererRegistry.supportedComponentIds;
        const sourceRevisions = Object.fromEntries(
          rendererRegistry.entries
            .filter((entry) => entry.supported)
            .map((entry) => [entry.componentId, entry.sourceRevision])
        );
        await installComponentRendererRegistry(requestedProjectPath, {
          consentVersion,
          sourceRevision: rendererRegistry.sourceRevision,
          componentRevisions: sourceRevisions,
        });
        if (!guard.isCurrent()) return await disposeNativeSession();
        const origin = `http://localhost:${devServerPort}`;
        nativeSession = await prepareComponentRendererSession(requestedProjectPath, {
          allowedOrigin: origin,
          baseUrl: origin,
          requestedComponentIds: supportedComponentIds,
          capabilities: {
            liveFrame: true,
            snapshots: true,
            accessibility: true,
            editing: componentRendererEditingEnabled(
              COMPONENT_RENDERER_FLAGS,
              rendererInspectorAvailable
            ),
          },
        });
        if (!guard.isCurrent()) return await disposeNativeSession();
        const sourceSnapshot = await loadSourceSnapshot({ projectPath: requestedProjectPath });
        if (!guard.isCurrent()) return await disposeNativeSession();
        const plan = buildNextRendererHostPlan(
          index,
          rendererRegistry,
          // The route allocator and Pages Router compatibility checks see the
          // current project snapshot rather than guessing from filesystem state.
          sourceSnapshot?.files.map((file) => file.file) ?? [],
          {
            sessionId: nativeSession.sessionId,
            capabilityToken: nativeSession.capabilityToken,
            sessionEndpoint: nativeSession.dataEndpoint,
            parentOrigin: window.location.origin,
            workspaceRoot: sourceSnapshot?.workspaceRoot,
            generation: nativeSession.generation,
            routeIdentity: COMPONENT_RENDERER_INTEGRATION_VERSION,
            runtimeFiles: sourceSnapshot?.files ?? [],
            runtimeSnapshotComplete: sourceSnapshot ? !sourceSnapshot.partial : false,
          }
        );
        if (!plan.supported) {
          await disposeNativeSession();
          if (!guard.isCurrent()) return;
          setSetupPlan(plan);
          setSetupPhase('review');
          setSetupError(plan.reason);
          return;
        }
        setSetupPlan(plan);
        setSetupPhase('installing');
        await installComponentRendererHost(requestedProjectPath, {
          sessionId: nativeSession.sessionId,
          capabilityToken: nativeSession.capabilityToken,
          consentVersion,
          files: plan.files.filter((file) => file.kind !== 'registry'),
        });
        if (!guard.isCurrent()) return await disposeNativeSession();
        setSetupSession(nativeSession);
        setRendererSession(toRendererSessionDescriptor(nativeSession));
        setRendererSessionId(nativeSession.sessionId);
        setRendererSessionState('starting');
        setRendererRouteSegment(plan.routeSegment);
        setSetupPhase('ready');
        nativeSession = null;
      } catch (error) {
        await disposeNativeSession();
        if (!guard.isCurrent()) return;
        setSetupPhase('review');
        setSetupError(formatCommandError(asCommandError(error)));
      }
    },
    [
      devServerPort,
      index,
      loadSourceSnapshot,
      projectPath,
      rendererInspectorAvailable,
      rendererRegistry,
      canInteractWithCanvas,
    ]
  );

  const enableRenderer = useCallback(async () => {
    if (!canInteractWithCanvas()) return;
    if (rendererPreflight.status !== 'ready' || !setupPlan?.supported || !index) return;
    setSetupPhase('preparing');
    setSetupError(null);
    try {
      const consent = await grantComponentRendererConsent(projectPath);
      setRendererConsent(consent);
      setRendererConsentProjectPath(projectPath);
      autoSetupAttemptRef.current = `${projectPath}:${index.revision}:${COMPONENT_RENDERER_INTEGRATION_VERSION}`;
      await prepareRenderer(consent.integrationVersion);
    } catch (error) {
      setSetupPhase('review');
      setSetupError(formatCommandError(asCommandError(error)));
    }
  }, [
    canInteractWithCanvas,
    index,
    prepareRenderer,
    projectPath,
    rendererPreflight.status,
    setupPlan,
  ]);

  const startApprovedRenderer = useCallback(async () => {
    if (!canInteractWithCanvas()) return;
    if (!rendererConsent || rendererPreflight.status !== 'ready' || !index || rendererSessionId) {
      return;
    }
    autoSetupAttemptRef.current = `${projectPath}:${index.revision}:${COMPONENT_RENDERER_INTEGRATION_VERSION}`;
    await prepareRenderer(rendererConsent.integrationVersion);
  }, [
    index,
    canInteractWithCanvas,
    prepareRenderer,
    projectPath,
    rendererConsent,
    rendererPreflight.status,
    rendererSessionId,
  ]);

  useEffect(() => {
    if (projectType !== 'nextjs' || !projectPath) {
      setRendererConsent(null);
      setRendererConsentProjectPath(null);
      setRendererPreflight({ status: 'idle' });
      autoSetupAttemptRef.current = null;
      return;
    }
    let cancelled = false;
    setRendererConsent(null);
    setRendererConsentProjectPath(null);
    autoSetupAttemptRef.current = null;
    void getComponentRendererConsent(projectPath)
      .then((consent) => {
        if (cancelled) return;
        setRendererConsent(consent);
        setRendererConsentProjectPath(projectPath);
        if (!consent) autoSetupAttemptRef.current = null;
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setSetupError(
            error instanceof Error ? error.message : 'Renderer consent could not be read.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, projectType]);

  // Preflight is intentionally read-only. It lets the workspace explain an
  // ambiguous router or unavailable source snapshot before consent is ever
  // requested; no registry, route, or host file is written here.
  useEffect(() => {
    if (!canvasInteractive || projectType !== 'nextjs' || !index) {
      setRendererPreflight({ status: 'idle' });
      return;
    }
    if (devServerPort <= 0) {
      setRendererPreflight({
        status: 'blocked',
        message: 'Start the project development server to enable live component previews.',
      });
      return;
    }
    let cancelled = false;
    setRendererPreflight({ status: 'checking', message: 'Checking Next routing…' });
    void loadSourceSnapshot({ projectPath })
      .then((snapshot) => {
        if (cancelled) return;
        if (!snapshot || snapshot.partial || !rendererRegistry) {
          setRendererPreflight({
            status: 'blocked',
            message: 'Renderer compatibility needs a complete source snapshot.',
          });
          return;
        }
        const plan = buildNextRendererHostPlan(
          index,
          rendererRegistry,
          snapshot.files.map((file) => file.file),
          {
            sessionId: 'preflight-session',
            capabilityToken: 'preflight-capability',
            sessionEndpoint: 'http://127.0.0.1:43123',
            parentOrigin: window.location.origin,
            workspaceRoot: snapshot.workspaceRoot,
            generation: 1,
            routeIdentity: COMPONENT_RENDERER_INTEGRATION_VERSION,
            runtimeFiles: snapshot.files,
            runtimeSnapshotComplete: true,
          }
        );
        setSetupPlan(plan);
        if (!plan.supported) {
          setRendererPreflight({ status: 'blocked', message: plan.reason });
          return;
        }
        setRendererPreflight({
          status: 'ready',
          message: `${plan.router === 'app' ? 'App Router' : 'Pages Router'} is ready for live previews.`,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRendererPreflight({
            status: 'blocked',
            message:
              error instanceof Error ? error.message : 'Renderer compatibility check failed.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    canvasInteractive,
    devServerPort,
    index,
    loadSourceSnapshot,
    projectPath,
    projectType,
    rendererRegistry,
  ]);

  useEffect(() => {
    if (
      !canvasInteractive ||
      projectType !== 'nextjs' ||
      !index ||
      !rendererRegistry ||
      devServerPort <= 0 ||
      rendererConsent?.integrationVersion !== COMPONENT_RENDERER_INTEGRATION_VERSION ||
      rendererConsentProjectPath !== projectPath ||
      rendererPreflight.status !== 'ready' ||
      rendererSessionId ||
      setupSession
    ) {
      return;
    }
    const attemptKey = `${projectPath}:${index.revision}:${COMPONENT_RENDERER_INTEGRATION_VERSION}`;
    if (autoSetupAttemptRef.current === attemptKey) return;
    autoSetupAttemptRef.current = attemptKey;
    void prepareRenderer(rendererConsent.integrationVersion);
  }, [
    devServerPort,
    canvasInteractive,
    index,
    prepareRenderer,
    projectPath,
    projectType,
    rendererConsent,
    rendererConsentProjectPath,
    rendererPreflight.status,
    rendererRegistry,
    rendererSessionId,
    setupSession,
  ]);

  useEffect(() => {
    const guard = createCanvasLoadGuard(projectPath);
    canvasHydrationGateRef.current.begin(projectPath);
    canvasMutationEnabledRef.current = false;
    hydratedProjectPathRef.current = null;
    setHydrated(false);
    setUnreadableCanvasPayload(undefined);
    void readAdaptedComponentCanvasDocument(projectPath)
      .then((result) => {
        if (!guard.accepts(currentProjectPathRef.current)) return;
        activeCanvasTransactionRef.current = null;
        activeCanvasTransactionProjectPathRef.current = null;
        publishCanvasDocument(result.document, 'reset', 'Load canvas document');
        setUnreadableCanvasPayload(result.unreadablePayload);
        hydratedProjectPathRef.current = projectPath;
        canvasHydrationGateRef.current.resolve(projectPath, result.unreadablePayload === undefined);
        canvasMutationEnabledRef.current = result.unreadablePayload === undefined;
        setHydrated(true);
      })
      .catch(() => {
        if (!guard.accepts(currentProjectPathRef.current)) return;
        // Keep the empty in-memory document; the existing persistence error
        // surface remains authoritative for failed writes.
        activeCanvasTransactionRef.current = null;
        activeCanvasTransactionProjectPathRef.current = null;
        publishCanvasDocument(
          createEmptyCanvasDocument() as CanvasDocumentV2,
          'reset',
          'Reset unreadable canvas document'
        );
        setUnreadableCanvasPayload('canvas-read-failed');
        hydratedProjectPathRef.current = projectPath;
        canvasHydrationGateRef.current.resolve(projectPath, false);
        canvasMutationEnabledRef.current = false;
        setHydrated(true);
      });
    return () => guard.cancel();
  }, [projectPath, publishCanvasDocument]);

  useEffect(() => {
    const project = projectPath;
    const scheduler = canvasPersistenceSchedulerRef.current;
    return () => {
      const transaction = activeCanvasTransactionRef.current;
      if (transaction) {
        activeCanvasTransactionRef.current = null;
        activeCanvasTransactionProjectPathRef.current = null;
        const rollback = transaction.abort();
        documentRef.current = rollback;
        persistCommittedCanvasDocument(rollback);
      } else {
        scheduler.cancel();
      }
      // Camera gestures are intentionally coalesced into the next animation
      // frame. Flush that last value before the canvas unmounts so returning
      // to Components restores the exact view the user left.
      const pendingCamera = pendingCameraRef.current;
      if (pendingCamera) {
        const next = {
          ...documentRef.current,
          scopes: {
            ...documentRef.current.scopes,
            [scope]: { ...documentRef.current.scopes[scope], camera: pendingCamera },
          },
        };
        documentRef.current = next;
        pendingCameraRef.current = null;
        persistCommittedCanvasDocument(next);
      }
      // A committed edit may already be in the per-project queue when the
      // workspace is switched or unmounted. Do not cancel it with the React
      // lifetime; allow the storage boundary to drain it for this project.
      void flushComponentCanvasWrites(project);
    };
  }, [persistCommittedCanvasDocument, projectPath, scope]);

  useEffect(() => {
    if (!hydrated || !index) return;
    // Reconcile generated nodes after the catalog worker publishes an index.
    publishCanvasDocument(
      (() => {
        const current = documentRef.current;
        const existing = new Set(
          current.nodes.filter((node) => node.scope === 'all').map((node) => node.componentId)
        );
        const additions = index.components
          .filter((component) => !existing.has(component.id))
          .map((component, position) =>
            defaultNode(
              component,
              'all',
              current.nodes.length + position,
              sharedCanvasFrameSize(current.nodes, component.id)
            )
          );
        if (additions.length === 0) return current;
        const allNodes = autoLayoutCanvasNodes([...current.nodes, ...additions]);
        return { ...current, nodes: allNodes };
      })(),
      'transient',
      'Reconcile canvas catalog'
    );
  }, [hydrated, index, publishCanvasDocument]);

  useEffect(() => {
    if (!hydrated || !selectedComponent) return;
    // Scope changes may materialize a persisted/generated node for the selection.
    publishCanvasDocument(
      (() => {
        const current = documentRef.current;
        const additions: ComponentCanvasNode[] = [];
        if (
          scope === 'focus' &&
          !current.nodes.some(
            (node) => node.scope === 'focus' && node.componentId === selectedComponent.id
          )
        ) {
          additions.push(
            defaultNode(
              selectedComponent,
              'focus',
              current.nodes.length,
              sharedCanvasFrameSize(current.nodes, selectedComponent.id)
            )
          );
        }
        if (scope === 'variants') {
          const frameSize = sharedCanvasFrameSize(current.nodes, selectedComponent.id);
          const saved = reconciledPresets.active.filter(
            (preset) => preset.componentId === selectedComponent.id
          );
          for (const [position, preset] of saved.entries()) {
            if (
              !current.nodes.some(
                (node) => node.scope === 'variants' && node.presetId === preset.id
              )
            ) {
              additions.push(
                nodeForPreset(
                  selectedComponent,
                  preset.id,
                  'variants',
                  current.nodes.length + position,
                  frameSize
                )
              );
            }
          }
          if (
            saved.length === 0 &&
            !current.nodes.some(
              (node) => node.scope === 'variants' && node.componentId === selectedComponent.id
            )
          ) {
            additions.push(
              defaultNode(selectedComponent, 'variants', current.nodes.length, frameSize)
            );
          }
        }
        if (additions.length === 0) return current;
        return { ...current, nodes: autoLayoutCanvasNodes([...current.nodes, ...additions]) };
      })(),
      'transient',
      'Materialize canvas scope'
    );
  }, [hydrated, publishCanvasDocument, reconciledPresets.active, scope, selectedComponent]);

  useEffect(() => {
    if (
      !hydrated ||
      hydratedProjectPathRef.current !== projectPath ||
      unreadableCanvasPayload !== undefined
    )
      return;
    if (committedDocumentsRef.current.has(document)) {
      committedDocumentsRef.current.delete(document);
      return;
    }
    const scheduler = canvasPersistenceSchedulerRef.current;
    scheduler.schedule(document, (next) => persistCanvasDocument({ projectPath, document: next }));
    return () => scheduler.cancel();
  }, [document, hydrated, persistCanvasDocument, projectPath, unreadableCanvasPayload]);

  useEffect(() => {
    // Mirror the typed navigation payload into local interaction state.
    setScope(navigation.scope);
    if (navigation.componentId) setSelectedComponentId(navigation.componentId);
    if (navigation.selectedNodeIds) setSelectedNodeIds(navigation.selectedNodeIds);
    if (navigation.presetId && !navigation.componentId) {
      const preset = presetStore.presets.find((candidate) => candidate.id === navigation.presetId);
      if (preset) setSelectedComponentId(preset.componentId);
    }
  }, [navigation.componentId, navigation.presetId, navigation.scope, presetStore.presets]);

  // Keep the all-components list independent from the edit panel's current
  // component. Changing selection must not manufacture a new node/frame graph
  // for every card on the canvas.
  const allCanvasNodes = useMemo(
    () =>
      canvasInteractive && index
        ? document.nodes.filter(
            (node) =>
              node.scope === 'all' && nodeIsVisible(node) && componentsById.has(node.componentId)
          )
        : [],
    [canvasInteractive, componentsById, document.nodes, index]
  );
  const focusedComponentId = scope === 'all' ? null : (selectedComponent?.id ?? null);
  const focusedComponent = focusedComponentId
    ? (componentsById.get(focusedComponentId) ?? null)
    : null;
  const visibleDocumentNodes = useMemo(() => {
    if (!canvasInteractive || !index) return [];
    if (scope === 'all') return allCanvasNodes;
    if (!focusedComponent) return [];
    if (scope === 'focus') {
      return [
        document.nodes.find(
          (node) =>
            node.scope === 'focus' &&
            node.componentId === focusedComponent.id &&
            nodeIsVisible(node)
        ) ??
          defaultNode(
            focusedComponent,
            'focus',
            0,
            sharedCanvasFrameSize(document.nodes, focusedComponent.id)
          ),
      ];
    }
    const stored = document.nodes.filter(
      (node) =>
        node.scope === 'variants' && node.componentId === focusedComponent.id && nodeIsVisible(node)
    );
    return stored.length > 0
      ? stored
      : [
          defaultNode(
            focusedComponent,
            'variants',
            0,
            sharedCanvasFrameSize(document.nodes, focusedComponent.id)
          ),
        ];
  }, [allCanvasNodes, canvasInteractive, document.nodes, focusedComponent, index, scope]);
  const visibleNodes = useMemo(
    () => toCanvasWorldNodes(visibleDocumentNodes, document.nodes),
    [document.nodes, visibleDocumentNodes]
  );
  const selectedNodeId = selectedNodeIds[0] ?? null;
  const selectedNode = selectedNodeId
    ? (visibleNodes.find((node) => node.id === selectedNodeId) ?? null)
    : null;

  useEffect(() => {
    const navigationNodeIds = navigation.selectedNodeIds ?? [];
    const selectionMatchesNavigation =
      navigationNodeIds.length === selectedNodeIds.length &&
      navigationNodeIds.every((nodeId, index) => nodeId === selectedNodeIds[index]);
    const componentIdForNavigation = selectedNode?.componentId ?? selectedComponentId ?? undefined;
    if (
      navigation.scope === scope &&
      navigation.componentId === componentIdForNavigation &&
      selectionMatchesNavigation
    ) {
      return;
    }
    onNavigate({
      componentId: componentIdForNavigation,
      scope,
      selectedNodeIds,
    });
  }, [
    navigation.componentId,
    navigation.scope,
    navigation.selectedNodeIds,
    onNavigate,
    scope,
    selectedComponentId,
    selectedNode,
    selectedNodeIds,
  ]);

  useEffect(() => {
    if (!navigation.presetId) return;
    const node = document.nodes.find(
      (candidate) =>
        candidate.presetId === navigation.presetId &&
        candidate.scope === scope &&
        nodeIsVisible(candidate) &&
        (scope === 'all' || candidate.componentId === selectedComponent?.id)
    );
    if (!node) return;
    setSelectedNodeIds([node.id]);
    setSelectedComponentId(node.componentId);
  }, [document.nodes, navigation.presetId, scope, selectedComponent?.id]);
  const rendererFrames = useMemo(() => {
    const frames = new Map<string, RendererFramePayload>();
    if (!rendererRegistry) return frames;
    const presetsById = new Map(presetStore.presets.map((preset) => [preset.id, preset]));
    for (const node of visibleNodes) {
      const component = componentsById.get(node.componentId);
      if (!component) continue;
      const entry = registryByComponentId.get(node.componentId);
      const componentRevision =
        rendererSession?.sourceRevisions[node.componentId] ?? entry?.sourceRevision;
      if (!componentRevision || !entry?.supported) continue;
      const preset = node.presetId ? (presetsById.get(node.presetId) ?? null) : null;
      const generatedVariant =
        (node.generated && resolveGeneratedCanvasVariant(generatedVariants, node.presetId)) ||
        (node.generated
          ? resolveGeneratedCanvasVariantForComponent(component, node.presetId)
          : null);
      frames.set(node.id, {
        protocolVersion: 2,
        // Static posters can be resolved before the ephemeral renderer
        // session exists. These placeholders are never published; they only
        // provide the stable render-input identity needed to hydrate cache
        // entries immediately on project reopen.
        projectIdentity: rendererSession?.projectIdentity ?? projectPath,
        sessionId: rendererSession?.sessionId ?? '',
        frameId: node.id,
        componentId: node.componentId,
        componentRevision,
        generation: rendererSession?.generation ?? 0,
        // Generated finite variants are ephemeral rather than saved presets,
        // so resolve their explicit matrix props by stable variant ID before
        // falling back to an empty authored preset payload.
        props: preset?.props ?? generatedVariant?.props ?? {},
        slots: preset?.slots ?? {},
        presentation: {
          widthMode: 'fixed',
          width: node.width,
          height: nearestCanvasFrameHeight(node.height),
          background: node.presentation.background,
          breakpoint: node.presentation.breakpoint,
          locale: node.presentation.locale,
        },
      });
    }
    return frames;
  }, [
    componentsById,
    generatedVariants,
    presetStore.presets,
    projectPath,
    registryByComponentId,
    rendererRegistry,
    rendererSession,
    visibleNodes,
  ]);
  const rendererStageEnabled =
    componentRendererStageEnabled(
      COMPONENT_RENDERER_FLAGS,
      COMPONENT_RENDERER_INTEGRATION_VERSION
    ) &&
    !!rendererSession &&
    !!rendererRouteSegment;
  const rendererStageId = rendererSession ? `component-canvas-${rendererSession.sessionId}` : null;
  const rendererStageFrames = useMemo<RendererStageFrame[]>(
    () =>
      visibleNodes.flatMap((node) => {
        const frame = rendererFrames.get(node.id);
        if (!frame) return [];
        return [
          {
            ...frame,
            layout: {
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              rotation: nodeRotation(node),
            },
            visible: true,
          },
        ];
      }),
    [rendererFrames, visibleNodes]
  );
  const selectedRendererFrame = selectedNodeId
    ? (rendererFrames.get(selectedNodeId) ?? null)
    : null;
  selectedRendererFrameIdRef.current = selectedRendererFrame?.frameId ?? null;
  rendererFramesRef.current = rendererFrames;

  const captureRendererSnapshots = useCallback(
    (nodeIds: readonly string[]) => {
      const captureEpoch = rendererSnapshotEpochRef.current;
      const rendererVersion = rendererRouteSegment ?? COMPONENT_RENDERER_INTEGRATION_VERSION;
      for (const nodeId of new Set(nodeIds)) {
        const frame = rendererFramesRef.current.get(nodeId);
        const frameElement = rendererFrameElementsRef.current.get(nodeId);
        // The native screenshot command crops the visible Ship Studio window.
        // Do not treat an offscreen frame as a failed render: leave it out of
        // this pass and let a later camera/visibility change make it eligible.
        if (!frame || !frameElement) continue;
        const snapshotKey = rendererFrameSnapshotKey(frame, rendererVersion);
        const lifecycleState = rendererLifecycleRef.current.stateFor(nodeId);
        // Only a frame whose authenticated dimensions event has completed is
        // eligible. In particular, a host `ready` event alone can precede the
        // component's first real paint and would preserve a loading screen.
        if (lifecycleState?.status !== 'live' || lifecycleState.snapshotKey !== snapshotKey) {
          continue;
        }
        if (!hasUsableRendererSnapshotBounds(frameElement)) {
          rendererSnapshotDeferredRef.current.set(nodeId, snapshotKey);
          rendererLifecycleRef.current.cancel(nodeId);
          setRendererSnapshotVersion((version) => version + 1);
          continue;
        }
        const rendererReloadKey = rendererFrameReloadKey(frame);
        const pendingJob = rendererSnapshotPendingRef.current.get(nodeId);
        if (rendererSnapshotCacheRef.current.getExact(nodeId, snapshotKey)) {
          continue;
        }
        if (
          pendingJob?.snapshotKey === snapshotKey &&
          pendingJob.rendererReloadKey === rendererReloadKey &&
          pendingJob.retryNonce === lifecycleState.retryNonce &&
          pendingJob.captureEpoch === captureEpoch &&
          pendingJob.projectPath === projectPath
        ) {
          continue;
        }
        const job: RendererSnapshotJob = {
          nodeId,
          snapshotKey,
          rendererReloadKey,
          retryNonce: lifecycleState.retryNonce,
          captureEpoch,
          projectPath,
          rendererVersion,
        };
        rendererSnapshotPendingRef.current.set(nodeId, job);
        rendererSnapshotQueueRef.current.push(job);
      }
      if (rendererSnapshotCaptureRunningRef.current) return;
      if (rendererSnapshotQueueRef.current.length === 0) return;

      rendererSnapshotCaptureRunningRef.current = true;
      void (async () => {
        while (rendererSnapshotQueueRef.current.length > 0) {
          const job = rendererSnapshotQueueRef.current.shift();
          if (!job) continue;
          if (rendererSnapshotPendingRef.current.get(job.nodeId) !== job) continue;
          if (
            job.captureEpoch !== rendererSnapshotEpochRef.current ||
            currentProjectPathRef.current !== job.projectPath
          ) {
            if (rendererSnapshotPendingRef.current.get(job.nodeId) === job) {
              rendererSnapshotPendingRef.current.delete(job.nodeId);
            }
            continue;
          }
          const frame = rendererFramesRef.current.get(job.nodeId);
          const frameElement = rendererFrameElementsRef.current.get(job.nodeId);
          if (
            !frame ||
            !frameElement ||
            rendererFrameSnapshotKey(frame, job.rendererVersion) !== job.snapshotKey ||
            rendererFrameReloadKey(frame) !== job.rendererReloadKey ||
            rendererLifecycleRef.current.stateFor(job.nodeId)?.retryNonce !== job.retryNonce
          ) {
            if (rendererSnapshotPendingRef.current.get(job.nodeId) === job) {
              rendererSnapshotPendingRef.current.delete(job.nodeId);
            }
            setRendererSnapshotVersion((version) => version + 1);
            continue;
          }
          if (!hasUsableRendererSnapshotBounds(frameElement)) {
            rendererSnapshotDeferredRef.current.set(job.nodeId, job.snapshotKey);
            rendererLifecycleRef.current.cancel(job.nodeId);
            if (rendererSnapshotPendingRef.current.get(job.nodeId) === job) {
              rendererSnapshotPendingRef.current.delete(job.nodeId);
            }
            setRendererSnapshotVersion((version) => version + 1);
            continue;
          }
          try {
            const path = await captureRendererFrameSnapshot(job.projectPath, frameElement, {
              requireFullyVisible: true,
            });
            const isSnapshotJobCurrent = () => {
              const currentFrame = rendererFramesRef.current.get(job.nodeId);
              const currentLifecycleState = rendererLifecycleRef.current.stateFor(job.nodeId);
              return (
                job.captureEpoch === rendererSnapshotEpochRef.current &&
                currentProjectPathRef.current === job.projectPath &&
                rendererSnapshotPendingRef.current.get(job.nodeId) === job &&
                currentFrame !== undefined &&
                rendererFrameSnapshotKey(currentFrame, job.rendererVersion) === job.snapshotKey &&
                rendererFrameReloadKey(currentFrame) === job.rendererReloadKey &&
                rendererSnapshotCommitIsCurrent(
                  currentLifecycleState,
                  job.snapshotKey,
                  job.retryNonce
                )
              );
            };
            if (!isSnapshotJobCurrent()) continue;
            // Do not release the live iframe until the static replacement has
            // its image data ready. RendererStaticSnapshotView shares this
            // result, making the DOM handoff a single paint instead of a live
            // frame → loading placeholder → snapshot sequence.
            await preloadRendererStaticSnapshot(path);
            if (!isSnapshotJobCurrent()) continue;
            rendererSnapshotCacheRef.current.set(job.nodeId, {
              snapshotKey: job.snapshotKey,
              path,
            });
            rendererSnapshotDeferredRef.current.delete(job.nodeId);
            await persistRendererSnapshot(job.projectPath, {
              nodeId: job.nodeId,
              snapshotKey: job.snapshotKey,
              path,
            }).catch(() => undefined);
            rendererSnapshotFailedRef.current.delete(job.nodeId);
            rendererLifecycleRef.current.markSnapshot(job.nodeId, job.snapshotKey);
          } catch {
            if (
              job.captureEpoch === rendererSnapshotEpochRef.current &&
              currentProjectPathRef.current === job.projectPath
            ) {
              // A failed automatic capture must not create a render/retry loop.
              // The next explicit access clears this marker and gets a fresh try.
              rendererSnapshotFailedRef.current.set(job.nodeId, job.snapshotKey);
            }
          } finally {
            if (rendererSnapshotPendingRef.current.get(job.nodeId) === job) {
              rendererSnapshotPendingRef.current.delete(job.nodeId);
            }
            if (job.captureEpoch === rendererSnapshotEpochRef.current) {
              setRendererSnapshotVersion((version) => version + 1);
            }
          }
        }
        rendererSnapshotCaptureRunningRef.current = false;
      })();
    },
    [projectPath, rendererRouteSegment]
  );

  useEffect(() => {
    if (!rendererSession || (!rendererStageEnabled && liveRendererNodeIds.length === 0)) return;
    let selectedFrameNeedsReset = false;
    const frames = [...rendererFrames.values()]
      .filter((frame) => rendererStageEnabled || liveRendererNodeIds.includes(frame.frameId))
      .filter((frame) => {
        const retryNonce = rendererLifecycleRef.current.stateFor(frame.frameId)?.retryNonce ?? 0;
        const publishKey = rendererFramePublishKey(frame, retryNonce);
        if (rendererPublishedFrameKeysRef.current.get(frame.frameId) === publishKey) return false;
        const previousContentKey = rendererPublishedFrameReloadKeysRef.current.get(frame.frameId);
        const previousRetryNonce = rendererPublishedFrameRetryNoncesRef.current.get(frame.frameId);
        if (
          frame.frameId === selectedRendererFrame?.frameId &&
          shouldResetRendererFrameState(previousContentKey, previousRetryNonce, frame, retryNonce)
        ) {
          selectedFrameNeedsReset = true;
        }
        rendererPublishedFrameKeysRef.current.set(frame.frameId, publishKey);
        rendererPublishedFrameReloadKeysRef.current.set(
          frame.frameId,
          rendererFrameReloadKey(frame)
        );
        rendererPublishedFrameRetryNoncesRef.current.set(frame.frameId, retryNonce);
        return true;
      });
    if (frames.length === 0) return;
    if (selectedFrameNeedsReset) {
      setRendererFrameState('loading');
      setRendererFrameError(null);
    }
    let cancelled = false;
    for (const frame of frames) {
      void publishComponentRendererFrame(projectPath, {
        sessionId: rendererSession.sessionId,
        capabilityToken: rendererSession.capabilityToken,
        payload: {
          ...frame,
          presentation: {
            ...frame.presentation,
            height: String(frame.presentation.height),
          },
        },
      }).catch((error: unknown) => {
        if (cancelled) return;
        rendererPublishedFrameKeysRef.current.delete(frame.frameId);
        rendererPublishedFrameReloadKeysRef.current.delete(frame.frameId);
        rendererPublishedFrameRetryNoncesRef.current.delete(frame.frameId);
        rendererLifecycleRef.current.markError(frame.frameId);
        setRendererSnapshotVersion((version) => version + 1);
        if (frame.frameId !== selectedRendererFrame?.frameId) return;
        setRendererFrameState('error');
        setRendererFrameError(error instanceof Error ? error.message : 'Frame publish failed.');
      });
    }
    return () => {
      cancelled = true;
    };
  }, [
    liveRendererNodeIds,
    projectPath,
    rendererRetryNonce,
    rendererFrames,
    rendererSession,
    rendererStageEnabled,
    selectedRendererFrame,
  ]);

  const onRendererEvent = useCallback(
    (event: RendererHostEvent) => {
      if (event.type === 'rendered-dimensions') {
        // The iframe resizes in screen space when the canvas camera changes.
        // A ResizeObserver can report that intermediate size before the
        // renderer applies the corresponding internal paint zoom. Do not let
        // that stale measurement feed back into persisted node geometry.
        const currentCameraZoom = cameraRef.current.zoom;
        if (
          typeof event.zoom === 'number' &&
          Math.abs(event.zoom - currentCameraZoom) > Math.max(0.001, currentCameraZoom * 0.001)
        ) {
          return;
        }
        if (rendererLifecycleRef.current.markLive(event.frameId)) {
          setRendererSnapshotVersion((version) => version + 1);
        }
        const width = Math.min(
          COMPONENT_CANVAS_MAX_WIDTH,
          Math.max(COMPONENT_CANVAS_MIN_WIDTH, Math.ceil(event.width))
        );
        const height = Math.ceil(event.height);
        const current = documentRef.current;
        const node = current.nodes.find((candidate) => candidate.id === event.frameId);
        if (
          canInteractWithCanvas() &&
          node &&
          shouldApplyRendererMeasurement(node, {
            activeResize: resizeRef.current?.nodeId === event.frameId,
          }) &&
          (node.width !== width || node.height !== height)
        ) {
          const measuredNodes = current.nodes.map((candidate) =>
            candidate.id === event.frameId ? { ...candidate, width, height } : candidate
          );
          const measuredDocument = {
            ...current,
            nodes: isCanonicalCanvasLayout(current.nodes)
              ? autoLayoutCanvasNodes(measuredNodes)
              : measuredNodes,
          };
          publishCanvasDocument(measuredDocument, 'transient', 'Update renderer measurement');
          // Renderer dimensions must survive a live-frame eviction. Persist
          // this advisory geometry immediately, without adding it to undo.
          persistCommittedCanvasDocument(measuredDocument);
        }
        if (event.frameId !== selectedRendererFrame?.frameId) return;
        setRendererSessionState('live');
        setRendererFrameState('ready');
        setRendererFrameError(null);
        return;
      }
      if (event.type === 'ready') {
        // The host's ready handshake only proves the shell mounted. Wait for
        // rendered-dimensions before promoting the card or snapshotting it.
        if (event.frameId !== selectedRendererFrame?.frameId) return;
        setRendererSessionState('live');
        return;
      }
      if (event.type === 'render-error') {
        const lifecycleState = rendererLifecycleRef.current.markError(event.frameId);
        // Lifecycle state is ref-backed, so always schedule a canvas render.
        // Otherwise a failure from an unselected card leaves its old loading
        // placeholder on screen indefinitely.
        setRendererSnapshotVersion((version) => version + 1);
        if (event.frameId !== selectedRendererFrame?.frameId) return;
        setRendererFrameState('error');
        setRendererFrameError(`${event.code}: ${event.message}`);
        setRendererCircuitOpen(lifecycleState?.circuitOpen ?? false);
        setRendererEditContext(null);
        setRendererElementSelection(null);
        setRendererSnapshotState('idle');
        if (
          rendererSurfaceTarget &&
          (event.code === 'renderer-heartbeat-lost' ||
            event.frameId === rendererSurfaceTarget.frameId)
        ) {
          deactivateEditableSurface(rendererSurfaceTarget);
          setRendererSurfaceTarget(null);
          setRendererFrameElement(null);
          onRendererFrameElementChange?.(null);
        }
        return;
      }
      if (event.type === 'accessibility-result') {
        if (event.requestId !== rendererA11yRequestIdRef.current) return;
        if (rendererA11yTimeoutRef.current !== null) {
          window.clearTimeout(rendererA11yTimeoutRef.current);
          rendererA11yTimeoutRef.current = null;
        }
        setRendererA11yFindings(event.findings);
        setRendererA11yError(null);
        setRendererA11yState('ready');
        return;
      }
      if (
        canInteractWithCanvas() &&
        (event.type === 'element-selection' || event.type === 'source-location') &&
        event.frameId === selectedRendererFrame?.frameId &&
        rendererSurfaceTarget &&
        rendererSession &&
        selectedRendererFrame &&
        selectedComponent &&
        index
      ) {
        const context: RendererFrameEditContext = {
          componentId: selectedComponent.id,
          indexedRevision: index.revision,
          definition: selectedComponent.definition,
          descendant: event.sourceRange,
          confidence: 'exact',
          proof: {
            sessionId: rendererSession.sessionId,
            frameId: selectedRendererFrame.frameId,
            componentRevision: selectedRendererFrame.componentRevision,
          },
        };
        const validation = validateRendererFrameEditContext(rendererSurfaceTarget, context);
        if (validation.status === 'valid') {
          setRendererEditContext(context);
          if (event.type === 'element-selection') {
            setRendererElementSelection({
              signature: event.signature,
              sourceRange: event.sourceRange,
            });
          }
          return;
        }
        setRendererEditContext(null);
        setRendererElementSelection(null);
        setRendererFrameError(validation.reason);
      }
    },
    [
      index,
      canInteractWithCanvas,
      persistCommittedCanvasDocument,
      publishCanvasDocument,
      rendererSession,
      rendererSurfaceTarget,
      selectedComponent,
      selectedRendererFrame,
      onRendererFrameElementChange,
    ]
  );

  /**
   * Keep the shared-stage event contract behind the same renderer checks as
   * the legacy frame host. Stage events are never trusted as a second source
   * of authority; they are normalized into the existing handler only after
   * ComponentCanvasStage has authenticated origin, source, session, stage,
   * frame identity, and current revision.
   */
  const rendererStageZoomRef = useRef(1);
  const onRendererStageEvent = useCallback(
    (event: RendererStageEvent) => {
      if (event.type === 'frame-rendered-dimensions') {
        const stageZoom = Math.max(0.01, rendererStageZoomRef.current);
        onRendererEvent({
          type: 'rendered-dimensions',
          eventId: event.eventId,
          frameId: event.frameId,
          width: event.width / stageZoom,
          height: event.height / stageZoom,
          zoom: stageZoom,
        });
        return;
      }
      if (event.type === 'frame-error') {
        onRendererEvent({
          type: 'render-error',
          eventId: event.eventId,
          frameId: event.frameId,
          code: event.code,
          message: event.message,
        });
        return;
      }
      if (event.type === 'frame-selection') {
        onRendererEvent({
          type: 'element-selection',
          eventId: event.eventId,
          frameId: event.frameId,
          sourceRange: event.sourceRange,
          signature: event.signature,
        });
        return;
      }
      if (event.type === 'stage-error' && event.frameId) {
        onRendererEvent({
          type: 'render-error',
          eventId: event.eventId,
          frameId: event.frameId,
          code: event.code,
          message: event.message,
        });
        return;
      }
      if (event.type === 'stage-error') {
        setRendererSessionState('stopped');
        setRendererFrameState('error');
        setRendererFrameError(`${event.code}: ${event.message}`);
      }
    },
    [onRendererEvent]
  );

  const retryRenderer = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (!selectedRendererFrame) return;
    if (!rendererLifecycleRef.current.retry(selectedRendererFrame.frameId)) return;
    setRendererCircuitOpen(false);
    setRendererFrameError(null);
    setRendererFrameState('loading');
    setRendererRetryNonce((current) => current + 1);
    setRendererSnapshotVersion((version) => version + 1);
  }, [canInteractWithCanvas, selectedRendererFrame]);

  const captureSnapshot = useCallback(async () => {
    if (!canInteractWithCanvas()) return;
    if (
      !rendererFrameElement ||
      rendererFrameState !== 'ready' ||
      !rendererSession ||
      !selectedRendererFrame ||
      rendererLifecycleRef.current.stateFor(selectedRendererFrame.frameId)?.status !== 'live'
    )
      return;
    const snapshotKey = rendererFrameSnapshotKey(
      selectedRendererFrame,
      rendererRouteSegment ?? COMPONENT_RENDERER_INTEGRATION_VERSION
    );
    const reloadKey = rendererFrameReloadKey(selectedRendererFrame);
    const captureEpoch = rendererSnapshotEpochRef.current;
    const retryNonce =
      rendererLifecycleRef.current.stateFor(selectedRendererFrame.frameId)?.retryNonce ?? 0;
    const isManualCaptureCurrent = () => {
      const currentFrame = rendererFramesRef.current.get(selectedRendererFrame.frameId);
      const lifecycleState = rendererLifecycleRef.current.stateFor(selectedRendererFrame.frameId);
      return (
        captureEpoch === rendererSnapshotEpochRef.current &&
        currentProjectPathRef.current === projectPath &&
        selectedRendererFrameIdRef.current === selectedRendererFrame.frameId &&
        currentFrame !== undefined &&
        rendererFrameSnapshotKey(
          currentFrame,
          rendererRouteSegment ?? COMPONENT_RENDERER_INTEGRATION_VERSION
        ) === snapshotKey &&
        rendererFrameReloadKey(currentFrame) === reloadKey &&
        rendererFrameElementsRef.current.get(selectedRendererFrame.frameId) ===
          rendererFrameElement &&
        lifecycleState?.status === 'live' &&
        lifecycleState.retryNonce === retryNonce
      );
    };
    setRendererSnapshotState('capturing');
    setRendererSnapshotError(null);
    try {
      const path = await captureRendererFrameSnapshot(projectPath, rendererFrameElement);
      await preloadRendererStaticSnapshot(path);
      if (!isManualCaptureCurrent()) {
        setRendererSnapshotState('idle');
        return;
      }
      rendererSnapshotCacheRef.current.set(selectedRendererFrame.frameId, {
        snapshotKey,
        path,
      });
      await persistRendererSnapshot(projectPath, {
        nodeId: selectedRendererFrame.frameId,
        snapshotKey,
        path,
      }).catch(() => undefined);
      if (!isManualCaptureCurrent()) {
        setRendererSnapshotState('idle');
        return;
      }
      rendererSnapshotFailedRef.current.delete(selectedRendererFrame.frameId);
      setRendererSnapshotVersion((version) => version + 1);
      setRendererSnapshotPath(path);
      setRendererSnapshotState('ready');
    } catch (error) {
      setRendererSnapshotState('idle');
      setRendererSnapshotError(
        error instanceof Error ? error.message : 'The renderer snapshot could not be captured.'
      );
    }
  }, [
    canInteractWithCanvas,
    projectPath,
    rendererFrameElement,
    rendererFrameState,
    rendererRouteSegment,
    rendererSession,
    selectedRendererFrame,
  ]);

  const runAccessibility = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (
      !rendererSurfaceTarget?.capabilities.accessibility ||
      rendererFrameState !== 'ready' ||
      !rendererSession ||
      !selectedRendererFrame
    ) {
      return;
    }
    const requestId =
      globalThis.crypto?.randomUUID?.() ??
      `a11y-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    rendererA11yRequestIdRef.current = requestId;
    if (rendererA11yTimeoutRef.current !== null) {
      window.clearTimeout(rendererA11yTimeoutRef.current);
    }
    setRendererA11yState('running');
    setRendererA11yFindings([]);
    setRendererA11yError(null);
    const posted = postToEditableSurface(rendererSurfaceTarget, {
      type: 'ss:run-accessibility',
      protocolVersion: 2,
      sessionId: rendererSession.sessionId,
      capabilityToken: rendererSession.capabilityToken,
      generation: rendererSession.generation,
      frameId: selectedRendererFrame.frameId,
      componentId: selectedRendererFrame.componentId,
      requestId,
    });
    if (!posted) {
      setRendererA11yState('idle');
      setRendererA11yError('The renderer accessibility surface is no longer available.');
      return;
    }
    rendererA11yTimeoutRef.current = window.setTimeout(() => {
      if (rendererA11yRequestIdRef.current !== requestId) return;
      rendererA11yRequestIdRef.current = null;
      rendererA11yTimeoutRef.current = null;
      setRendererA11yState('idle');
      setRendererA11yError('The renderer did not return accessibility findings in time.');
    }, COMPONENT_RENDERER_ACCESSIBILITY_TIMEOUT_MS);
  }, [
    canInteractWithCanvas,
    rendererFrameState,
    rendererSession,
    rendererSurfaceTarget,
    selectedRendererFrame,
  ]);

  // A frame switch is a hard editable-surface boundary. Deactivate the old
  // selection bridge before the next iframe is allowed to bind, and discard
  // any source range proved by the previous frame.
  // The target is intentionally read from the render that observes a new
  // frame identity; changes to the target itself must not clear a context
  // negotiated for that same frame.
  useEffect(() => {
    if (
      rendererSurfaceTarget &&
      (!selectedRendererFrame ||
        rendererSurfaceTarget.sessionId !== selectedRendererFrame.sessionId ||
        rendererSurfaceTarget.frameId !== selectedRendererFrame.frameId ||
        rendererSurfaceTarget.componentId !== selectedRendererFrame.componentId ||
        rendererSurfaceTarget.componentRevision !== selectedRendererFrame.componentRevision)
    ) {
      deactivateEditableSurface(rendererSurfaceTarget);
      setRendererSurfaceTarget(null);
      setRendererFrameElement(null);
      onRendererFrameElementChange?.(null);
    }
    setRendererEditContext(null);
    setRendererElementSelection(null);
    rendererA11yRequestIdRef.current = null;
    if (rendererA11yTimeoutRef.current !== null) {
      window.clearTimeout(rendererA11yTimeoutRef.current);
      rendererA11yTimeoutRef.current = null;
    }
    setRendererA11yFindings([]);
    setRendererA11yError(null);
    setRendererA11yState('idle');
    setEditMainConfirmed(false);
    setRendererBreakpointOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rendererSession?.sessionId,
    selectedRendererFrame?.frameId,
    selectedRendererFrame?.componentRevision,
    onRendererFrameElementChange,
  ]);

  useEffect(() => {
    // A snapshot belongs to one exact frame/revision and must not survive a
    // frame switch as if it described the newly selected renderer.
    setRendererSnapshotPath(null);
    setRendererSnapshotError(null);
    setRendererSnapshotState('idle');
  }, [selectedRendererFrame?.frameId, selectedRendererFrame?.componentRevision]);

  const handleRendererTargetChange = useCallback(
    (target: EditableSurfaceTarget | null) => {
      if (!canInteractWithCanvas()) {
        if (target) deactivateEditableSurface(target);
        return;
      }
      if (
        target &&
        (!selectedRendererFrame ||
          target.sessionId !== selectedRendererFrame.sessionId ||
          target.frameId !== selectedRendererFrame.frameId ||
          target.componentId !== selectedRendererFrame.componentId ||
          target.componentRevision !== selectedRendererFrame.componentRevision)
      ) {
        deactivateEditableSurface(target);
        return;
      }
      setRendererSurfaceTarget(target);
      if (!target) setRendererEditContext(null);
    },
    [canInteractWithCanvas, selectedRendererFrame]
  );

  const rendererSourceEditGuard = useCallback(
    (source: import('../../lib/components/types').SourceRef | null) => {
      if (!rendererSurfaceTarget || !selectedComponent || !index) {
        return {
          status: 'refused' as const,
          reason: 'Select a renderer-proven element before editing its definition.',
        };
      }
      // Tree/direct selection is read-only until the resolver returns the
      // actual child source range. A prior root context is never an authority
      // for a newly selected descendant.
      if (!source) {
        return {
          status: 'refused' as const,
          reason: 'The selected descendant has no exact source range yet.',
        };
      }
      const validation = validateRendererFrameEditContext(rendererSurfaceTarget, {
        componentId: selectedComponent.id,
        indexedRevision: index.revision,
        definition: selectedComponent.definition,
        descendant: source,
        confidence: 'exact',
        proof: {
          sessionId: rendererSurfaceTarget.sessionId ?? '',
          frameId: rendererSurfaceTarget.frameId ?? '',
          componentRevision: rendererSurfaceTarget.componentRevision ?? '',
        },
      });
      return validation.status === 'valid'
        ? {
            status: 'valid' as const,
            // The guard contract carries the full SourceRef (including line
            // and column) needed by the existing editors. Renderer validation
            // proves the range but intentionally returns the narrower wire
            // range, so keep the already-validated SourceRef supplied by the
            // resolver.
            source,
          }
        : { status: 'refused' as const, reason: validation.reason };
    },
    [index, rendererSurfaceTarget, selectedComponent]
  );

  const rendererSurfaceMatchesSelectedFrame =
    !!rendererSurfaceTarget &&
    !!selectedRendererFrame &&
    rendererSurfaceTarget.sessionId === selectedRendererFrame.sessionId &&
    rendererSurfaceTarget.frameId === selectedRendererFrame.frameId &&
    rendererSurfaceTarget.componentId === selectedRendererFrame.componentId &&
    rendererSurfaceTarget.componentRevision === selectedRendererFrame.componentRevision;
  // The shared Elements tree accepts messages through the same authenticated
  // target transport. A current tree/selection response is therefore a
  // verified inspection-ready signal even if the host's separate `ready`
  // lifecycle event was missed. It never bypasses the target identity check.
  const rendererInspectionEnabled = rendererInspectionIsReady(
    rendererFrameState,
    rendererSurfaceMatchesSelectedFrame,
    componentInspectionReady
  );
  const rendererWriteEnabled =
    rendererInspectionEnabled &&
    editMainConfirmed &&
    rendererSurfaceTarget?.capabilities.editing === true;

  // Text and structural editing share the selected renderer's authenticated
  // inspection transport. Inspection remains available before Edit main is
  // confirmed; the separate write gate keeps inline text and structural
  // shortcuts disabled until confirmation and a renderer editing capability.
  const rendererTextEditing = useTextEditing({
    iframeRef: rendererIframeRef,
    surfaceTarget: rendererSurfaceTarget,
    projectPath,
    enabled: rendererInspectionEnabled,
    writeEnabled: rendererWriteEnabled,
    onToast,
    sourceEditGuard: rendererSourceEditGuard,
  });
  const rendererStructure = useElementStructure({
    iframeRef: rendererIframeRef,
    surfaceTarget: rendererSurfaceTarget,
    projectPath,
    enabled: rendererInspectionEnabled,
    writeEnabled: rendererWriteEnabled,
    onToast,
    sourceEditGuard: rendererSourceEditGuard,
  });
  const rendererToolbarGeometry = useMemo(() => {
    const structureSelection = rendererStructure.selection;
    if (
      !rendererWriteEnabled ||
      !rendererSurfaceMatchesSelectedFrame ||
      rendererFrameState !== 'ready' ||
      rendererFrameError ||
      rendererCircuitOpen ||
      rendererStructure.textEditing ||
      !structureSelection?.rect ||
      !rendererFrameElement ||
      !selectedNode
    ) {
      return null;
    }

    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!viewportRect) return null;

    const mappedSelection = mapSelectionRectToComponentsViewport({
      selectionRect: structureSelection.rect,
      iframeRect: rendererFrameElement.getBoundingClientRect(),
      iframeClientSize: {
        width: rendererFrameElement.clientWidth,
        height: rendererFrameElement.clientHeight,
      },
      viewportRect,
      rotation: nodeRotation(selectedNode),
    });
    if (!mappedSelection) return null;

    return {
      selection: { ...structureSelection, rect: mappedSelection },
      bounds: { w: viewportRect.width, h: viewportRect.height },
    };
  }, [
    rendererCircuitOpen,
    rendererFrameElement,
    rendererFrameError,
    rendererFrameState,
    rendererStructure.selection,
    rendererSurfaceMatchesSelectedFrame,
    rendererStructure.textEditing,
    rendererWriteEnabled,
    selectedNode,
    viewportSize,
  ]);
  const rendererStructureActions = useMemo<TreeStructureActions | null>(() => {
    // Keep the Elements tree inspectable before Edit main, but do not publish
    // mutation callbacks to the singleton panel until the negotiated frame is
    // actually writable. An omitted structure model is intentionally
    // read-only; disabled-looking actions still invite a mutation attempt.
    if (!rendererWriteEnabled) return null;
    return {
      selectAndRun: rendererStructure.selectAndRun,
      insert: (position, kind) => void rendererStructure.insert(position, kind),
      duplicate: () => void rendererStructure.duplicate(),
      remove: () => void rendererStructure.remove(),
      copy: () => void rendererStructure.copy(),
      cut: () => void rendererStructure.cut(),
      paste: () => void rendererStructure.paste(),
      hasClipboard: rendererStructure.hasClipboard,
      clipboardSourceNodeId: rendererStructure.clipboardSourceNodeId,
    };
  }, [
    rendererWriteEnabled,
    rendererStructure.clipboardSourceNodeId,
    rendererStructure.copy,
    rendererStructure.cut,
    rendererStructure.duplicate,
    rendererStructure.hasClipboard,
    rendererStructure.insert,
    rendererStructure.paste,
    rendererStructure.remove,
    rendererStructure.selectAndRun,
  ]);

  // Publish one model to the workspace-level Elements owner. The cleanup is
  // intentional: frame/session/revision changes and unmount must not leave a
  // detached frame's actions active in the singleton panel.
  useEffect(() => {
    onTreeStructureActionsChange?.(rendererStructureActions);
  }, [onTreeStructureActionsChange, rendererStructureActions]);
  useEffect(() => () => onTreeStructureActionsChange?.(null), [onTreeStructureActionsChange]);

  const rendererEditorEnabled =
    rendererFrameState === 'ready' &&
    qualifiedEditorMode === 'tailwind' &&
    rendererSurfaceTarget?.capabilities.editing === true;
  const rendererCssEditorEnabled =
    rendererFrameState === 'ready' &&
    qualifiedEditorMode === 'css' &&
    rendererSurfaceTarget?.capabilities.editing === true;
  const activeRendererBreakpoint = useMemo<Breakpoint>(() => {
    const requested = rendererBreakpointOverride ?? selectedRendererFrame?.presentation.breakpoint;
    return editorBreakpoints.find((breakpoint) => breakpoint.name === requested) ?? BASE_BREAKPOINT;
  }, [
    editorBreakpoints,
    rendererBreakpointOverride,
    selectedRendererFrame?.presentation.breakpoint,
  ]);
  const rendererBreakpointTooWide =
    activeRendererBreakpoint.minPx > 0 &&
    (selectedRendererFrame?.presentation.width ?? 0) < activeRendererBreakpoint.minPx;
  const rendererEditor = useVisualEditor({
    iframeRef: rendererIframeRef,
    surfaceTarget: rendererSurfaceTarget,
    projectPath,
    enabled: rendererEditorEnabled,
    editMode: visualEditorActive,
    onEditModeChange: onVisualEditorActiveChange,
    // Inspection is authenticated and read-only before Edit main is confirmed.
    inspectionEnabled: rendererInspectionEnabled,
    writeEnabled: editMainConfirmed,
    activeBreakpoint: activeRendererBreakpoint,
    breakpoints: editorBreakpoints,
    onToast,
    sourceEditGuard: rendererSourceEditGuard,
  });
  const selectRendererElement = rendererEditor.selectElement;
  const rendererCssVariables = useCssVariables({
    iframeRef: rendererIframeRef,
    projectPath,
    enabled: rendererInspectionEnabled,
    onToast,
    onVariableDeleted: rendererEditor.reconcileDeletedVariable,
  });
  const openRendererSource = useCallback(
    (file: string, line: number) => {
      const source = sourceRefFromResolution(rendererEditor.selection?.resolution ?? null);
      // VisualEditorPanel gives us the resolved identity it displayed. Refuse
      // stale or guessed locations rather than constructing a new source ref
      // from the callback's file/line pair.
      if (!source || source.file !== file || source.line !== line) return;
      onOpenSource(source);
    },
    [onOpenSource, rendererEditor.selection?.resolution]
  );
  const rendererCssEditor = useCssCascadeEditor({
    iframeRef: rendererIframeRef,
    surfaceTarget: rendererSurfaceTarget,
    projectPath,
    enabled: rendererCssEditorEnabled,
    editMode: visualEditorActive,
    onEditModeChange: onVisualEditorActiveChange,
    // CSS cascade data is available as soon as the negotiated frame is ready;
    // the confirmation gate only controls source/preview mutations.
    inspectionEnabled: rendererInspectionEnabled,
    writeEnabled: editMainConfirmed,
    cssModulesHint: projectType === 'nextjs',
    onToast,
    sourceEditGuard: rendererSourceEditGuard,
    sourceBoundary: selectedComponent?.definition ?? null,
  });
  const rendererEditMode = rendererEditor.editMode || rendererCssEditor.editMode;
  const toggleRendererEditMode =
    qualifiedEditorMode === 'css'
      ? rendererCssEditor.toggleEditMode
      : rendererEditor.toggleEditMode;
  const rendererElementSettings = useElementSettings({
    iframeRef: rendererIframeRef,
    surfaceTarget: rendererSurfaceTarget,
    projectPath,
    enabled: rendererCssEditor.editMode,
    signature: rendererCssEditor.selection?.signature ?? null,
    onToast,
    sourceEditGuard: rendererSourceEditGuard,
  });
  const rendererCssAnimations = useCssAnimations({
    projectPath,
    enabled: rendererCssEditor.editMode,
    onToast,
    sourceEditGuard: rendererSourceEditGuard,
  });
  const [rendererCssScope, setRendererCssScope] = useState<'style' | 'settings' | 'animations'>(
    'style'
  );

  // The Elements panel is owned by the workspace shell. Keep its negotiated
  // target and selected signature as derived outputs of this canvas, rather
  // than letting the panel reach into renderer internals.
  useEffect(() => {
    onRendererTargetChange?.(rendererSurfaceTarget);
  }, [onRendererTargetChange, rendererSurfaceTarget]);

  // The canvas can leave Components mode (or fail before the main return
  // branch) without another target render. Clear the workspace-level owner on
  // teardown so its Elements model cannot retain a detached frame.
  useEffect(
    () => () => {
      onRendererTargetChange?.(null);
      onRendererFrameElementChange?.(null);
    },
    [onRendererFrameElementChange, onRendererTargetChange]
  );

  useEffect(() => {
    if (!elementTreeSelection) {
      setRendererElementSelection(null);
      return;
    }
    if (elementTreeSelection.signature) {
      setRendererElementSelection({
        signature: elementTreeSelection.signature,
        sourceRange: null,
      });
    }
  }, [elementTreeSelection]);

  useEffect(() => {
    if (!rendererElementSelection) return;
    if (!rendererInspectionEnabled || !rendererSurfaceTarget) return;

    // The Elements panel can be used before either editor's edit-mode toggle is
    // opened. Replay its authenticated selection as soon as the renderer has
    // completed its handshake so the existing editor hooks populate their
    // selection/read-only state immediately. Waiting for edit mode here left a
    // tree-selected descendant stranded in the pending state, so the component style state only
    // saw the frame loading/prompt state instead of the same controls Preview
    // shows. This is still inspection-only: the separate Edit-main/write gates
    // remain owned by the editor hooks and the shared edit panel.
    if (qualifiedEditorMode === 'css') {
      // CSS mode consumes the same authenticated runtime selection path. The
      // generated host reselects by bounded domPath/signature and emits the
      // regular ss:select payload that populates the existing cascade panel.
      postToEditableSurface(rendererSurfaceTarget, {
        type: 'ss:reselect',
        signature: rendererElementSelection.signature,
      });
      setRendererElementSelection(null);
      return;
    }
    if (qualifiedEditorMode === 'tailwind') {
      selectRendererElement(rendererElementSelection.signature);
      setRendererElementSelection(null);
      return;
    }
    // Keep an unsupported-mode selection pending only until the renderer's
    // editor qualification resolves. No source range or root fallback is
    // inferred here.
  }, [
    rendererElementSelection,
    rendererInspectionEnabled,
    postToEditableSurface,
    qualifiedEditorMode,
    rendererSurfaceTarget,
    selectRendererElement,
  ]);

  useEffect(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    // Keep selection when changing scope only if the same node still exists.
    setSelectedNodeIds((current) => {
      const next = current.filter((id) => visibleIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleNodes]);

  useEffect(() => {
    if (scope === 'all' || !selectedComponent || visibleNodes.length === 0) return;
    const firstNode = visibleNodes.find((node) => node.componentId === selectedComponent.id);
    if (!firstNode) return;
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    setSelectedNodeIds((current) => {
      if (current.length > 0 && current.every((id) => visibleIds.has(id))) {
        return current;
      }
      return [firstNode.id];
    });
  }, [scope, selectedComponent, visibleNodes]);

  const camera = document.scopes[scope].camera;
  rendererStageZoomRef.current = camera.zoom;
  const mountedNodes = useMemo(
    () =>
      orderCanvasNodesForPaint(
        cullCanvasNodes(visibleNodes, camera, viewportSize, [
          ...selectedNodeIds,
          ...liveRendererNodeIds,
        ])
      ),
    [camera, liveRendererNodeIds, selectedNodeIds, viewportSize, visibleNodes]
  );
  const viewportNodeIds = useMemo(
    () => new Set(cullCanvasNodes(visibleNodes, camera, viewportSize).map((node) => node.id)),
    [camera, viewportSize, visibleNodes]
  );
  const rendererLifecycleCandidates = useMemo(() => {
    if (!rendererSession) return [];
    const mountedNodeIds = new Set(mountedNodes.map((node) => node.id));
    return visibleNodes.flatMap((node, index) => {
      const frame = rendererFrames.get(node.id);
      if (!frame) return [];
      const rendererVersion = rendererRouteSegment ?? COMPONENT_RENDERER_INTEGRATION_VERSION;
      const snapshotKey = rendererFrameSnapshotKey(frame, rendererVersion);
      const actuallyVisible = viewportNodeIds.has(node.id);
      if (actuallyVisible || node.id === selectedNodeId) {
        rendererSnapshotDeferredRef.current.delete(node.id);
      } else if (rendererSnapshotDeferredRef.current.get(node.id) === snapshotKey) {
        // A frame whose crop was outside the visible application window is
        // deferred until the user pans to it or selects it. Omitting it from
        // the lifecycle candidates releases its live slot for other cards.
        return [];
      }
      return [
        {
          node,
          visible: actuallyVisible || mountedNodeIds.has(node.id),
          distanceToViewportCenter: index,
          selected: node.id === selectedNodeId,
          recentlyUsedAt: rendererLastAccessedAtRef.current.get(node.id) ?? 0,
          needsSnapshot:
            !rendererSnapshotCacheRef.current.getExact(node.id, snapshotKey) &&
            rendererSnapshotFailedRef.current.get(node.id) !== snapshotKey,
          snapshotKey,
          cachedSnapshotKey: rendererSnapshotCacheRef.current.get(node.id)?.snapshotKey,
        },
      ];
    });
    // The access and snapshot versions invalidate ref-backed inputs used by the
    // scheduler. They are intentionally not read from the candidate payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mountedNodes,
    rendererAccessVersion,
    rendererFrames,
    rendererRouteSegment,
    rendererSession,
    rendererSnapshotVersion,
    selectedNodeId,
    visibleNodes,
    viewportNodeIds,
  ]);
  useEffect(() => {
    const previous = rendererLifecycleRef.current.snapshot();
    const candidatesById = new Map(
      rendererLifecycleCandidates.map((candidate) => [candidate.node.id, candidate])
    );
    // Queue posters while the lifecycle still considers outgoing frames live.
    // The previous ordering evicted them first, so an unrelated React render
    // could paint the parent loading overlay over the iframe before capture.
    const liveFramesNeedingSnapshots = previous.liveFrameIds.filter((nodeId) => {
      const candidate = candidatesById.get(nodeId);
      return (
        candidate?.needsSnapshot === true &&
        candidate.snapshotKey !== undefined &&
        !rendererSnapshotCacheRef.current.getExact(nodeId, candidate.snapshotKey)
      );
    });
    captureRendererSnapshots(liveFramesNeedingSnapshots);
    rendererLifecycleRef.current.setCandidates(rendererLifecycleCandidates);
    rendererLifecycleRef.current.setActiveFrame(selectedNodeId);
    for (const frameId of rendererLifecycleRef.current.consumeCancelledRequestIds()) {
      rendererPublishedFrameKeysRef.current.delete(frameId);
      rendererPublishedFrameReloadKeysRef.current.delete(frameId);
      rendererPublishedFrameRetryNoncesRef.current.delete(frameId);
    }
    const snapshot = rendererLifecycleRef.current.snapshot();
    const nextLiveRendererNodeIds = [...snapshot.liveFrameIds, ...snapshot.queuedFrameIds];
    const nextLiveRendererNodeIdSet = new Set(nextLiveRendererNodeIds);
    if (rendererSnapshotPendingRef.current.size > 0) return;
    // mountedNodes intentionally keeps live/queued cards in the DOM. Avoid
    // feeding an equivalent newly allocated array back into that dependency
    // chain, otherwise lifecycle -> mountedNodes -> candidates can recurse
    // until React trips Maximum update depth exceeded.
    setLiveRendererNodeIds((current) =>
      current.length === nextLiveRendererNodeIdSet.size &&
      current.every((nodeId) => nextLiveRendererNodeIdSet.has(nodeId))
        ? current
        : nextLiveRendererNodeIds
    );
    setRendererCircuitOpen(
      selectedNodeId
        ? (rendererLifecycleRef.current.stateFor(selectedNodeId)?.circuitOpen ?? false)
        : false
    );
  }, [
    captureRendererSnapshots,
    liveRendererNodeIds,
    rendererLifecycleCandidates,
    rendererSnapshotVersion,
    selectedNodeId,
  ]);
  useEffect(() => {
    rendererPerformanceRef.current.setTopology({
      mountedNodes: mountedNodes.length,
      liveIframes: liveRendererNodeIds.length,
    });
  }, [liveRendererNodeIds.length, mountedNodes.length]);
  const rendererPerformance = rendererPerformanceRef.current.snapshot();
  const cameraRef = useRef<CanvasCameraState>(camera);
  cameraRef.current = camera;
  const commitCameraFrame = useCallback(
    (next: CanvasCameraState) => {
      if (!canInteractWithCanvas()) return;
      rendererPerformanceRef.current.markTransform(
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      );
      cameraRef.current = next;
      pendingCameraRef.current = next;
      if (cameraFrameRef.current !== null) return;
      const flush = () => {
        cameraFrameRef.current = null;
        const pending = pendingCameraRef.current;
        pendingCameraRef.current = null;
        if (!pending) return;
        const current = documentRef.current;
        publishCanvasDocument(
          {
            ...current,
            scopes: { ...current.scopes, [scope]: { ...current.scopes[scope], camera: pending } },
          },
          'transient',
          'Persist canvas camera'
        );
      };
      cameraFrameRef.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : window.setTimeout(flush, 16);
    },
    [canInteractWithCanvas, publishCanvasDocument, scope]
  );
  const cancelCameraAnimation = useCallback(() => {
    cameraAnimationCancelRef.current?.();
    cameraAnimationCancelRef.current = null;
  }, []);
  const updateCamera = useCallback(
    (next: CanvasCameraState) => {
      rendererPerformanceRef.current.markInput(
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      );
      cancelCameraAnimation();
      commitCameraFrame(next);
    },
    [cancelCameraAnimation, commitCameraFrame]
  );
  const animateToCamera = useCallback(
    (next: CanvasCameraState) => {
      cancelCameraAnimation();
      if (
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        updateCamera(next);
        return;
      }
      cameraAnimationCancelRef.current = animateCamera(cameraRef.current, next, {
        onFrame: commitCameraFrame,
        onComplete: () => {
          cameraAnimationCancelRef.current = null;
        },
      });
    },
    [cancelCameraAnimation, commitCameraFrame, updateCamera]
  );

  useEffect(() => {
    return () => {
      cancelCameraAnimation();
      cameraPanCleanupRef.current?.();
      if (cameraFrameRef.current !== null) {
        if (typeof cancelAnimationFrame === 'function')
          cancelAnimationFrame(cameraFrameRef.current);
        else window.clearTimeout(cameraFrameRef.current);
        cameraFrameRef.current = null;
      }
      pendingCameraRef.current = null;
    };
  }, [cancelCameraAnimation]);

  useEffect(() => {
    // Navigation identity is also an explicit refocus request: the same row
    // can be clicked again after the user has panned or zoomed away.
    if (previousNavigationRef.current !== navigation) {
      previousNavigationRef.current = navigation;
      focusedCameraKeyRef.current = null;
    }
    if (
      scope !== 'focus' ||
      navigation.scope !== 'focus' ||
      !selectedComponent ||
      (navigation.componentId !== undefined && navigation.componentId !== selectedComponent.id) ||
      visibleNodes.length === 0
    ) {
      focusedCameraKeyRef.current = null;
      return;
    }
    const key = `${selectedComponent.id}:${visibleNodes[0]?.id ?? ''}:${Math.round(viewportSize.width)}:${Math.round(viewportSize.height)}`;
    if (focusedCameraKeyRef.current === key || viewportSize.width <= 1 || viewportSize.height <= 1)
      return;
    focusedCameraKeyRef.current = key;
    animateToCamera(
      fitBounds(boundsForNodes(visibleNodes), {
        x: 0,
        y: 0,
        width: viewportSize.width,
        height: viewportSize.height,
      })
    );
  }, [animateToCamera, navigation, scope, selectedComponent, viewportSize, visibleNodes]);

  const fitScene = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (!viewport) return;
    updateCamera(
      fitBounds(boundsForNodes(visibleNodes), {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      })
    );
  }, [canInteractWithCanvas, updateCamera, visibleNodes]);

  const fitSelection = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    const selection = visibleNodes.filter((node) => selectedNodeIds.includes(node.id));
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (selection.length === 0 || !viewport) return;
    updateCamera(
      fitBounds(boundsForNodes(selection), {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      })
    );
  }, [canInteractWithCanvas, selectedNodeIds, updateCamera, visibleNodes]);

  const beginCanvasTransaction = useCallback(
    (label: string) => {
      if (!canInteractWithCanvas()) return null;
      canvasPersistenceSchedulerRef.current.beginTransaction();
      const transaction = canvasHistoryRef.current.begin(label);
      activeCanvasTransactionRef.current = transaction;
      activeCanvasTransactionProjectPathRef.current = currentProjectPathRef.current;
      return transaction;
    },
    [canInteractWithCanvas]
  );

  const applyCanvasDocument = useCallback(
    (next: CanvasDocumentV2) => publishCanvasDocument(next, 'current', 'Apply canvas state'),
    [publishCanvasDocument]
  );

  const recordCanvasDocument = useCallback(
    (label: string, update: (current: CanvasDocumentV2) => CanvasDocumentV2) => {
      if (!canInteractWithCanvas()) return;
      const before = documentRef.current;
      const after = update(before);
      if (after === before) return;
      publishCanvasDocument(after, 'history', label);
      persistCommittedCanvasDocument(after);
    },
    [canInteractWithCanvas, persistCommittedCanvasDocument, publishCanvasDocument]
  );

  const updateCanvasGuides = useCallback(
    (guides: ComponentCanvasGuide[]) => {
      if (!canInteractWithCanvas()) return;
      recordCanvasDocument('Update canvas guides', (current) => ({
        ...current,
        guides,
      }));
    },
    [canInteractWithCanvas, recordCanvasDocument]
  );

  const deleteSelectedGuide = useCallback(() => {
    if (!canInteractWithCanvas() || !selectedGuideId) return;
    const currentGuides = documentRef.current.guides ?? [];
    const selectedGuide = currentGuides.find((guide) => guide.id === selectedGuideId);
    if (!selectedGuide) {
      setSelectedGuideId(null);
      return;
    }
    if (selectedGuide.locked) return;
    updateCanvasGuides(currentGuides.filter((guide) => guide.id !== selectedGuideId));
    setSelectedGuideId(null);
  }, [canInteractWithCanvas, selectedGuideId, updateCanvasGuides]);

  const layerNodes = useMemo(() => {
    const focusedId = selectedComponent?.id;
    return document.nodes
      .filter(
        (node) =>
          node.scope === scope &&
          (scope === 'all' || node.componentId === focusedId) &&
          componentsById.has(node.componentId)
      )
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }, [componentsById, document.nodes, scope, selectedComponent?.id]);

  const canvasLayers = useMemo(
    () =>
      layerNodes.map((node) => {
        const extension = nodeLayerExtension(node);
        const component = componentsById.get(node.componentId);
        const preset = node.presetId
          ? presetStore.presets.find((candidate) => candidate.id === node.presetId)
          : undefined;
        const expandedIds = document.scopes[scope].expandedComponentIds;
        return {
          id: node.id,
          name: extension.name ?? preset?.name ?? component?.name ?? node.componentId,
          parentId: nodeParentId(node),
          visible: nodeIsVisible(node),
          locked: extension.locked === true,
          expanded: expandedIds.length === 0 ? true : expandedIds.includes(node.id),
        };
      }),
    [componentsById, document.scopes, layerNodes, presetStore.presets, scope]
  );

  const updateLayerNode = useCallback(
    (nodeId: string, label: string, patch: Partial<CanvasInteractionNode>) => {
      if (!canInteractWithCanvas()) return;
      recordCanvasDocument(label, (current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? ({ ...node, ...patch } as ComponentCanvasNode) : node
        ),
      }));
    },
    [canInteractWithCanvas, recordCanvasDocument]
  );

  const onLayerSelectionChange = useCallback(
    (ids: string[]) => {
      if (!canInteractWithCanvas()) return;
      if (ids[0]) markRendererNodeAccessed(ids[0]);
      setSelectedNodeIds(ids);
      const node = layerNodes.find((candidate) => candidate.id === ids[0]);
      if (node) setSelectedComponentId(node.componentId);
    },
    [canInteractWithCanvas, layerNodes, markRendererNodeAccessed]
  );

  const onLayerToggleExpanded = useCallback(
    (nodeId: string, expanded: boolean) => {
      if (!canInteractWithCanvas()) return;
      recordCanvasDocument('Toggle canvas layer expansion', (current) => {
        const existingIds = current.scopes[scope].expandedComponentIds;
        const expandedIds = new Set(
          expanded
            ? existingIds
            : existingIds.length === 0
              ? layerNodes.map((node) => node.id)
              : existingIds
        );
        if (expanded) expandedIds.add(nodeId);
        else expandedIds.delete(nodeId);
        return {
          ...current,
          scopes: {
            ...current.scopes,
            [scope]: {
              ...current.scopes[scope],
              expandedComponentIds: [...expandedIds],
            },
          },
        };
      });
    },
    [canInteractWithCanvas, layerNodes, recordCanvasDocument, scope]
  );

  const onLayerDropIntent = useCallback(
    (intent: CanvasLayerDropIntent) => {
      if (!canInteractWithCanvas()) return;
      const dragged = layerNodes.find((node) => node.id === intent.draggedId);
      const target = layerNodes.find((node) => node.id === intent.targetId);
      if (
        !dragged ||
        !target ||
        !canMutateCanvasNode(dragged.id, documentRef.current.nodes) ||
        isCanvasNodeEffectivelyLocked(target.id, documentRef.current.nodes)
      )
        return;
      recordCanvasDocument('Reorder canvas layer', (current) => {
        const result = reorderCanvasLayerNodes(current.nodes, intent);
        return result.accepted ? { ...current, nodes: result.nodes } : current;
      });
    },
    [canInteractWithCanvas, layerNodes, recordCanvasDocument]
  );

  const onLayerRename = useCallback(
    (nodeId: string, name: string) => updateLayerNode(nodeId, 'Rename canvas layer', { name }),
    [updateLayerNode]
  );
  const onLayerToggleVisibility = useCallback(
    (nodeId: string, visible: boolean) =>
      updateLayerNode(nodeId, 'Toggle canvas layer visibility', { visible }),
    [updateLayerNode]
  );
  const onLayerToggleLock = useCallback(
    (nodeId: string, locked: boolean) =>
      updateLayerNode(nodeId, 'Toggle canvas layer lock', { locked }),
    [updateLayerNode]
  );

  const elementsPanelCanvasLayers = useMemo<ElementsPanelCanvasLayers>(
    () => ({
      layers: canvasLayers,
      selectedIds: selectedNodeIds,
      onSelectionChange: onLayerSelectionChange,
      onToggleExpanded: onLayerToggleExpanded,
      onRename: onLayerRename,
      onToggleVisibility: onLayerToggleVisibility,
      onToggleLock: onLayerToggleLock,
      onDropIntent: onLayerDropIntent,
    }),
    [
      canvasLayers,
      onLayerDropIntent,
      onLayerRename,
      onLayerSelectionChange,
      onLayerToggleExpanded,
      onLayerToggleLock,
      onLayerToggleVisibility,
      selectedNodeIds,
    ]
  );

  useEffect(() => {
    onCanvasLayersChange?.(canvasInteractive ? elementsPanelCanvasLayers : null);
  }, [canvasInteractive, elementsPanelCanvasLayers, onCanvasLayersChange]);
  useEffect(() => () => onCanvasLayersChange?.(null), [onCanvasLayersChange]);

  const finishCanvasTransaction = useCallback(
    (commit: boolean) => {
      const transaction = activeCanvasTransactionRef.current;
      if (!transaction) return;
      if (
        !canInteractWithCanvas() ||
        activeCanvasTransactionProjectPathRef.current !== currentProjectPathRef.current
      ) {
        return;
      }
      const next = commit ? transaction.commit() : transaction.abort();
      activeCanvasTransactionRef.current = null;
      activeCanvasTransactionProjectPathRef.current = null;
      applyCanvasDocument(next);
      // Both paths are authoritative writes. In particular, abort must flush
      // the rollback immediately so a long gesture can never leave its
      // intermediate geometry in storage when Escape is followed by a switch
      // or unmount.
      persistCommittedCanvasDocument(next);
    },
    [applyCanvasDocument, canInteractWithCanvas, persistCommittedCanvasDocument]
  );

  const abortCanvasGesture = useCallback(() => {
    cameraPanCleanupRef.current?.();
    finishCanvasTransaction(false);
    const pointerCapture = canvasPointerCaptureRef.current;
    if (pointerCapture?.element.hasPointerCapture(pointerCapture.pointerId)) {
      pointerCapture.element.releasePointerCapture(pointerCapture.pointerId);
    }
    canvasPointerCaptureRef.current = null;
    dragRef.current = null;
    resizeRef.current = null;
    rotationRef.current = null;
    suppressNodeClickRef.current = false;
    setMarquee(null);
    setSnapGuides([]);
  }, [finishCanvasTransaction]);

  const resetZoom = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (!viewport) return;
    const currentCamera = cameraRef.current;
    updateCamera(zoomAt(currentCamera, { x: viewport.width / 2, y: viewport.height / 2 }, 1));
  }, [canInteractWithCanvas, updateCamera]);

  const setZoomAtViewportCenter = useCallback(
    (nextZoom: number) => {
      if (!canInteractWithCanvas()) return false;
      const viewport = viewportRef.current?.getBoundingClientRect();
      if (!viewport) return false;
      const currentCamera = cameraRef.current;
      updateCamera(
        zoomAt(
          currentCamera,
          { x: viewport.width / 2, y: viewport.height / 2 },
          quantizeZoom(nextZoom)
        )
      );
      return true;
    },
    [canInteractWithCanvas, updateCamera]
  );

  const zoomCameraAtViewportCenter = useCallback(
    (factor: number) => setZoomAtViewportCenter(cameraRef.current.zoom * factor),
    [setZoomAtViewportCenter]
  );
  const resetLayout = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    recordCanvasDocument('Reset canvas layout', (current) => ({
      ...current,
      nodes: arrangeUnlockedCanvasNodes(current.nodes),
      scopes: {
        focus: { ...current.scopes.focus, camera: { x: 0, y: 0, zoom: 1 } },
        variants: { ...current.scopes.variants, camera: { x: 0, y: 0, zoom: 1 } },
        all: { ...current.scopes.all, camera: { x: 0, y: 0, zoom: 1 } },
      },
    }));
  }, [canInteractWithCanvas, recordCanvasDocument]);

  const arrangeAll = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    recordCanvasDocument('Arrange all canvas nodes', (current) => ({
      ...current,
      nodes: arrangeUnlockedCanvasNodes(current.nodes),
    }));
  }, [canInteractWithCanvas, recordCanvasDocument]);

  const stopRenderer = useCallback(async () => {
    if (!canvasInteractive) return;
    const activeSessionId = rendererSessionIdRef.current ?? rendererSessionId;
    if (!activeSessionId) return;
    const owningProjectPath = rendererSessionProjectPathRef.current;
    rendererSessionIdRef.current = null;
    rendererPublishedFrameKeysRef.current.clear();
    rendererPublishedFrameReloadKeysRef.current.clear();
    rendererPublishedFrameRetryNoncesRef.current.clear();
    rendererSnapshotEpochRef.current += 1;
    rendererSnapshotPendingRef.current.clear();
    rendererSnapshotFailedRef.current.clear();
    rendererSnapshotDeferredRef.current.clear();
    rendererSnapshotQueueRef.current = [];
    if (rendererSurfaceTarget) {
      deactivateEditableSurface(rendererSurfaceTarget);
      onRendererFrameElementChange?.(null);
    }
    rendererFrameElementsRef.current.clear();
    setRendererSnapshotVersion((version) => version + 1);
    setRendererSessionState('stopping');
    try {
      await stopComponentRendererSession(owningProjectPath, activeSessionId);
      await cleanupComponentRendererSession(owningProjectPath, activeSessionId);
    } finally {
      setRendererSessionId(null);
      setRendererSession(null);
      setRendererRouteSegment(null);
      setSetupSession(null);
      setSetupPlan(null);
      setSetupPhase('review');
      setRendererFrameState('idle');
      setRendererFrameError(null);
      setRendererSurfaceTarget(null);
      setRendererFrameElement(null);
      setRendererEditContext(null);
      setRendererElementSelection(null);
      setRendererSnapshotPath(null);
      setRendererSnapshotError(null);
      setRendererSnapshotState('idle');
      rendererA11yRequestIdRef.current = null;
      if (rendererA11yTimeoutRef.current !== null) {
        window.clearTimeout(rendererA11yTimeoutRef.current);
        rendererA11yTimeoutRef.current = null;
      }
      setRendererA11yFindings([]);
      setRendererA11yError(null);
      setRendererA11yState('idle');
      setRendererSessionState('stopped');
    }
  }, [canvasInteractive, onRendererFrameElementChange, rendererSessionId, rendererSurfaceTarget]);

  const resetRendererSetup = useCallback(async () => {
    if (!canInteractWithCanvas()) return;
    if (rendererSessionId) {
      await stopRenderer();
      return;
    }
    if (setupSession) {
      await stopComponentRendererSession(projectPath, setupSession.sessionId);
    }
    setSetupSession(null);
    setSetupPlan(null);
    setSetupPhase('review');
    setSetupError(null);
  }, [canInteractWithCanvas, projectPath, rendererSessionId, setupSession, stopRenderer]);

  const disableRenderer = useCallback(async () => {
    if (!canInteractWithCanvas()) return;
    if (rendererSessionId) await stopRenderer();
    if (setupSession) {
      await stopComponentRendererSession(projectPath, setupSession.sessionId).catch(
        () => undefined
      );
    }
    await revokeComponentRendererConsent(projectPath);
    setRendererConsent(null);
    setRendererConsentProjectPath(projectPath);
    setSetupOpen(false);
    setSetupSession(null);
    setSetupPlan(null);
    setSetupPhase('review');
    setSetupError(null);
    autoSetupAttemptRef.current = null;
  }, [canInteractWithCanvas, projectPath, rendererSessionId, setupSession, stopRenderer]);

  useEffect(() => {
    // Preparing a host creates a live session before the user confirms file
    // installation. Closing the modal must not strand that session; if the
    // async preparation finishes after close, this effect still reclaims it.
    if (setupOpen || rendererSessionId || !setupSession || setupPhase === 'ready') return;
    void resetRendererSetup();
  }, [rendererSessionId, resetRendererSetup, setupOpen, setupPhase, setupSession]);

  const arrangeSelection = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (selectedNodeIds.length === 0) return;
    if (
      !documentRef.current.nodes.some(
        (node) =>
          selectedNodeIds.includes(node.id) &&
          canMutateCanvasNode(node.id, documentRef.current.nodes)
      )
    )
      return;
    recordCanvasDocument('Arrange selected canvas nodes', (current) => ({
      ...current,
      nodes: arrangeUnlockedCanvasNodes(current.nodes, selectedNodeIds),
    }));
  }, [canInteractWithCanvas, recordCanvasDocument, selectedNodeIds]);

  const duplicateSelected = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (selectedNodeIds.length === 0) return;
    let duplicatedIds: string[] = [];
    recordCanvasDocument('Duplicate canvas selection', (current) => {
      const result = duplicateCanvasSelection(current.nodes, selectedNodeIds);
      duplicatedIds = result.affectedIds;
      if (result.refused) setVariantNotice('Some selected canvas nodes could not be duplicated.');
      return duplicatedIds.length > 0 ? { ...current, nodes: result.nodes } : current;
    });
    if (duplicatedIds.length > 0) {
      setSelectedNodeIds(duplicatedIds);
      const duplicate = documentRef.current.nodes.find((node) => node.id === duplicatedIds[0]);
      if (duplicate) setSelectedComponentId(duplicate.componentId);
      if (
        rendererSurfaceTarget?.frameId &&
        !duplicatedIds.includes(rendererSurfaceTarget.frameId)
      ) {
        deactivateEditableSurface(rendererSurfaceTarget);
        setRendererSurfaceTarget(null);
        setRendererEditContext(null);
        setRendererElementSelection(null);
        setRendererFrameElement(null);
      }
    }
  }, [canInteractWithCanvas, recordCanvasDocument, rendererSurfaceTarget, selectedNodeIds]);

  const deleteSelected = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (selectedNodeIds.length === 0) return;
    let deletedIds: string[] = [];
    recordCanvasDocument('Delete canvas selection', (current) => {
      const result = deleteCanvasSelection(current.nodes, selectedNodeIds);
      deletedIds = result.affectedIds;
      if (result.refused) {
        setVariantNotice('Some selected canvas nodes could not be deleted.');
      }
      return deletedIds.length > 0 ? { ...current, nodes: result.nodes } : current;
    });
    if (deletedIds.length > 0) {
      setSelectedNodeIds((ids) => ids.filter((id) => !deletedIds.includes(id)));
      if (rendererSurfaceTarget?.frameId && deletedIds.includes(rendererSurfaceTarget.frameId)) {
        deactivateEditableSurface(rendererSurfaceTarget);
        setRendererSurfaceTarget(null);
        setRendererEditContext(null);
        setRendererElementSelection(null);
        setRendererFrameElement(null);
      }
    }
  }, [canInteractWithCanvas, recordCanvasDocument, rendererSurfaceTarget, selectedNodeIds]);

  const selectedPreset = selectedNode?.presetId
    ? (presetStore.presets.find((preset) => preset.id === selectedNode.presetId) ?? null)
    : null;
  const [draftPresetProps, setDraftPresetProps] = useState<Record<string, StaticValue>>({});
  const [draftPresetSlots, setDraftPresetSlots] = useState<Record<string, string>>({});
  const presetStoreRef = useRef(presetStore);
  presetStoreRef.current = presetStore;
  const propPreviewTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    // Keep the rename field aligned with the selected saved test case.
    setPresetName(selectedPreset?.name ?? '');
  }, [selectedPreset]);

  useEffect(() => {
    Object.values(propPreviewTimersRef.current).forEach(clearTimeout);
    propPreviewTimersRef.current = {};
    setDraftPresetProps(selectedPreset?.props ?? {});
    setDraftPresetSlots(selectedPreset?.slots ?? {});
  }, [selectedPreset]);

  useEffect(
    () => () => {
      Object.values(propPreviewTimersRef.current).forEach(clearTimeout);
    },
    []
  );
  useEffect(() => {
    Object.values(propPreviewTimersRef.current).forEach(clearTimeout);
    propPreviewTimersRef.current = {};
  }, [projectPath]);

  const commitPresetUpdate = useCallback(
    (presetId: string, update: (preset: ComponentPreviewPreset) => ComponentPreviewPreset) => {
      if (!canInteractWithCanvas()) return;
      const current = presetStoreRef.current;
      const source = current.presets.find((preset) => preset.id === presetId);
      if (!source) return;
      const updated = update(source);
      const next = {
        ...current,
        presets: current.presets.map((preset) => (preset.id === presetId ? updated : preset)),
      };
      presetStoreRef.current = next;
      setPresetStore(next);
      writeComponentPreviewPresetStore(
        localStorage,
        next,
        componentPreviewPresetStorageKey(projectPath)
      );
    },
    [canInteractWithCanvas, projectPath]
  );

  const createPresetFromSelectedFrame = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (!selectedComponent || !selectedNode || selectedPreset) return;
    const created = createComponentPreviewPreset(selectedComponent, index?.revision);
    const next = {
      ...presetStoreRef.current,
      presets: [...presetStoreRef.current.presets, created],
    };
    presetStoreRef.current = next;
    setPresetStore(next);
    writeComponentPreviewPresetStore(
      localStorage,
      next,
      componentPreviewPresetStorageKey(projectPath)
    );
    recordCanvasDocument('Create canvas preset', (current) => {
      const existing = current.nodes.some((node) => node.id === selectedNode.id);
      const nextNode = existing
        ? null
        : nodeForPreset(
            selectedComponent,
            created.id,
            selectedNode.scope,
            current.nodes.length,
            sharedCanvasFrameSize(current.nodes, selectedComponent.id)
          );
      const nodes = existing
        ? current.nodes.map((node) =>
            node.id === selectedNode.id ? { ...node, presetId: created.id, generated: false } : node
          )
        : autoLayoutCanvasNodes([...current.nodes, nextNode!]);
      setSelectedNodeIds([existing ? selectedNode.id : nextNode!.id]);
      return { ...current, nodes };
    });
  }, [
    index?.revision,
    canInteractWithCanvas,
    projectPath,
    recordCanvasDocument,
    selectedComponent,
    selectedNode,
    selectedPreset,
  ]);

  const updateSelectedPresetProp = useCallback(
    (prop: ComponentPropDescriptor, value: StaticValue | undefined) => {
      if (!canInteractWithCanvas()) return;
      if (!selectedPreset) return;
      setDraftPresetProps((current) => {
        const next = { ...current };
        if (value === undefined) delete next[prop.name];
        else next[prop.name] = value;
        return next;
      });
      const timerKey = `${selectedPreset.id}:prop:${prop.name}`;
      const previous = propPreviewTimersRef.current[timerKey];
      if (previous) clearTimeout(previous);
      const commit = () =>
        commitPresetUpdate(selectedPreset.id, (preset) => {
          const props = { ...preset.props };
          if (value === undefined) delete props[prop.name];
          else props[prop.name] = value;
          return { ...preset, props };
        });
      if (prop.control === 'text' || prop.control === 'number') {
        propPreviewTimersRef.current[timerKey] = setTimeout(
          commit,
          COMPONENT_PROP_PREVIEW_DEBOUNCE_MS
        );
      } else {
        commit();
      }
    },
    [canInteractWithCanvas, commitPresetUpdate, selectedPreset]
  );

  const updateSelectedPresetSlot = useCallback(
    (slotName: string, value: string) => {
      if (!canInteractWithCanvas()) return;
      if (!selectedPreset) return;
      setDraftPresetSlots((current) => ({ ...current, [slotName]: value }));
      const timerKey = `${selectedPreset.id}:slot:${slotName}`;
      const previous = propPreviewTimersRef.current[timerKey];
      if (previous) clearTimeout(previous);
      propPreviewTimersRef.current[timerKey] = setTimeout(() => {
        commitPresetUpdate(selectedPreset.id, (preset) => ({
          ...preset,
          slots: { ...preset.slots, [slotName]: value },
        }));
      }, COMPONENT_PROP_PREVIEW_DEBOUNCE_MS);
    },
    [canInteractWithCanvas, commitPresetUpdate, selectedPreset]
  );

  const renameSelectedPreset = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (!selectedPreset) return;
    const next = {
      ...presetStore,
      presets: presetStore.presets.map((preset) =>
        preset.id === selectedPreset.id
          ? { ...preset, name: presetName.trim().slice(0, 128) || preset.name }
          : preset
      ),
    };
    presetStoreRef.current = next;
    setPresetStore(next);
    writeComponentPreviewPresetStore(
      localStorage,
      next,
      componentPreviewPresetStorageKey(projectPath)
    );
  }, [canInteractWithCanvas, presetName, presetStore, projectPath, selectedPreset]);

  const duplicateSelectedPreset = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (!selectedPreset || !selectedNode || !selectedComponent) return;
    const result = duplicateComponentPreviewPreset(presetStore, selectedPreset.id);
    if (!result.preset) return;
    presetStoreRef.current = result.store;
    setPresetStore(result.store);
    writeComponentPreviewPresetStore(
      localStorage,
      result.store,
      componentPreviewPresetStorageKey(projectPath)
    );
    recordCanvasDocument('Duplicate canvas preset', (current) => ({
      ...current,
      nodes: autoLayoutCanvasNodes([
        ...current.nodes,
        nodeForPreset(
          selectedComponent,
          result.preset!.id,
          selectedNode.scope,
          current.nodes.length,
          sharedCanvasFrameSize(current.nodes, selectedComponent.id)
        ),
      ]),
    }));
  }, [
    canInteractWithCanvas,
    presetStore,
    projectPath,
    recordCanvasDocument,
    selectedComponent,
    selectedNode,
    selectedPreset,
  ]);

  const deleteSelectedPreset = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (!selectedPreset) return;
    const next = deleteComponentPreviewPreset(presetStore, selectedPreset.id);
    presetStoreRef.current = next;
    setPresetStore(next);
    writeComponentPreviewPresetStore(
      localStorage,
      next,
      componentPreviewPresetStorageKey(projectPath)
    );
    recordCanvasDocument('Delete canvas preset', (current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.presetId !== selectedPreset.id),
    }));
    setSelectedNodeIds((ids) => ids.filter((id) => id !== selectedNode?.id));
  }, [
    canInteractWithCanvas,
    presetStore,
    projectPath,
    recordCanvasDocument,
    selectedNode?.id,
    selectedPreset,
  ]);

  const generateFiniteVariants = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (!selectedComponent || scope !== 'variants') return;
    const result = expandFiniteVariantMatrix(selectedComponent, {
      componentId: selectedComponent.id,
      presentation: { background: 'surface', breakpoint: null, locale: null },
    });
    if (result.refused) {
      setVariantNotice(
        `This matrix would create ${result.prospectiveCount} variants; the limit is 48.`
      );
      return;
    }
    if (result.variants.length === 0) {
      setVariantNotice('No parser-proven finite variant choices are available.');
      return;
    }
    setGeneratedVariants((current) => ({
      ...current,
      [selectedComponent.id]: result.variants,
    }));
    recordCanvasDocument('Generate finite canvas variants', (current) => {
      const explicit = current.nodes.filter(
        (node) =>
          !(
            node.scope === 'variants' &&
            node.componentId === selectedComponent.id &&
            node.generated
          )
      );
      const frameSize = sharedCanvasFrameSize(current.nodes, selectedComponent.id);
      const generatedNodes = frameSize
        ? result.nodes.map((node) => ({
            ...node,
            width: frameSize.width,
            height: frameSize.height,
            sizeMode: frameSize.sizeMode,
          }))
        : result.nodes;
      const next = ensureCanvasNodeLimit([...explicit, ...generatedNodes]);
      if (next.refused > 0) {
        setVariantNotice(`${next.refused} generated nodes were refused at the canvas limit.`);
      } else {
        setVariantNotice(`Generated ${result.prospectiveCount} finite variants.`);
      }
      return { ...current, nodes: autoLayoutCanvasNodes(next.nodes) };
    });
  }, [canInteractWithCanvas, recordCanvasDocument, scope, selectedComponent]);

  const prospectiveVariantCount = useMemo(() => {
    if (!selectedComponent || scope !== 'variants') return 0;
    return expandFiniteVariantMatrix(selectedComponent, {
      componentId: selectedComponent.id,
      presentation: { background: 'surface', breakpoint: null, locale: null },
    }).prospectiveCount;
  }, [scope, selectedComponent]);

  const undoCanvas = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (activeCanvasTransactionRef.current) abortCanvasGesture();
    if (!canvasHistoryRef.current.canUndo) return;
    const next = canvasHistoryRef.current.undo();
    applyCanvasDocument(next);
    persistCommittedCanvasDocument(next);
  }, [
    abortCanvasGesture,
    applyCanvasDocument,
    canInteractWithCanvas,
    persistCommittedCanvasDocument,
  ]);

  const redoCanvas = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    if (activeCanvasTransactionRef.current) abortCanvasGesture();
    if (!canvasHistoryRef.current.canRedo) return;
    const next = canvasHistoryRef.current.redo();
    applyCanvasDocument(next);
    persistCommittedCanvasDocument(next);
  }, [
    abortCanvasGesture,
    applyCanvasDocument,
    canInteractWithCanvas,
    persistCommittedCanvasDocument,
  ]);

  useCommands(
    () => [
      {
        id: 'components.focusSelected',
        title: 'Focus selected component',
        icon: <ComponentsIcon size={14} />,
        category: 'navigation' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && !!selectedComponent,
        run: () => onNavigate({ componentId: selectedComponent?.id, scope: 'focus' }),
      },
      {
        id: 'components.showVariants',
        title: 'Show component variants',
        icon: <ComponentsIcon size={14} />,
        category: 'navigation' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && !!selectedComponent,
        run: () => onNavigate({ componentId: selectedComponent?.id, scope: 'variants' }),
      },
      {
        id: 'components.showAll',
        title: 'Show all components',
        icon: <ComponentsIcon size={14} />,
        category: 'navigation' as const,
        when: 'project' as const,
        run: () => onNavigate({ scope: 'all' }),
      },
      {
        id: 'components.fitCanvas',
        title: 'Fit Components canvas',
        icon: <ComponentsIcon size={14} />,
        category: 'navigation' as const,
        when: 'project' as const,
        run: fitScene,
      },
      {
        id: 'components.resetZoom',
        title: 'Reset Components zoom',
        icon: <ResetIcon size={14} />,
        category: 'navigation' as const,
        when: 'project' as const,
        run: resetZoom,
      },
      {
        id: 'components.resetLayout',
        title: 'Reset Components layout',
        icon: <ResetIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        run: resetLayout,
      },
      {
        id: 'components.undo',
        title: 'Undo Components canvas change',
        icon: <UndoIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        run: undoCanvas,
      },
      {
        id: 'components.redo',
        title: 'Redo Components canvas change',
        icon: <RedoIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        run: redoCanvas,
      },
      {
        id: 'components.arrangeAll',
        title: 'Arrange all component frames',
        icon: <ComponentsIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        run: arrangeAll,
      },
      {
        id: 'components.arrangeSelection',
        title: 'Arrange selected component frames',
        icon: <ComponentsIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && selectedNodeIds.length > 0,
        run: arrangeSelection,
      },
      {
        id: 'components.duplicateSelected',
        title: 'Duplicate selected component frame',
        icon: <ComponentsIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && selectedNodeIds.length > 0,
        run: duplicateSelected,
      },
      {
        id: 'components.deleteSelected',
        title: 'Delete selected canvas frame',
        icon: <ResetIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && selectedNodeIds.length > 0,
        run: deleteSelected,
      },
      {
        id: 'components.captureSnapshot',
        title: 'Capture selected component snapshot',
        icon: <ComponentsIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) =>
          kind === 'project' && rendererFrameState === 'ready' && !!rendererFrameElement,
        run: () => void captureSnapshot(),
      },
      {
        id: 'components.runAccessibility',
        title: 'Inspect selected component accessibility',
        icon: <ComponentsIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) =>
          kind === 'project' &&
          rendererFrameState === 'ready' &&
          !!rendererSurfaceTarget?.capabilities.accessibility,
        run: runAccessibility,
      },
      {
        id: 'components.stopRenderer',
        title: 'Stop Components renderer',
        icon: <ResetIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) =>
          kind === 'project' && canvasInteractive && !!rendererSessionId,
        run: () => void stopRenderer(),
      },
      {
        id: 'components.enableRenderer',
        title: 'Enable Components live previews',
        icon: <ComponentsIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) =>
          kind === 'project' &&
          projectType === 'nextjs' &&
          rendererConsentLoaded &&
          !rendererConsent,
        run: () => {
          if (canvasInteractive) setSetupOpen(true);
        },
      },
      {
        id: 'components.disableRenderer',
        title: 'Disable Components live previews',
        icon: <ResetIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) =>
          kind === 'project' &&
          projectType === 'nextjs' &&
          rendererConsentLoaded &&
          !!rendererConsent,
        run: () => void disableRenderer(),
      },
    ],
    [
      arrangeSelection,
      arrangeAll,
      redoCanvas,
      deleteSelected,
      duplicateSelected,
      fitScene,
      onNavigate,
      resetLayout,
      resetZoom,
      undoCanvas,
      captureSnapshot,
      rendererFrameElement,
      rendererFrameState,
      rendererSurfaceTarget,
      runAccessibility,
      selectedComponent,
      selectedNodeIds.length,
      rendererSessionId,
      stopRenderer,
      disableRenderer,
      projectType,
      rendererConsent,
      rendererConsentLoaded,
      canvasInteractive,
    ]
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      if (!canInteractWithCanvas()) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const currentCamera = cameraRef.current;
      if (event.ctrlKey || event.metaKey)
        updateCamera(zoomBy(currentCamera, point, wheelZoomDelta(event.deltaY)));
      else updateCamera(pan(currentCamera, wheelPanDelta(event.deltaX, event.deltaY)));
    },
    [canInteractWithCanvas, updateCamera]
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [canvasInteractive, onWheel]);

  const beginCameraPan = useCallback(
    (event: PointerEvent) => {
      const viewport = viewportRef.current;
      if (!viewport || !canInteractWithCanvas()) return;
      const isSpacePan = event.button === 0 && spaceHeldRef.current;
      if (event.button !== 1 && !isSpacePan) return;

      cameraPanCleanupRef.current?.();
      event.preventDefault();
      event.stopPropagation();
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in a few embedded browser surfaces;
        // the window listeners below still keep the gesture alive.
      }

      let lastX = event.clientX;
      let lastY = event.clientY;
      const win = viewport.ownerDocument.defaultView ?? window;
      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = {
          x: moveEvent.clientX - lastX,
          y: moveEvent.clientY - lastY,
        };
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        const currentCamera = cameraRef.current;
        // The legacy Grida surface scales hand-tool drag deltas by the
        // current transform scale before translating the camera.
        updateCamera(
          pan(currentCamera, {
            x: delta.x * currentCamera.zoom,
            y: delta.y * currentCamera.zoom,
          })
        );
        moveEvent.preventDefault();
        moveEvent.stopPropagation();
      };
      const onPointerUp = () => cleanup();
      const cleanup = () => {
        win.removeEventListener('pointermove', onPointerMove, true);
        win.removeEventListener('pointerup', onPointerUp, true);
        win.removeEventListener('pointercancel', onPointerUp, true);
        try {
          if (viewport.hasPointerCapture(event.pointerId)) {
            viewport.releasePointerCapture(event.pointerId);
          }
        } catch {
          // The pointer may already have been released by the browser.
        }
        if (cameraPanCleanupRef.current === cleanup) cameraPanCleanupRef.current = null;
        canvasPointerCaptureRef.current = null;
        setCameraPanActive(false);
      };

      cameraPanCleanupRef.current = cleanup;
      canvasPointerCaptureRef.current = { element: viewport, pointerId: event.pointerId };
      setCameraPanActive(true);
      win.addEventListener('pointermove', onPointerMove, true);
      win.addEventListener('pointerup', onPointerUp, true);
      win.addEventListener('pointercancel', onPointerUp, true);
    },
    [canInteractWithCanvas, updateCamera]
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener('pointerdown', beginCameraPan, true);
    return () => {
      viewport.removeEventListener('pointerdown', beginCameraPan, true);
      cameraPanCleanupRef.current?.();
    };
  }, [beginCameraPan, canvasInteractive]);

  const nudgeSelection = useCallback(
    (dx: number, dy: number, amount: number) => {
      if (!canInteractWithCanvas()) return;
      if (selectedNodeIds.length === 0) return;
      const selected = new Set(
        normalizeCanvasHierarchySelection(selectedNodeIds, documentRef.current.nodes).ids
      );
      if (
        !documentRef.current.nodes.some(
          (node) => selected.has(node.id) && canMutateCanvasNode(node.id, documentRef.current.nodes)
        )
      )
        return;
      recordCanvasDocument('Nudge canvas selection', (current) => ({
        ...current,
        nodes: nudgeCanvasSelection(current.nodes, selectedNodeIds, dx, dy, amount),
      }));
    },
    [canInteractWithCanvas, recordCanvasDocument, selectedNodeIds]
  );

  const selectSibling = useCallback(
    (direction: -1 | 1) => {
      if (!canInteractWithCanvas()) return;
      if (visibleNodes.length === 0) return;
      const currentIndex = Math.max(
        0,
        visibleNodes.findIndex((node) => node.id === selectedNodeIds[0])
      );
      const next =
        visibleNodes[(currentIndex + direction + visibleNodes.length) % visibleNodes.length];
      if (next) {
        setSelectedNodeIds([next.id]);
        setSelectedComponentId(next.componentId);
      }
    },
    [canInteractWithCanvas, selectedNodeIds, visibleNodes]
  );

  const selectParent = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    const current = visibleNodes.find((node) => node.id === selectedNodeIds[0]);
    const parentId = current ? nodeParentId(current) : null;
    const parent = parentId ? visibleNodes.find((node) => node.id === parentId) : undefined;
    if (!parent) return;
    setSelectedNodeIds([parent.id]);
    setSelectedComponentId(parent.componentId);
  }, [canInteractWithCanvas, selectedNodeIds, visibleNodes]);

  const selectChild = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    const current = visibleNodes.find((node) => node.id === selectedNodeIds[0]);
    if (!current) return;
    const child = visibleNodes.find((node) => nodeParentId(node) === current.id);
    if (!child) return;
    setSelectedNodeIds([child.id]);
    setSelectedComponentId(child.componentId);
  }, [canInteractWithCanvas, selectedNodeIds, visibleNodes]);

  const moveSelectionZOrder = useCallback(
    (direction: -1 | 1, toEdge = false) => {
      if (!canInteractWithCanvas()) return;
      if (selectedNodeIds.length === 0) return;
      recordCanvasDocument(
        direction > 0 ? 'Bring canvas node forward' : 'Send canvas node backward',
        (current) => {
          const nodes = reorderCanvasZOrder(current.nodes, selectedNodeIds, direction, toEdge);
          return nodes.every((node, index) => node === current.nodes[index])
            ? current
            : { ...current, nodes };
        }
      );
    },
    [canInteractWithCanvas, recordCanvasDocument, selectedNodeIds]
  );
  const bringSelectionForward = useCallback(() => moveSelectionZOrder(1), [moveSelectionZOrder]);
  const sendSelectionBackward = useCallback(() => moveSelectionZOrder(-1), [moveSelectionZOrder]);
  const bringSelectionToFront = useCallback(
    () => moveSelectionZOrder(1, true),
    [moveSelectionZOrder]
  );
  const sendSelectionToBack = useCallback(
    () => moveSelectionZOrder(-1, true),
    [moveSelectionZOrder]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!canInteractWithCanvas()) return;
      if (
        selectedGuideId &&
        !shouldIgnoreCanvasKeyboardEvent(event) &&
        (event.key === 'Delete' || event.key === 'Backspace')
      ) {
        event.preventDefault();
        deleteSelectedGuide();
        return;
      }
      if (shouldIgnoreCanvasKeyboardEvent(event)) return;
      if (event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        setRulersVisible((current) => !current);
        return;
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        selectParent();
        return;
      }
      if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        selectChild();
        return;
      }
      const intent = mapCanvasKeyboardIntent(event);
      if (intent) {
        event.preventDefault();
        switch (intent.type) {
          case 'select-all':
            setSelectedNodeIds(visibleNodes.map((node) => node.id));
            return;
          case 'duplicate':
            duplicateSelected();
            return;
          case 'delete':
            deleteSelected();
            return;
          case 'escape':
            if (activeCanvasTransactionRef.current || marquee) abortCanvasGesture();
            else setSelectedNodeIds([]);
            setContextNodeId(null);
            setSelectedGuideId(null);
            setContextMenuOpen(false);
            return;
          case 'undo':
            undoCanvas();
            return;
          case 'redo':
            redoCanvas();
            return;
          case 'bring-forward':
            bringSelectionForward();
            return;
          case 'send-backward':
            sendSelectionBackward();
            return;
          case 'bring-to-front':
            bringSelectionToFront();
            return;
          case 'send-to-back':
            sendSelectionToBack();
            return;
          case 'move':
            nudgeSelection(
              Math.sign(intent.dx),
              Math.sign(intent.dy),
              Math.max(Math.abs(intent.dx), Math.abs(intent.dy))
            );
            return;
        }
      }
      if (event.key === '[') {
        event.preventDefault();
        selectSibling(-1);
        return;
      }
      if (event.key === ']') {
        event.preventDefault();
        selectSibling(1);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoCanvas();
        return;
      }
    },
    [
      abortCanvasGesture,
      bringSelectionForward,
      bringSelectionToFront,
      canInteractWithCanvas,
      deleteSelected,
      deleteSelectedGuide,
      duplicateSelected,
      marquee,
      nudgeSelection,
      redoCanvas,
      sendSelectionBackward,
      sendSelectionToBack,
      selectSibling,
      selectChild,
      selectParent,
      selectedGuideId,
      undoCanvas,
      visibleNodes,
    ]
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const ownerDocument = viewport.ownerDocument;
    let pointerOver = false;
    const onPointerEnter = () => {
      pointerOver = true;
    };
    const onPointerLeave = () => {
      pointerOver = false;
    };
    const isAttended = () => {
      const activeElement = ownerDocument.activeElement;
      return (
        pointerOver ||
        (!!activeElement &&
          activeElement !== ownerDocument.body &&
          viewport.contains(activeElement))
      );
    };
    const onCameraKeyDown = (event: KeyboardEvent) => {
      if (!canInteractWithCanvas() || !isAttended()) return;
      if (isCanvasTextInputTarget(ownerDocument.activeElement)) return;

      if (event.code === 'Space' && !event.repeat) {
        spaceHeldRef.current = true;
        setSpacePanHeld(true);
        event.preventDefault();
        return;
      }

      const modifier = event.metaKey || event.ctrlKey;
      if (event.shiftKey && !modifier && (event.code === 'Digit0' || event.code === 'Numpad0')) {
        resetZoom();
        event.preventDefault();
      } else if (
        event.shiftKey &&
        !modifier &&
        (event.code === 'Digit1' ||
          event.code === 'Digit9' ||
          event.code === 'Numpad1' ||
          event.code === 'Numpad9')
      ) {
        fitScene();
        event.preventDefault();
      } else if (
        event.shiftKey &&
        !modifier &&
        (event.code === 'Digit2' || event.code === 'Numpad2')
      ) {
        fitSelection();
        event.preventDefault();
      } else if (modifier && (event.code === 'Equal' || event.code === 'NumpadAdd')) {
        zoomCameraAtViewportCenter(CANVAS_KEYBOARD_ZOOM_STEP);
        event.preventDefault();
      } else if (modifier && (event.code === 'Minus' || event.code === 'NumpadSubtract')) {
        zoomCameraAtViewportCenter(1 / CANVAS_KEYBOARD_ZOOM_STEP);
        event.preventDefault();
      }
    };
    const onCameraKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceHeldRef.current = false;
      setSpacePanHeld(false);
    };

    viewport.addEventListener('pointerenter', onPointerEnter);
    viewport.addEventListener('pointerleave', onPointerLeave);
    ownerDocument.addEventListener('keydown', onCameraKeyDown);
    ownerDocument.addEventListener('keyup', onCameraKeyUp);
    return () => {
      viewport.removeEventListener('pointerenter', onPointerEnter);
      viewport.removeEventListener('pointerleave', onPointerLeave);
      ownerDocument.removeEventListener('keydown', onCameraKeyDown);
      ownerDocument.removeEventListener('keyup', onCameraKeyUp);
      cameraPanCleanupRef.current?.();
      spaceHeldRef.current = false;
      setSpacePanHeld(false);
    };
  }, [
    canvasInteractive,
    canInteractWithCanvas,
    fitScene,
    fitSelection,
    resetZoom,
    zoomCameraAtViewportCenter,
  ]);

  const onAuxClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) event.preventDefault();
  }, []);

  const startCanvasGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!canInteractWithCanvas()) return;
      setSelectedGuideId(null);
      // Screen-space controls (for example the renderer setup banner) sit
      // inside the canvas viewport so they can track it, but they are not
      // canvas gestures. Let their own click/pointer handlers receive the
      // event without the marquee handler calling preventDefault().
      if (isCanvasScreenOverlayTarget(event.target)) return;
      if (event.button !== 0 || spaceHeldRef.current) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-component-canvas-node="true"]')) {
        return;
      }
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const currentCamera = cameraRef.current;
      const point = screenToWorld(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        currentCamera
      );
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      canvasPointerCaptureRef.current = {
        element: event.currentTarget,
        pointerId: event.pointerId,
      };
      setMarquee({ start: point, current: point, shiftKey: event.shiftKey });
    },
    [canInteractWithCanvas]
  );

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, handle: CanvasResizeHandle) => {
      if (!canInteractWithCanvas()) return;
      const normalizedIds = normalizeCanvasHierarchySelection(
        selectedNodeIds,
        documentRef.current.nodes
      ).ids;
      const node = visibleNodes.find((candidate) => normalizedIds.includes(candidate.id));
      const rect = viewportRef.current?.getBoundingClientRect();
      if (
        !node ||
        !canMutateCanvasNode(node.id, documentRef.current.nodes) ||
        normalizedIds.length !== 1 ||
        !rect
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      canvasPointerCaptureRef.current = {
        element: event.currentTarget,
        pointerId: event.pointerId,
      };
      beginCanvasTransaction(handle === 'rotate' ? 'Rotate canvas node' : 'Resize canvas node');
      const currentCamera = cameraRef.current;
      if (handle === 'rotate') {
        const center = worldToScreen(
          { x: node.x + node.width / 2, y: node.y + node.height / 2 },
          currentCamera
        );
        rotationRef.current = {
          nodeId: node.id,
          center,
          startAngle: Math.atan2(
            event.clientY - rect.top - center.y,
            event.clientX - rect.left - center.x
          ),
          origin: nodeRotation(node),
          moved: false,
        };
        return;
      }
      resizeRef.current = {
        nodeId: node.id,
        handle,
        start: screenToWorld(
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          currentCamera
        ),
        origin: node,
        moved: false,
      };
    },
    [beginCanvasTransaction, canInteractWithCanvas, selectedNodeIds, visibleNodes]
  );

  const startResizeKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, handle: CanvasResizeHandle) => {
      if (!canInteractWithCanvas()) return;
      const normalizedIds = normalizeCanvasHierarchySelection(
        selectedNodeIds,
        documentRef.current.nodes
      ).ids;
      const node = visibleNodes.find((candidate) => normalizedIds.includes(candidate.id));
      const documentNode = node
        ? documentRef.current.nodes.find((candidate) => candidate.id === node.id)
        : undefined;
      if (
        !node ||
        !documentNode ||
        normalizedIds.length !== 1 ||
        !canMutateCanvasNode(documentNode.id, documentRef.current.nodes)
      )
        return;
      const step = event.shiftKey ? 32 : 8;
      beginCanvasTransaction(handle === 'rotate' ? 'Rotate canvas node' : 'Resize canvas node');
      const updatedNodes = documentRef.current.nodes.map((candidate) => {
        if (candidate.id !== node.id) return candidate;
        if (handle === 'rotate') {
          const direction = event.key === 'Enter' ? 1 : -1;
          return { ...candidate, rotation: nodeRotation(candidate) + direction * 15 };
        }
        const west = handle.includes('west');
        const north = handle.includes('north');
        const east = handle.includes('east');
        const south = handle.includes('south');
        const width = Math.max(
          COMPONENT_CANVAS_MIN_WIDTH,
          Math.min(COMPONENT_CANVAS_MAX_WIDTH, candidate.width + (east ? step : west ? -step : 0))
        );
        const height = candidate.height + (south ? step : north ? -step : 0);
        const world = canvasNodeWorldPosition(candidate.id, documentRef.current.nodes);
        const nextWorld = {
          x: west ? world.x + candidate.width - width : world.x,
          y: north ? world.y + candidate.height - height : world.y,
        };
        const local = canvasWorldToLocalPosition(
          candidate.id,
          nextWorld,
          documentRef.current.nodes
        );
        return {
          ...candidate,
          ...local,
          width,
          height,
          sizeMode: 'fixed' as const,
        };
      });
      const resizedNode = updatedNodes.find((candidate) => candidate.id === node.id);
      const next = {
        ...documentRef.current,
        nodes:
          handle === 'rotate' || !resizedNode
            ? updatedNodes
            : syncComponentCanvasFrameSize(
                updatedNodes,
                resizedNode.componentId,
                resizedNode.width,
                resizedNode.height
              ),
      };
      activeCanvasTransactionRef.current?.update(next);
      applyCanvasDocument(next);
      finishCanvasTransaction(true);
    },
    [
      applyCanvasDocument,
      beginCanvasTransaction,
      canInteractWithCanvas,
      finishCanvasTransaction,
      selectedNodeIds,
      visibleNodes,
    ]
  );

  const startMove = useCallback(
    (event: React.PointerEvent, node: ComponentCanvasNode) => {
      if (!canInteractWithCanvas()) return;
      if (
        event.button !== 0 ||
        spaceHeldRef.current ||
        !canMutateCanvasNode(node.id, documentRef.current.nodes)
      )
        return;
      // Selection is a pointer-down intent, matching the reference surface:
      // the title/outline/ruler range switch before the first drag frame. The
      // synthetic click that follows pointer-up is suppressed so modifiers do
      // not apply the same toggle twice.
      const additive = event.metaKey || event.ctrlKey || event.shiftKey;
      suppressNodeClickRef.current = true;
      setSelectedNodeIds((current) =>
        additive
          ? current.includes(node.id)
            ? current.filter((id) => id !== node.id)
            : [...current, node.id]
          : [node.id]
      );
      setSelectedComponentId(node.componentId);
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (event.currentTarget instanceof HTMLElement) {
        canvasPointerCaptureRef.current = {
          element: event.currentTarget,
          pointerId: event.pointerId,
        };
      }
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const currentCamera = cameraRef.current;
      const normalizedIds = normalizeCanvasHierarchySelection(
        selectedNodeIds,
        documentRef.current.nodes
      ).ids;
      const nextIds =
        selectedNodeIds.includes(node.id) && normalizedIds.length > 0 ? normalizedIds : [node.id];
      const point = screenToWorld(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        currentCamera
      );
      const origin = Object.fromEntries(
        visibleNodes
          .filter((candidate) => nextIds.includes(candidate.id))
          .map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }])
      );
      beginCanvasTransaction('Move canvas node');
      dragRef.current = {
        nodeIds: nextIds,
        start: point,
        origin,
        moved: false,
        additive,
      };
    },
    [beginCanvasTransaction, canInteractWithCanvas, selectedNodeIds, visibleNodes]
  );

  const moveNode = useCallback(
    (event: React.PointerEvent) => {
      if (!canInteractWithCanvas()) return;
      const rotation = rotationRef.current;
      const resize = resizeRef.current;
      const rect = viewportRef.current?.getBoundingClientRect();
      const currentCamera = cameraRef.current;
      if (rotation && rect) {
        const angle = Math.atan2(
          event.clientY - rect.top - rotation.center.y,
          event.clientX - rect.left - rotation.center.x
        );
        const delta = ((angle - rotation.startAngle) * 180) / Math.PI;
        const raw = rotation.origin + delta;
        const nextRotation = event.shiftKey ? Math.round(raw / 15) * 15 : raw;
        rotation.moved = rotation.moved || Math.abs(delta) >= CANVAS_DRAG_THRESHOLD_PX;
        const next = {
          ...documentRef.current,
          nodes: documentRef.current.nodes.map((node) =>
            node.id === rotation.nodeId
              ? ({ ...node, rotation: nextRotation } as ComponentCanvasNode)
              : node
          ),
        };
        activeCanvasTransactionRef.current?.update(next);
        applyCanvasDocument(next);
        return;
      }
      if (resize && rect) {
        const point = screenToWorld(
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          currentCamera
        );
        const dx = point.x - resize.start.x;
        const dy = point.y - resize.start.y;
        const west = resize.handle.includes('west');
        const north = resize.handle.includes('north');
        const east = resize.handle.includes('east');
        const south = resize.handle.includes('south');
        let width = Math.max(
          COMPONENT_CANVAS_MIN_WIDTH,
          Math.min(COMPONENT_CANVAS_MAX_WIDTH, resize.origin.width + (east ? dx : west ? -dx : 0))
        );
        let height = resize.origin.height + (south ? dy : north ? -dy : 0);
        if (event.altKey) {
          if (west || east)
            width = Math.max(
              COMPONENT_CANVAS_MIN_WIDTH,
              Math.min(COMPONENT_CANVAS_MAX_WIDTH, resize.origin.width + Math.abs(dx) * 2)
            );
          if (north || south) height = resize.origin.height + Math.abs(dy) * 2;
        }
        if (event.shiftKey) {
          const aspect = resize.origin.width / Math.max(1, resize.origin.height);
          if (Math.abs(dx) >= Math.abs(dy)) height = width / aspect;
          else
            width = Math.max(
              COMPONENT_CANVAS_MIN_WIDTH,
              Math.min(COMPONENT_CANVAS_MAX_WIDTH, height * aspect)
            );
        }
        resize.moved = resize.moved || Math.hypot(dx, dy) >= CANVAS_DRAG_THRESHOLD_PX;
        const updatedNodes = documentRef.current.nodes.map((node) => {
          if (node.id !== resize.nodeId) return node;
          const world = {
            x: event.altKey
              ? resize.origin.x + (resize.origin.width - width) / 2
              : west
                ? resize.origin.x + resize.origin.width - width
                : resize.origin.x,
            y: event.altKey
              ? resize.origin.y + (resize.origin.height - height) / 2
              : north
                ? resize.origin.y + resize.origin.height - height
                : resize.origin.y,
          };
          const local = canvasWorldToLocalPosition(node.id, world, documentRef.current.nodes);
          return { ...node, ...local, width, height, sizeMode: 'fixed' as const };
        });
        const resizedNode = updatedNodes.find((node) => node.id === resize.nodeId);
        const next = {
          ...documentRef.current,
          nodes: resizedNode
            ? syncComponentCanvasFrameSize(
                updatedNodes,
                resizedNode.componentId,
                resizedNode.width,
                resizedNode.height
              )
            : updatedNodes,
        };
        activeCanvasTransactionRef.current?.update(next);
        applyCanvasDocument(next);
        setSnapGuides([]);
        return;
      }
      if (marquee && rect) {
        setMarquee({
          ...marquee,
          current: screenToWorld(
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            currentCamera
          ),
        });
        return;
      }
      const drag = dragRef.current;
      if (!drag || !rect) return;
      const point = screenToWorld(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        currentCamera
      );
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      if (!drag.moved && Math.hypot(delta.x, delta.y) < CANVAS_DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      const activeNode = visibleNodes.find((node) => drag.nodeIds.includes(node.id));
      const peers = visibleNodes
        .filter((node) => !drag.nodeIds.includes(node.id))
        .map((node) => ({ ...rectFromNode(node), nodeId: node.id }));
      const snap = activeNode
        ? snapCanvasRect(
            {
              ...rectFromNode(activeNode),
              x: drag.origin[activeNode.id].x + delta.x,
              y: drag.origin[activeNode.id].y + delta.y,
            },
            peers,
            {
              zoom: currentCamera.zoom,
              ctrlKey: event.ctrlKey,
              guides: documentRef.current.guides?.map((guide) => ({
                ...guide,
                kind: 'guide' as const,
              })),
            }
          )
        : null;
      const snappedDelta =
        snap && activeNode
          ? {
              x: snap.rect.x - drag.origin[activeNode.id].x,
              y: snap.rect.y - drag.origin[activeNode.id].y,
            }
          : delta;
      setSnapGuides(snap?.guides ?? []);
      const next = {
        ...documentRef.current,
        nodes: documentRef.current.nodes.map((node) =>
          drag.nodeIds.includes(node.id) && drag.origin[node.id]
            ? (() => {
                const world = {
                  x: drag.origin[node.id].x + snappedDelta.x,
                  y: drag.origin[node.id].y + snappedDelta.y,
                };
                const local = canvasWorldToLocalPosition(node.id, world, documentRef.current.nodes);
                return { ...node, x: local.x, y: local.y };
              })()
            : node
        ),
      };
      activeCanvasTransactionRef.current?.update(next);
      applyCanvasDocument(next);
    },
    [applyCanvasDocument, canInteractWithCanvas, marquee, visibleNodes]
  );

  const stopMove = useCallback(() => {
    if (!canInteractWithCanvas()) return;
    cameraPanCleanupRef.current?.();
    if (marquee) {
      const rect = normalizeCanvasRect(marquee);
      const ids = visibleNodes
        .filter((node) => canvasRectContains(rect, node))
        .map((node) => node.id);
      setSelectedNodeIds((current) =>
        marquee.shiftKey ? [...new Set([...current, ...ids])] : ids.length > 0 ? ids : []
      );
      setMarquee(null);
    }
    setSnapGuides([]);
    const drag = dragRef.current;
    const resize = resizeRef.current;
    const rotation = rotationRef.current;
    if (drag) {
      finishCanvasTransaction(drag.moved);
      if (drag.moved) {
        suppressNodeClickRef.current = true;
        setSelectedNodeIds((current) =>
          drag.additive ? [...new Set([...current, ...drag.nodeIds])] : drag.nodeIds
        );
        const movedNode = visibleNodes.find((node) => node.id === drag.nodeIds[0]);
        if (movedNode) setSelectedComponentId(movedNode.componentId);
      }
    } else if (resize) finishCanvasTransaction(resize.moved);
    else if (rotation) finishCanvasTransaction(rotation.moved);
    resizeRef.current = null;
    rotationRef.current = null;
    dragRef.current = null;
    canvasPointerCaptureRef.current = null;
  }, [canInteractWithCanvas, finishCanvasTransaction, marquee, visibleNodes]);

  const selectNode = useCallback(
    (nodeId: string, event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
      if (!canInteractWithCanvas()) return;
      if (suppressNodeClickRef.current) {
        suppressNodeClickRef.current = false;
        return;
      }
      if (rendererSurfaceTarget && rendererSurfaceTarget.frameId !== nodeId) {
        deactivateEditableSurface(rendererSurfaceTarget);
        setRendererSurfaceTarget(null);
        setRendererEditContext(null);
      }
      markRendererNodeAccessed(nodeId);
      setSelectedGuideId(null);
      setSelectedNodeIds((current) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          return current.includes(nodeId)
            ? current.filter((id) => id !== nodeId)
            : [...current, nodeId];
        }
        return [nodeId];
      });
      const node = visibleNodes.find((candidate) => candidate.id === nodeId);
      if (node) setSelectedComponentId(node.componentId);
    },
    [canInteractWithCanvas, markRendererNodeAccessed, rendererSurfaceTarget, visibleNodes]
  );

  const handleCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!canInteractWithCanvas()) {
        event.preventDefault();
        return;
      }
      const guideTarget =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-canvas-guide-id]')
          : null;
      const guideId = guideTarget?.dataset.canvasGuideId;
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-component-canvas-node="true"]')
          : null;
      const nodeId = target?.dataset.canvasNodeId;
      setContextMenuOpen(true);
      contextMenuFocusRef.current = guideTarget ?? target ?? viewportRef.current;
      if (guideId && documentRef.current.guides?.some((guide) => guide.id === guideId)) {
        setSelectedGuideId(guideId);
        setContextNodeId(null);
        setSelectedNodeIds([]);
        return;
      }
      setSelectedGuideId(null);
      if (nodeId && visibleNodes.some((node) => node.id === nodeId)) {
        markRendererNodeAccessed(nodeId);
        setContextNodeId(nodeId);
        setSelectedNodeIds((current) => (current.includes(nodeId) ? current : [nodeId]));
        const node = visibleNodes.find((candidate) => candidate.id === nodeId);
        if (node) setSelectedComponentId(node.componentId);
      } else {
        setContextNodeId(null);
        setSelectedNodeIds([]);
      }
    },
    [canInteractWithCanvas, markRendererNodeAccessed, visibleNodes]
  );

  const restoreContextMenuFocus = useCallback(() => {
    setContextMenuOpen(false);
    const target = contextMenuFocusRef.current;
    if (!target) return;
    window.setTimeout(() => target.focus(), 0);
  }, []);

  useEffect(() => {
    const restoreOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') restoreContextMenuFocus();
    };
    window.addEventListener('keydown', restoreOnEscape, true);
    return () => window.removeEventListener('keydown', restoreOnEscape, true);
  }, [restoreContextMenuFocus]);

  useEffect(() => {
    const dismissCanvasContextMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-context-menu-content]')) {
        return;
      }
      setContextMenuOpen(false);
    };
    window.addEventListener('pointerdown', dismissCanvasContextMenu, true);
    return () => window.removeEventListener('pointerdown', dismissCanvasContextMenu, true);
  }, []);

  const handleRendererFrameElementChange = useCallback(
    (frameId: string, element: HTMLIFrameElement | null) => {
      if (element) {
        rendererFrameElementsRef.current.set(frameId, element);
        setRendererSnapshotVersion((version) => version + 1);
      } else {
        rendererFrameElementsRef.current.delete(frameId);
      }
      if (selectedRendererFrameIdRef.current !== frameId) return;
      rendererIframeRef.current = element;
      setRendererFrameElement(element);
      onRendererFrameElementChange?.(element);
    },
    [onRendererFrameElementChange]
  );

  const handleRendererStageFrameElementChange = useCallback(
    (element: HTMLIFrameElement | null) => {
      rendererIframeRef.current = element;
      setRendererFrameElement(element);
      // A shared document contains multiple component roots. Until the child
      // inspector is scoped per frame, treating the stage iframe as one
      // editable surface could apply a request to the wrong component. Keep
      // the experimental stage interactive but fail closed for source edits.
      if (rendererSurfaceTarget) {
        deactivateEditableSurface(rendererSurfaceTarget);
        setRendererSurfaceTarget(null);
      }
      onRendererFrameElementChange?.(element);
    },
    [onRendererFrameElementChange, rendererSurfaceTarget]
  );

  const selectedReadiness = rendererReadiness(
    projectType,
    selectedComponent ? registryByComponentId.get(selectedComponent.id) : undefined
  );
  const selectedLifecycleStatus = selectedNode
    ? rendererLifecycleRef.current.stateFor(selectedNode.id)?.status
    : null;
  const styleEditorMode = qualifiedEditorMode;
  const styleSelection =
    styleEditorMode === 'css'
      ? rendererCssEditor.selection
      : styleEditorMode === 'tailwind'
        ? rendererEditor.selection
        : (rendererEditor.selection ?? rendererCssEditor.selection);
  // Style-tab source authority comes from the editor hook's resolver result. The
  // renderer event's root context is deliberately not used as descendant proof.
  const styleSourceResolution = rendererEditor.selection?.resolution ?? null;
  const styleSource =
    styleEditorMode === 'css'
      ? rendererCssEditor.focusedSource
      : sourceRefFromResolution(styleSourceResolution);
  const styleSourceIsExact =
    !!styleSource &&
    !!selectedComponent &&
    isSourceRefInside(selectedComponent.definition, styleSource);
  const styleSourceReason =
    styleEditorMode === 'css' && styleSelection && !rendererCssEditor.focusedSource
      ? 'The selected CSS rules have no exact source range inside this component definition.'
      : styleSourceResolution?.status === 'read_only'
        ? styleSourceResolution.reason
        : styleSourceResolution?.status === 'no_class'
          ? 'The selected element has no static class source range.'
          : styleSourceResolution?.status === 'multi'
            ? 'The selected element maps to multiple source ranges.'
            : styleSource && selectedComponent
              ? 'The selected element source range is outside this component definition.'
              : 'The selected element has no exact source range yet.';
  const styleMessageHandledByControls =
    // CssCascadePanel renders the selected CSS state's diagnostic inside its
    // own body, so the shared shell should not repeat it above the panel.
    styleEditorMode === 'css' && !!styleSelection;
  const styleFrameStatus =
    !selectedNode || !selectedComponent
      ? ('none' as const)
      : rendererFrameState === 'error' || rendererCircuitOpen || !!rendererFrameError
        ? ('error' as const)
        : !selectedReadiness.live
          ? ('unsupported' as const)
          : selectedLifecycleStatus === 'cached'
            ? ('cached' as const)
            : rendererInspectionEnabled
              ? ('live' as const)
              : ('loading' as const);
  const styleFrameReason =
    styleFrameStatus === 'error'
      ? (rendererFrameError ?? 'The selected component frame could not be inspected.')
      : styleFrameStatus === 'unsupported'
        ? selectedReadiness.reason
        : styleFrameStatus === 'cached'
          ? 'Style inspection is unavailable for a cached component frame.'
          : styleFrameStatus === 'loading'
            ? rendererSession
              ? 'The selected component frame is still loading.'
              : 'The selected component frame is loading in the background.'
            : undefined;
  const statusBadges = useMemo(
    () =>
      [
        selectedNode?.generated ? 'Generated default' : selectedNode ? 'Saved preset' : null,
        selectedPreset?.sourceRevision && selectedPreset.sourceRevision !== index?.revision
          ? 'Stale revision'
          : null,
        rendererFrameError || rendererCircuitOpen
          ? 'Error'
          : selectedLifecycleStatus === 'error'
            ? 'Error'
            : selectedLifecycleStatus === 'live'
              ? 'Live'
              : selectedLifecycleStatus === 'cached'
                ? 'Cached snapshot'
                : selectedLifecycleStatus === 'queued' ||
                    selectedLifecycleStatus === 'placeholder' ||
                    rendererFrameState === 'loading' ||
                    rendererSessionState === 'starting'
                  ? 'Rendering'
                  : selectedReadiness.live && !rendererSession
                    ? 'Setup required'
                    : !selectedReadiness.live
                      ? 'Unsupported'
                      : null,
      ].filter((label): label is string => !!label),
    [
      index?.revision,
      rendererCircuitOpen,
      rendererFrameError,
      rendererFrameState,
      rendererSession,
      rendererSessionState,
      selectedLifecycleStatus,
      selectedNode,
      selectedPreset,
      selectedReadiness.live,
    ]
  );
  const canDeleteFrame = !!selectedNode && selectedNode.generated !== false;

  const stylePanelStateRef = useRef({
    activeRendererBreakpoint,
    editMainConfirmed,
    editorBreakpoints,
    openRendererSource,
    projectPath,
    rendererBreakpointTooWide,
    rendererCssAnimations,
    rendererCssEditor,
    rendererCssScope,
    rendererCssVariables,
    rendererEditor,
    rendererElementSettings,
    rendererSurfaceTarget,
    rendererTextEditing,
    rendererEditMode,
    setEditMainConfirmOpen,
    setRendererBreakpointOverride,
    setRendererCssScope,
    styleEditorMode,
    styleFrameReason,
    styleFrameStatus,
    styleMessageHandledByControls,
    styleSelection,
    styleSourceIsExact,
    styleSourceReason,
  });
  stylePanelStateRef.current = {
    activeRendererBreakpoint,
    editMainConfirmed,
    editorBreakpoints,
    openRendererSource,
    projectPath,
    rendererBreakpointTooWide,
    rendererCssAnimations,
    rendererCssEditor,
    rendererCssScope,
    rendererCssVariables,
    rendererEditor,
    rendererElementSettings,
    rendererSurfaceTarget,
    rendererTextEditing,
    rendererEditMode,
    setEditMainConfirmOpen,
    setRendererBreakpointOverride,
    setRendererCssScope,
    styleEditorMode,
    styleFrameReason,
    styleFrameStatus,
    styleMessageHandledByControls,
    styleSelection,
    styleSourceIsExact,
    styleSourceReason,
  };
  const componentPanelStateRef = useRef({
    canDeleteFrame: false,
    componentEditTab,
    draftPresetProps,
    draftPresetSlots,
    editMainConfirmed,
    indexRevision: undefined as string | undefined,
    statusBadges,
    persistError: null as string | null,
    presetName: '',
    rendererA11yError: null as string | null,
    rendererA11yFindings: [] as RendererA11yFinding[],
    rendererA11yState: 'idle' as 'idle' | 'running' | 'ready',
    rendererCircuitOpen: false,
    rendererEditContext: null as RendererFrameEditContext | null,
    rendererFrameElement: null as HTMLIFrameElement | null,
    rendererFrameError: null as string | null,
    rendererFrameState: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    canRunAccessibility: false,
    rendererPerformance,
    rendererSession: null as object | null,
    rendererSessionId: null as string | null,
    rendererSessionState: 'not-started' as
      | 'not-started'
      | 'starting'
      | 'live'
      | 'stopping'
      | 'stopped',
    rendererSnapshotError: null as string | null,
    rendererSnapshotPath: null as string | null,
    rendererSnapshotState: 'idle' as 'idle' | 'capturing' | 'ready',
    rendererSurfaceActive: false,
    liveRendererNodeCount: 0,
    mountedNodeCount: 0,
    selectedComponent: null as ComponentDescriptor | null,
    selectedNode: null as ComponentCanvasNode | null,
    selectedPreset: null as ComponentPreviewPreset | null,
    projectType,
  });
  componentPanelStateRef.current = {
    canDeleteFrame,
    componentEditTab,
    draftPresetProps,
    draftPresetSlots,
    editMainConfirmed,
    indexRevision: index?.revision,
    statusBadges,
    persistError: persistError?.message ?? null,
    presetName,
    rendererA11yError,
    rendererA11yFindings,
    rendererA11yState,
    rendererCircuitOpen,
    rendererEditContext,
    rendererFrameElement,
    rendererFrameError,
    rendererFrameState,
    canRunAccessibility: rendererSurfaceTarget?.capabilities.accessibility === true,
    rendererPerformance,
    rendererSession,
    rendererSessionId,
    rendererSessionState,
    rendererSnapshotError,
    rendererSnapshotPath,
    rendererSnapshotState,
    rendererSurfaceActive: !!rendererSurfaceTarget,
    liveRendererNodeCount: liveRendererNodeIds.length,
    mountedNodeCount: mountedNodes.length,
    selectedComponent,
    selectedNode,
    selectedPreset,
    projectType,
  };
  // The renderer is stable; this revision tells the workspace shell when the
  // state captured by that renderer has changed and needs repainting.
  const stylePanelRevision = useMemo(
    () => ({}),
    [
      activeRendererBreakpoint,
      editMainConfirmed,
      editorBreakpoints,
      openRendererSource,
      projectPath,
      rendererBreakpointTooWide,
      rendererCssEditor.animationSuggestions,
      rendererCssEditor.bodies,
      rendererCssEditor.classSuggestions,
      rendererCssEditor.existingSelectors,
      rendererCssEditor.loading,
      rendererCssEditor.overridden,
      rendererCssEditor.rows,
      rendererCssScope,
      rendererCssEditor.selection,
      rendererCssEditor.variableSuggestions,
      rendererCssAnimations.animations,
      rendererCssAnimations.loading,
      rendererCssVariables.variables,
      rendererEditor.autoSave,
      rendererEditor.currentClass,
      rendererEditor.customClasses,
      rendererEditor.editMode,
      rendererEditor.editTarget,
      rendererEditor.imageResolution,
      rendererEditor.multiTarget,
      rendererEditor.selection,
      rendererEditor.spacingScale,
      rendererEditor.tailwindVersion,
      rendererEditor.usage,
      rendererEditor.utilityPrefix,
      rendererElementSettings.attributes,
      rendererElementSettings.busy,
      rendererElementSettings.canEditAttributes,
      rendererElementSettings.classes,
      rendererElementSettings.location,
      rendererElementSettings.tag,
      rendererSurfaceTarget,
      rendererTextEditing.textBlockedNonce,
      rendererTextEditing.textResolution,
      styleEditorMode,
      styleFrameReason,
      styleFrameStatus,
      styleMessageHandledByControls,
      styleSelection,
      styleSourceIsExact,
      styleSourceReason,
    ]
  );
  // Component-tab state is intentionally tracked separately from the style
  // editor revision. The shared dock keeps the renderer callback stable, so
  // every stateful Component/Frame/QA value that the callback reads must bump
  // this revision and repaint the published panel.
  const componentPanelRevision = useMemo(
    () => ({}),
    [
      canDeleteFrame,
      componentEditTab,
      draftPresetProps,
      draftPresetSlots,
      statusBadges,
      persistError,
      presetName,
      rendererA11yError,
      rendererA11yFindings,
      rendererA11yState,
      rendererCircuitOpen,
      rendererEditContext,
      rendererFrameElement,
      rendererFrameError,
      rendererFrameState,
      rendererPerformance.inputToTransformMs,
      rendererPerformance.longFrameCount,
      rendererPerformance.liveIframes,
      rendererPerformance.maxInputToTransformMs,
      rendererPerformance.mountedNodes,
      rendererSession,
      rendererSessionId,
      rendererSessionState,
      rendererSnapshotError,
      rendererSnapshotPath,
      rendererSnapshotState,
      rendererSurfaceTarget,
      liveRendererNodeIds,
      mountedNodes,
      selectedComponent,
      selectedNode,
      selectedPreset,
      projectType,
    ]
  );

  // Components mode publishes the selected frame's complete edit panel to Preview's shared dock.
  useEffect(() => {
    if (!onEditPanelChange) return;
    if (!selectedComponent || !canvasInteractive) {
      onEditPanelChange(null);
      return;
    }

    const panel = stylePanelStateRef.current;
    const component = componentPanelStateRef.current;
    const renderEditPanel: ComponentEditPanelRenderer = ({ pinned, onTogglePin, onClose }) => {
      const closeEditPanel = () => {
        // The shared close action must leave the renderer edit mode as well as
        // dismissing the current surface. Preview then has a deterministic
        // reopen path through the shared Edit toggle.
        onVisualEditorActiveChange?.(false);
        onClose();
      };
      if (!rendererEditMode) {
        return (
          <ComponentEditPanel
            projectType={component.projectType}
            selectedComponent={component.selectedComponent!}
            selectedNode={component.selectedNode}
            selectedPreset={component.selectedPreset}
            statusBadges={component.statusBadges}
            rendererEditContext={component.rendererEditContext}
            rendererSessionState={component.rendererSessionState}
            rendererFrameState={component.rendererFrameState}
            rendererSurfaceActive={component.rendererSurfaceActive}
            canRunAccessibility={component.canRunAccessibility}
            rendererSessionId={component.rendererSessionId}
            rendererFrameElement={component.rendererFrameElement}
            rendererFrameError={component.rendererFrameError}
            rendererCircuitOpen={component.rendererCircuitOpen}
            rendererPerformance={component.rendererPerformance}
            mountedNodeCount={component.mountedNodeCount}
            liveRendererNodeCount={component.liveRendererNodeCount}
            rendererSnapshotState={component.rendererSnapshotState}
            rendererSnapshotPath={component.rendererSnapshotPath}
            rendererSnapshotError={component.rendererSnapshotError}
            rendererA11yFindings={component.rendererA11yFindings}
            rendererA11yState={component.rendererA11yState}
            rendererA11yError={component.rendererA11yError}
            persistError={component.persistError}
            presetName={component.presetName}
            draftPresetProps={component.draftPresetProps}
            draftPresetSlots={component.draftPresetSlots}
            onOpenSource={onOpenSource}
            onOpenSetup={() => setSetupOpen(true)}
            setupButtonLabel={
              component.rendererSession
                ? 'Review renderer setup'
                : rendererConsent
                  ? 'Renderer settings'
                  : 'Enable live previews'
            }
            setupDisabled={component.rendererSessionState === 'stopping'}
            onCreatePreset={createPresetFromSelectedFrame}
            onPresetNameChange={setPresetName}
            onRenamePreset={renameSelectedPreset}
            onDuplicatePreset={duplicateSelectedPreset}
            onDeletePreset={deleteSelectedPreset}
            onUpdatePresetProp={updateSelectedPresetProp}
            onUpdatePresetSlot={updateSelectedPresetSlot}
            onDuplicateFrame={duplicateSelected}
            onDeleteFrame={deleteSelected}
            canDeleteFrame={component.canDeleteFrame}
            onCaptureSnapshot={() => void captureSnapshot()}
            onRunAccessibility={() => void runAccessibility()}
            onRetryRenderer={retryRenderer}
            onStopRenderer={() => void stopRenderer()}
            activeTab={component.componentEditTab}
            onTabChange={setComponentEditTab}
            pinned={pinned}
            onTogglePin={onTogglePin}
            onClose={closeEditPanel}
          />
        );
      }

      const editingCapability = panel.rendererSurfaceTarget?.capabilities.editing === true;
      const styleReadOnly =
        !editingCapability ||
        !panel.styleSelection ||
        !panel.styleSourceIsExact ||
        !panel.editMainConfirmed;
      const readOnlyReason =
        panel.styleFrameStatus !== 'live'
          ? panel.styleFrameReason
          : !editingCapability
            ? 'This component frame is inspection-only because renderer editing is unavailable.'
            : !panel.styleSourceIsExact
              ? panel.styleSourceReason
              : !panel.editMainConfirmed
                ? 'Confirm Edit main to enable style changes to this component definition.'
                : undefined;
      const styleContent =
        panel.styleEditorMode === 'tailwind' ? (
          <VisualEditorPanel
            selection={panel.rendererEditor.selection}
            projectPath={panel.projectPath}
            currentClass={panel.rendererEditor.currentClass}
            variables={panel.rendererCssVariables.variables}
            tailwindVersion={panel.rendererEditor.tailwindVersion}
            utilityPrefix={panel.rendererEditor.utilityPrefix ?? undefined}
            spacingScale={panel.rendererEditor.spacingScale ?? undefined}
            textResolution={panel.rendererTextEditing.textResolution}
            imageResolution={panel.rendererEditor.imageResolution}
            onReplaceImage={panel.rendererEditor.replaceImage}
            textBlockedNonce={panel.rendererTextEditing.textBlockedNonce}
            readOnly={styleReadOnly}
            readOnlyReason={readOnlyReason}
            breakpoints={panel.editorBreakpoints}
            activeBreakpoint={panel.activeRendererBreakpoint}
            breakpointTooWide={panel.rendererBreakpointTooWide}
            onSelectBreakpoint={(breakpoint) =>
              panel.setRendererBreakpointOverride(breakpoint.name)
            }
            autoSave={panel.rendererEditor.autoSave}
            onToggleAutoSave={panel.rendererEditor.toggleAutoSave}
            onStepGap={(direction, step) => {
              void panel.rendererEditor.stepSpacing('gap', direction, step);
            }}
            onSetSide={(type, side, value) => {
              void panel.rendererEditor.setBoxSide(type, side, value);
            }}
            onSetPositionSide={(side, value) => {
              void panel.rendererEditor.setPositionSide(side, value);
            }}
            onApplyEnum={(token, style) => {
              void panel.rendererEditor.applyEnum(token, style);
            }}
            onReset={(spec) => {
              void panel.rendererEditor.reset(spec);
            }}
            multiTarget={panel.rendererEditor.multiTarget}
            onMultiTargetChange={panel.rendererEditor.setMultiTarget}
            editTarget={panel.rendererEditor.editTarget}
            customClasses={panel.rendererEditor.customClasses}
            canCreateClass={panel.rendererEditor.classEntryReady}
            onEditElement={panel.rendererEditor.editElement}
            onEditClass={panel.rendererEditor.editClass}
            onApplyClass={panel.rendererEditor.applyClass}
            onUnapplyClass={panel.rendererEditor.unapplyClass}
            onCreateClass={(name) => void panel.rendererEditor.createClassFromStyles(name)}
            onAddFirstClass={panel.rendererEditor.addFirstClass}
            usage={panel.rendererEditor.usage}
            onOpenInCode={panel.openRendererSource}
            onCommit={() => void panel.rendererEditor.commit()}
            onClose={() => {
              if (panel.rendererEditor.editMode) panel.rendererEditor.toggleEditMode();
              else onClose();
            }}
            chrome={false}
          />
        ) : (
          <CssCascadePanel
            selection={panel.rendererCssEditor.selection}
            rows={panel.rendererCssEditor.rows}
            loading={panel.rendererCssEditor.loading}
            bodies={panel.rendererCssEditor.bodies}
            overridden={panel.rendererCssEditor.overridden}
            onChangeBody={panel.rendererCssEditor.setBody}
            onDeleteRule={(key) => void panel.rendererCssEditor.deleteRule(key)}
            onWrapRule={(key, atPrelude) => void panel.rendererCssEditor.wrapRule(key, atPrelude)}
            onRenameRule={(key, selector) =>
              void panel.rendererCssEditor.renameSelector(key, selector)
            }
            onRenameAtRule={(key, media) => void panel.rendererCssEditor.renameAtRule(key, media)}
            onAddSelector={(selector, atPrelude) =>
              void panel.rendererCssEditor.addSelector(selector, atPrelude)
            }
            selectorSuggestions={panel.rendererCssEditor.classSuggestions.map((name) => '.' + name)}
            existingSelectors={panel.rendererCssEditor.existingSelectors}
            variables={panel.rendererCssEditor.variableSuggestions}
            animations={panel.rendererCssEditor.animationSuggestions}
            settings={panel.rendererElementSettings}
            animationsState={panel.rendererCssAnimations}
            readOnly={styleReadOnly}
            readOnlyReason={readOnlyReason}
            onClose={closeEditPanel}
            scope={panel.rendererCssScope}
            onScopeChange={panel.setRendererCssScope}
            chrome={false}
          />
        );

      return (
        <EditPanelShell
          context={panel.styleEditorMode === 'css' ? 'CSS' : 'Visual Editor'}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onClose={closeEditPanel}
          className="components-workspace__component-style-panel"
        >
          <div className="ss-edit-panel__body">
            <StyleTab
              className="components-workspace__component-style-panel-content"
              frameStatus={panel.styleFrameStatus}
              frameReason={panel.styleFrameReason}
              hasSelectedElement={!!panel.styleSelection}
              sourceStatus={panel.styleSourceIsExact ? 'exact' : 'unproven'}
              sourceReason={panel.styleSourceReason}
              showStateMessage={!panel.styleMessageHandledByControls}
              showHeader={false}
              editorMode={panel.styleEditorMode}
              editMainConfirmed={panel.editMainConfirmed}
              editingCapability={editingCapability}
              onRequestEditMain={() => panel.setEditMainConfirmOpen(true)}
              renderControls={() => styleContent}
            />
          </div>
        </EditPanelShell>
      );
    };

    onEditPanelChange(renderEditPanel);
    return () => onEditPanelChange(null);
  }, [
    canvasInteractive,
    captureSnapshot,
    componentEditTab,
    createPresetFromSelectedFrame,
    deleteSelected,
    deleteSelectedPreset,
    duplicateSelected,
    duplicateSelectedPreset,
    onEditPanelChange,
    onOpenSource,
    onVisualEditorActiveChange,
    renameSelectedPreset,
    rendererEditMode,
    rendererConsent,
    retryRenderer,
    runAccessibility,
    selectedComponent,
    setComponentEditTab,
    setPresetName,
    setSetupOpen,
    stopRenderer,
    componentPanelRevision,
    stylePanelRevision,
    updateSelectedPresetProp,
    updateSelectedPresetSlot,
  ]);

  const selectedOverlayNodes = visibleNodes
    .filter((node) => selectedNodeIds.includes(node.id))
    .map((node) => ({ ...node, rotation: nodeRotation(node) }));
  const canvasTitleNodes = visibleNodes.map((node) => {
    const extension = nodeLayerExtension(node);
    const component = componentsById.get(node.componentId);
    const preset = node.presetId
      ? presetStore.presets.find((candidate) => candidate.id === node.presetId)
      : undefined;
    return {
      ...node,
      rotation: nodeRotation(node),
      name: presentedComponentName(
        extension.name ?? preset?.name ?? component?.name ?? node.componentId
      ),
      snapshot:
        !rendererStageEnabled &&
        !!rendererFrames.get(node.id) &&
        rendererLifecycleRef.current.stateFor(node.id)?.status !== 'live' &&
        !!rendererSnapshotCacheRef.current.getExact(
          node.id,
          rendererFrameSnapshotKey(rendererFrames.get(node.id) as RendererFramePayload)
        ),
    };
  });
  const selectedOverlayBounds = selectionBoundsForNodes(selectedOverlayNodes);
  const canvasChromeOverlay = (
    <>
      {projectType === 'nextjs' &&
        !rendererSession &&
        !setupSession &&
        (rendererRegistry?.supportedComponentIds.length ?? 0) > 0 &&
        (!rendererConsent || rendererPreflight.status === 'blocked' || !!setupError) && (
          <div className="components-workspace__renderer-banner" role="status">
            <div>
              <strong>
                {!rendererConsentLoaded
                  ? 'Checking renderer approval…'
                  : rendererPreflight.status === 'blocked'
                    ? 'Live previews need attention'
                    : rendererConsent && setupPhase !== 'review'
                      ? 'Starting live component previews…'
                      : rendererConsent
                        ? 'Live component previews are paused'
                        : 'Enable live component previews'}
              </strong>
              <span>
                {rendererPreflight.message ??
                  (rendererConsent && setupPhase !== 'review'
                    ? 'Ship Studio is preparing the approved project renderer.'
                    : rendererConsent
                      ? 'The background renderer could not start yet. Existing snapshots remain available.'
                      : 'Ship Studio will add temporary renderer files and run local project component code through your dev server.')}
              </span>
              {setupError && <span className="components-workspace__error">{setupError}</span>}
            </div>
            {rendererConsentLoaded && !rendererConsent && (
              <Button
                variant="primary"
                size="compact"
                disabled={rendererPreflight.status !== 'ready'}
                onClick={() => setSetupOpen(true)}
              >
                Enable previews
              </Button>
            )}
            {rendererConsent && (rendererPreflight.status === 'blocked' || !!setupError) && (
              <Button
                variant="primary"
                disabled={rendererPreflight.status === 'blocked'}
                onClick={() => void startApprovedRenderer()}
              >
                Retry
              </Button>
            )}
          </div>
        )}
      {projectType === 'vite' && !COMPONENT_RENDERER_FLAGS.vite && (
        <div className="components-workspace__renderer-banner" role="status">
          <div>
            <strong>Vite components are catalog-only</strong>
            <span>
              Live previews are paused because Ship Studio cannot safely serve a generated component
              entry through an arbitrary Vite config yet. Your source remains unchanged; open a
              component&apos;s source to inspect or edit it.
            </span>
          </div>
        </div>
      )}
      {visibleNodes.length === 0 && (
        <EmptyState
          icon={<ComponentsIcon size={24} />}
          title="Select a component to begin"
          description="Choose a definition from the catalog or switch to All components."
        />
      )}
      {scope === 'variants' && selectedComponent && (
        <div className="components-workspace__variant-toolbar">
          <span>
            Prospective finite matrix: {prospectiveVariantCount} variant
            {prospectiveVariantCount === 1 ? '' : 's'}
            {generatedVariants[selectedComponent.id]?.length
              ? ` · ${generatedVariants[selectedComponent.id].length} generated`
              : ''}
          </span>
          <Button
            variant="secondary"
            size="compact"
            disabled={prospectiveVariantCount === 0 || prospectiveVariantCount > 48}
            onClick={generateFiniteVariants}
          >
            Generate finite variants
          </Button>
        </div>
      )}
      {variantNotice && (
        <div className="components-workspace__canvas-notice" role="status">
          <span>{variantNotice}</span>
          <Button variant="ghost" size="compact" onClick={() => setVariantNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </>
  );
  const canvasScreenOverlay = (
    <>
      <CanvasSelectionOverlay
        nodes={selectedOverlayNodes}
        titleNodes={canvasTitleNodes}
        selectedIds={selectedNodeIds}
        camera={camera}
        onTitlePointerDown={(event, nodeId) => {
          const node = visibleNodes.find((candidate) => candidate.id === nodeId);
          if (node) startMove(event, node);
        }}
        onTitleSelect={selectNode}
        onTitleRename={onLayerRename}
        onResizeStart={startResize}
        onResizeKeyboardStart={startResizeKeyboard}
      />
      {rendererToolbarGeometry && rendererStructure.selection && (
        <ElementToolbar
          selection={rendererToolbarGeometry.selection}
          bounds={rendererToolbarGeometry.bounds}
          busy={rendererStructure.busy}
          hidden={rendererStructure.textEditing}
          onInsert={(position, kind) => void rendererStructure.insert(position, kind)}
          onDuplicate={() => void rendererStructure.duplicate()}
          onDelete={() => void rendererStructure.remove()}
        />
      )}
      <CanvasGuidesOverlay guides={snapGuides} camera={camera} />
      {marquee && (
        <div
          className="component-canvas-marquee"
          style={{
            left: Math.min(
              marquee.start.x * camera.zoom + camera.x,
              marquee.current.x * camera.zoom + camera.x
            ),
            top: Math.min(
              marquee.start.y * camera.zoom + camera.y,
              marquee.current.y * camera.zoom + camera.y
            ),
            width: Math.abs(marquee.current.x - marquee.start.x) * camera.zoom,
            height: Math.abs(marquee.current.y - marquee.start.y) * camera.zoom,
          }}
          data-testid="component-canvas-marquee"
        />
      )}
      {canvasChromeOverlay}
    </>
  );

  if (error && !index) {
    return (
      <EmptyState
        icon={<InfoIcon size={24} />}
        title="Components catalog unavailable"
        description={error}
        action={
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div
      className="components-workspace"
      data-testid="components-workspace"
      data-education-id="components-workspace"
      style={{
        paddingLeft: panelInsets.left > 0 ? `${panelInsets.left}px` : undefined,
        paddingRight: panelInsets.right > 0 ? `${panelInsets.right}px` : undefined,
      }}
    >
      <main className="components-workspace__main">
        <header className="components-workspace__toolbar">
          <div className="components-workspace__toolbar-leading">
            <div className="components-workspace__history-actions">
              <Button
                variant="ghost"
                size="compact"
                aria-label="Undo last source change"
                title="Undo last source change"
                disabled={!canvasInteractive || !canUndo}
                leftIcon={<UndoIcon size={14} />}
                onClick={() => void onUndo()}
              />
              <Button
                variant="ghost"
                size="compact"
                aria-label="Redo source change"
                title="Redo source change"
                disabled={!canvasInteractive || !canRedo}
                leftIcon={<RedoIcon size={14} />}
                onClick={() => void onRedo()}
              />
            </div>
            <div className="components-workspace__toolbar-title">
              <span className="components-workspace__eyebrow">Components workspace</span>
              <strong>
                {canvasInteractive
                  ? (selectedComponent?.name ?? 'All components')
                  : canvasReadOnly
                    ? 'Canvas unavailable'
                    : 'Loading canvas…'}
              </strong>
            </div>
          </div>
          <Tabs
            value={scope}
            mode="navigation"
            onValueChange={(value) => {
              if (!canvasInteractive) return;
              const next = value as CanvasScope;
              setScope(next);
              onNavigate({ componentId: selectedComponent?.id, scope: next });
            }}
          >
            <TabsList aria-label="Components canvas scope" appearance="segmented">
              <TabsTab value="all" disabled={!canvasInteractive}>
                All components
              </TabsTab>
              <TabsTab value="focus" disabled={!canvasInteractive}>
                Focus
              </TabsTab>
              <TabsTab value="variants" disabled={!canvasInteractive}>
                Variants
              </TabsTab>
            </TabsList>
          </Tabs>
          <div className="components-workspace__toolbar-actions components-workspace__toolbar-actions--canvas">
            <VisualEditorToggle
              enabled={canvasInteractive && (rendererEditorEnabled || rendererCssEditorEnabled)}
              active={rendererEditMode}
              onToggle={toggleRendererEditMode}
            />
            <IconButton
              variant="default"
              aria-label="Reset layout"
              title="Reset layout"
              disabled={!canvasInteractive}
              icon={<ResetIcon size={14} />}
              onClick={resetLayout}
            />
            <IconButton
              variant="default"
              aria-label="Arrange all"
              title="Arrange all"
              disabled={!canvasInteractive}
              icon={<GridIcon size={14} />}
              onClick={arrangeAll}
            />
            <IconButton
              variant="default"
              aria-label="Arrange selection"
              title="Arrange selection"
              icon={<AlignJustifyIcon size={14} />}
              disabled={!canvasInteractive || selectedNodeIds.length === 0}
              onClick={arrangeSelection}
            />
            {rendererSession && (
              <IconButton
                variant="default"
                aria-label={
                  rendererSessionState === 'stopping' ? 'Stopping previews' : 'Stop previews'
                }
                title={rendererSessionState === 'stopping' ? 'Stopping previews' : 'Stop previews'}
                icon={<StopIcon size={14} />}
                disabled={!canvasInteractive || rendererSessionState === 'stopping'}
                onClick={() => void stopRenderer()}
              />
            )}
          </div>
        </header>
        <ContextMenu>
          <ContextMenuTrigger asChild onContextMenu={handleCanvasContextMenu}>
            <div className="components-workspace__canvas-frame">
              {canvasInteractive ? (
                <ComponentsCanvas
                  ref={viewportRef}
                  camera={camera}
                  className="components-workspace__viewport"
                  tabIndex={0}
                  onKeyDown={onKeyDown}
                  onAuxClick={onAuxClick}
                  onPointerDown={startCanvasGesture}
                  onPointerMove={moveNode}
                  onPointerUp={stopMove}
                  onPointerCancel={abortCanvasGesture}
                  aria-label="Components canvas"
                  role="listbox"
                  aria-multiselectable="true"
                  data-camera-space-held={spacePanHeld ? 'true' : undefined}
                  data-camera-pan-active={cameraPanActive ? 'true' : undefined}
                  overlay={canvasScreenOverlay}
                  rendererStageActive={rendererStageEnabled}
                  data-renderer-mounted-nodes={mountedNodes.length}
                  data-renderer-live-iframes={liveRendererNodeIds.length}
                  data-renderer-input-latency-ms={
                    rendererPerformance.inputToTransformMs ?? undefined
                  }
                  data-renderer-long-frame-count={rendererPerformance.longFrameCount}
                >
                  {rendererStageEnabled &&
                  rendererSession &&
                  rendererRouteSegment &&
                  rendererStageId &&
                  rendererStageFrames.length > 0 ? (
                    <ComponentCanvasStage
                      session={rendererSession}
                      stageId={rendererStageId}
                      routeSegment={rendererRouteSegment}
                      frames={rendererStageFrames}
                      camera={{ ...camera, owner: 'parent' }}
                      selectedFrameId={selectedNodeId}
                      inputFrameId={selectedNodeId}
                      revealFrameIds={rendererStageFrames.map((frame) => frame.frameId)}
                      retainFrameIds={rendererStageFrames.map((frame) => frame.frameId)}
                      onEvent={onRendererStageEvent}
                      onFrameElementChange={handleRendererStageFrameElementChange}
                    />
                  ) : (
                    mountedNodes.map((node) => {
                      const component = componentsById.get(node.componentId);
                      if (!component) return null;
                      const isSelectedNode = selectedNodeId === node.id;
                      const frame = rendererFrames.get(node.id);
                      const readiness = rendererReadiness(
                        projectType,
                        registryByComponentId.get(component.id)
                      );
                      const snapshotKey = frame
                        ? rendererFrameSnapshotKey(
                            frame,
                            rendererRouteSegment ?? COMPONENT_RENDERER_INTEGRATION_VERSION
                          )
                        : null;
                      const staticSnapshot = snapshotKey
                        ? rendererSnapshotCacheRef.current.getExact(node.id, snapshotKey)
                        : undefined;
                      const lifecycleFrameState = rendererLifecycleRef.current.stateFor(node.id);
                      const lifecycleStatus = lifecycleFrameState?.status;
                      const captureKeepsFrameVisible =
                        snapshotKey !== null &&
                        rendererSnapshotPendingRef.current.get(node.id)?.snapshotKey ===
                          snapshotKey &&
                        rendererSnapshotPendingRef.current.get(node.id)?.captureEpoch ===
                          rendererSnapshotEpochRef.current &&
                        (lifecycleStatus === 'live' || lifecycleStatus === 'suspended');
                      return (
                        <CanvasNodeView
                          key={node.id}
                          node={node}
                          component={component}
                          readiness={readiness}
                          selected={selectedNodeIds.includes(node.id)}
                          stackingIndex={canvasNodeStackingIndex(node.id, visibleNodes)}
                          staticSnapshot={staticSnapshot}
                          rendererStatus={captureKeepsFrameVisible ? 'live' : lifecycleStatus}
                          zoom={camera.zoom}
                          liveFrame={
                            rendererSession &&
                            rendererRouteSegment &&
                            frame &&
                            liveRendererNodeIds.includes(node.id) ? (
                              <RendererFrameHost
                                session={rendererSession}
                                frame={frame}
                                routeSegment={rendererRouteSegment}
                                retryNonce={lifecycleFrameState?.retryNonce ?? 0}
                                onEvent={onRendererEvent}
                                onTargetChange={
                                  isSelectedNode ? handleRendererTargetChange : undefined
                                }
                                onFrameElementChange={handleRendererFrameElementChange}
                                canvasInputEnabled={isSelectedNode}
                                zoom={camera.zoom}
                                editingEnabled={
                                  isSelectedNode &&
                                  !!component.renderRoot &&
                                  rendererInspectorAvailable &&
                                  rendererSession?.capabilities.editing === true
                                }
                              />
                            ) : undefined
                          }
                          onSelect={selectNode}
                        />
                      );
                    })
                  )}
                </ComponentsCanvas>
              ) : (
                <div
                  className="components-workspace__canvas-loading"
                  role={canvasReadOnly ? 'alert' : 'status'}
                  aria-live="polite"
                  aria-busy={!canvasReadOnly}
                  data-testid="components-workspace-canvas-loading"
                  data-project-path={projectPath}
                >
                  {canvasReadOnly
                    ? 'This project’s canvas could not be read. Canvas editing is disabled.'
                    : 'Loading this project’s canvas…'}
                </div>
              )}
              {canvasInteractive && (
                <div
                  className="components-workspace__floating-toolbar"
                  role="toolbar"
                  aria-label="Canvas controls"
                >
                  <div
                    className="components-workspace__floating-toolbar-group"
                    role="group"
                    aria-label="Undo and redo controls"
                  >
                    <IconButton
                      variant="ghost"
                      size="default"
                      aria-label="Undo canvas change"
                      title="Undo canvas change"
                      disabled={!canvasHistoryRef.current.canUndo}
                      icon={<UndoIcon size={14} />}
                      onClick={undoCanvas}
                    />
                    <IconButton
                      variant="ghost"
                      size="default"
                      aria-label="Redo canvas change"
                      title="Redo canvas change"
                      disabled={!canvasHistoryRef.current.canRedo}
                      icon={<RedoIcon size={14} />}
                      onClick={redoCanvas}
                    />
                  </div>
                  <CanvasToolbar
                    zoom={camera.zoom}
                    onZoomOut={() => zoomCameraAtViewportCenter(1 / CANVAS_KEYBOARD_ZOOM_STEP)}
                    onZoomIn={() => zoomCameraAtViewportCenter(CANVAS_KEYBOARD_ZOOM_STEP)}
                    onZoomChange={setZoomAtViewportCenter}
                    onFit={fitScene}
                    onFitSelection={selectedNodeIds.length > 0 ? fitSelection : undefined}
                    rulersControl={
                      <IconButton
                        variant="ghost"
                        size="default"
                        aria-pressed={rulersVisible}
                        aria-label="Toggle canvas rulers"
                        title="Toggle canvas rulers"
                        icon={<RulerIcon size={14} />}
                        onClick={() => setRulersVisible((current) => !current)}
                      />
                    }
                  />
                </div>
              )}
              {canvasInteractive && (
                <CanvasRulersOverlay
                  camera={camera}
                  guides={document.guides ?? []}
                  selectedGuideId={selectedGuideId}
                  visible={rulersVisible}
                  viewport={viewportSize}
                  selectedBounds={
                    selectedOverlayBounds
                      ? {
                          x: selectedOverlayBounds.left,
                          y: selectedOverlayBounds.top,
                          width: selectedOverlayBounds.right - selectedOverlayBounds.left,
                          height: selectedOverlayBounds.bottom - selectedOverlayBounds.top,
                        }
                      : null
                  }
                  selectionActive={
                    !!dragRef.current || !!resizeRef.current || !!rotationRef.current
                  }
                  interactionBlocked={
                    contextMenuOpen ||
                    setupOpen ||
                    editMainConfirmOpen ||
                    rendererEditor.editMode ||
                    rendererCssEditor.editMode
                  }
                  onGuidesChange={updateCanvasGuides}
                  onSelectGuide={setSelectedGuideId}
                />
              )}
            </div>
          </ContextMenuTrigger>
          {canvasInteractive && (
            <CanvasContextMenu
              hasSelection={selectedNodeIds.length > 0 || !!contextNodeId}
              hasGuideSelection={!!selectedGuideId}
              onDuplicate={() => {
                duplicateSelected();
                restoreContextMenuFocus();
              }}
              onDelete={() => {
                deleteSelected();
                restoreContextMenuFocus();
              }}
              onDeleteGuide={() => {
                deleteSelectedGuide();
                restoreContextMenuFocus();
              }}
              onBringForward={() => {
                bringSelectionForward();
                restoreContextMenuFocus();
              }}
              onSendBackward={() => {
                sendSelectionBackward();
                restoreContextMenuFocus();
              }}
              onFitSelection={() => {
                fitSelection();
                restoreContextMenuFocus();
              }}
            />
          )}
        </ContextMenu>
      </main>
      <ModalFrame
        isOpen={editMainConfirmOpen && canvasInteractive}
        onClose={() => setEditMainConfirmOpen(false)}
        title="Edit main component"
      >
        <p>
          Visual changes here write to <strong>{selectedComponent?.name}</strong>&apos;s definition,
          so they affect every indexed usage and every canvas variant that renders it.
        </p>
        <p className="components-workspace__muted">
          Ship Studio will only enable controls after the selected element has an exact source range
          inside this component definition at the current source revision. Frame props, slots, and
          layout remain test-case settings.
        </p>
        <div className="components-workspace__toolbar-actions">
          <Button variant="ghost" onClick={() => setEditMainConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setEditMainConfirmed(true);
              setEditMainConfirmOpen(false);
              if (styleEditorMode === 'tailwind') rendererEditor.toggleEditMode();
              else if (styleEditorMode === 'css') rendererCssEditor.toggleEditMode();
            }}
          >
            Continue to Edit main
          </Button>
        </div>
      </ModalFrame>
      <RendererSetupModal
        isOpen={setupOpen && canvasInteractive}
        onClose={() => setSetupOpen(false)}
        adapterEnabled={
          COMPONENT_RENDERER_FLAGS.nextAppRouter || COMPONENT_RENDERER_FLAGS.nextPagesRouter
        }
        approved={!!rendererConsent}
        phase={setupPhase}
        plan={setupPlan}
        error={setupError}
        onEnable={() => void (rendererConsent ? startApprovedRenderer() : enableRenderer())}
        onReset={() => void resetRendererSetup()}
        onDisable={() => void disableRenderer()}
      />
    </div>
  );
}
