import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CANVAS_DRAG_THRESHOLD_PX } from '../../../lib/components/canvas-camera';
import {
  ChevronRightIcon,
  ChevronIcon,
  ComponentsIcon,
  EyeIcon,
  EyeOffIcon,
  LockedIcon,
  UnlockedIcon,
} from '@/components/icons';
import { IconButton } from '../../primitives/IconButton';
import './CanvasLayersPanel.css';

export interface CanvasLayerItem {
  id: string;
  name: string;
  parentId?: string | null;
  visible?: boolean;
  locked?: boolean;
  expanded?: boolean;
  /** Optional caller-owned preview/icon content. */
  icon?: ReactNode;
}

export type CanvasLayerDropPosition = 'before' | 'after' | 'into';

export interface CanvasLayerDropIntent {
  draggedId: string;
  targetId: string;
  position: CanvasLayerDropPosition;
}

export interface CanvasLayersPanelProps {
  layers: readonly CanvasLayerItem[];
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onToggleExpanded?: (id: string, expanded: boolean) => void;
  onRename?: (id: string, name: string) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleLock?: (id: string, locked: boolean) => void;
  /** The caller owns hierarchy validation, including cycle prevention. */
  onDropIntent?: (intent: CanvasLayerDropIntent) => void | boolean;
  emptyMessage?: string;
  className?: string;
}

export const CANVAS_LAYERS_DROP_THRESHOLD_PX = CANVAS_DRAG_THRESHOLD_PX;

interface VisibleCanvasLayer extends CanvasLayerItem {
  level: number;
  hasChildren: boolean;
  positionInSet: number;
  setSize: number;
}

/** Build the reversed, expanded tree order used by both rendering and range selection. */
export function visibleCanvasLayers(layers: readonly CanvasLayerItem[]): VisibleCanvasLayer[] {
  const childrenByParent = new Map<string | null, CanvasLayerItem[]>();
  const ids = new Set(layers.map((layer) => layer.id));
  for (const layer of layers) {
    const parentId = layer.parentId && ids.has(layer.parentId) ? layer.parentId : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(layer);
    childrenByParent.set(parentId, siblings);
  }
  const result: VisibleCanvasLayer[] = [];
  const visited = new Set<string>();
  const structurallyReachable = new Set<string>();
  const markReachable = (parentId: string | null, path: ReadonlySet<string>) => {
    for (const layer of childrenByParent.get(parentId) ?? []) {
      if (path.has(layer.id)) continue;
      structurallyReachable.add(layer.id);
      markReachable(layer.id, new Set([...path, layer.id]));
    }
  };
  markReachable(null, new Set());
  const walk = (parentId: string | null, level: number, path: ReadonlySet<string>) => {
    const siblings = childrenByParent.get(parentId) ?? [];
    const visualSiblings = [...siblings].reverse();
    for (const [siblingIndex, layer] of visualSiblings.entries()) {
      if (path.has(layer.id) || visited.has(layer.id)) continue;
      visited.add(layer.id);
      const children = childrenByParent.get(layer.id) ?? [];
      result.push({
        ...layer,
        level,
        hasChildren: children.length > 0,
        positionInSet: siblingIndex + 1,
        setSize: visualSiblings.length,
      });
      if ((layer.expanded ?? true) && children.length > 0) {
        walk(layer.id, level + 1, new Set([...path, layer.id]));
      }
    }
  };
  walk(null, 1, new Set());

  // A stale or externally-authored document can contain a disconnected parent
  // cycle. Keep the layer list total rather than silently hiding those nodes:
  // each unreachable node becomes a root for this render pass.
  for (const layer of [...layers].reverse()) {
    if (visited.has(layer.id) || structurallyReachable.has(layer.id)) continue;
    const children = childrenByParent.get(layer.id) ?? [];
    visited.add(layer.id);
    result.push({
      ...layer,
      parentId: null,
      level: 1,
      hasChildren: children.length > 0,
      positionInSet: 1,
      setSize: 1,
    });
    if ((layer.expanded ?? true) && children.length > 0) {
      walk(layer.id, 2, new Set([layer.id]));
    }
  }
  return result;
}

export function canvasLayerDropPosition(
  offsetY: number,
  rowHeight: number,
  hasChildren: boolean,
  threshold = CANVAS_LAYERS_DROP_THRESHOLD_PX
): CanvasLayerDropPosition {
  const safeThreshold = Math.min(Math.max(0, threshold), Math.max(0, rowHeight / 2));
  if (offsetY <= safeThreshold) return 'before';
  if (offsetY >= rowHeight - safeThreshold) return 'after';
  return hasChildren && offsetY < rowHeight ? 'into' : offsetY < rowHeight / 2 ? 'before' : 'after';
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function CanvasLayersPanel({
  layers,
  selectedIds,
  onSelectionChange,
  onToggleExpanded,
  onRename,
  onToggleVisibility,
  onToggleLock,
  onDropIntent,
  emptyMessage = 'No layers on this canvas.',
  className,
}: CanvasLayersPanelProps) {
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(selectedIds[0] ?? null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<CanvasLayerDropIntent | null>(null);
  const anchorIdRef = useRef<string | null>(selectedIds[0] ?? null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const isExpanded = useCallback(
    (layer: CanvasLayerItem) => expandedOverrides[layer.id] ?? layer.expanded ?? true,
    [expandedOverrides]
  );

  const visibleLayers = useMemo(
    () => visibleCanvasLayers(layers.map((layer) => ({ ...layer, expanded: isExpanded(layer) }))),
    [isExpanded, layers]
  );

  const visibleRows = useMemo(
    () =>
      visibleLayers.map((layer) => ({
        ...layer,
        expanded: isExpanded(layer),
      })),
    [isExpanded, visibleLayers]
  );

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  const focusRow = useCallback((id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  const selectLayer = useCallback(
    (id: string, event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
      const ids = visibleRows.map((layer) => layer.id);
      const index = ids.indexOf(id);
      if (index < 0) return;
      const additive = Boolean(event.metaKey || event.ctrlKey);
      const anchor = anchorIdRef.current ? ids.indexOf(anchorIdRef.current) : -1;
      let next: string[];
      if (event.shiftKey && anchor >= 0) {
        const start = Math.min(anchor, index);
        const end = Math.max(anchor, index);
        const range = ids.slice(start, end + 1);
        next = additive ? uniqueIds([...selectedIds, ...range]) : range;
      } else if (additive) {
        next = selectedIds.includes(id)
          ? selectedIds.filter((selectedId) => selectedId !== id)
          : [...selectedIds, id];
      } else {
        next = [id];
      }
      anchorIdRef.current = id;
      setFocusedId(id);
      onSelectionChange(uniqueIds(next));
    },
    [onSelectionChange, selectedIds, visibleRows]
  );

  const toggleExpanded = useCallback(
    (layer: CanvasLayerItem) => {
      const expanded = !isExpanded(layer);
      setExpandedOverrides((current) => ({ ...current, [layer.id]: expanded }));
      onToggleExpanded?.(layer.id, expanded);
    },
    [isExpanded, onToggleExpanded]
  );

  const beginRename = useCallback((layer: CanvasLayerItem) => {
    setEditingId(layer.id);
    setEditingName(layer.name);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);

  const commitRename = useCallback(() => {
    if (!editingId) return;
    const name = editingName.trim();
    const layer = layers.find((candidate) => candidate.id === editingId);
    if (name && layer && name !== layer.name) onRename?.(editingId, name);
    cancelRename();
  }, [cancelRename, editingId, editingName, layers, onRename]);

  const handleKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, layer: VisibleCanvasLayer & { expanded: boolean }) => {
      const index = visibleRows.findIndex((candidate) => candidate.id === layer.id);
      const parent = layer.parentId
        ? visibleRows.find((candidate) => candidate.id === layer.parentId)
        : undefined;
      const firstChild = layer.hasChildren
        ? visibleRows.find((candidate) => candidate.parentId === layer.id)
        : undefined;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const nextId = visibleRows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.id;
        if (event.shiftKey && nextId) {
          if (
            !anchorIdRef.current ||
            !visibleRows.some((candidate) => candidate.id === anchorIdRef.current)
          ) {
            anchorIdRef.current = layer.id;
          }
          selectLayer(nextId, event);
        }
        focusRow(nextId);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        focusRow(visibleRows[event.key === 'Home' ? 0 : visibleRows.length - 1]?.id);
        return;
      }
      if (event.key === 'ArrowRight' && layer.hasChildren) {
        event.preventDefault();
        if (!layer.expanded) toggleExpanded(layer);
        else focusRow(firstChild?.id);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (layer.hasChildren && layer.expanded) toggleExpanded(layer);
        else focusRow(parent?.id);
        return;
      }
      if (event.key === 'F2' || event.key === 'Enter') {
        event.preventDefault();
        beginRename(layer);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        selectLayer(layer.id, event);
      }
    },
    [beginRename, focusRow, selectLayer, toggleExpanded, visibleRows]
  );

  const makeDropIntent = useCallback(
    (event: DragEvent<HTMLDivElement>, target: VisibleCanvasLayer): CanvasLayerDropIntent => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
        draggedId: draggedId ?? event.dataTransfer.getData('text/plain'),
        targetId: target.id,
        position: canvasLayerDropPosition(
          event.clientY - rect.top,
          rect.height,
          target.hasChildren
        ),
      };
    },
    [draggedId]
  );
  const activeFocusedId =
    focusedId && visibleRows.some((layer) => layer.id === focusedId)
      ? focusedId
      : (visibleRows[0]?.id ?? null);

  return (
    <section className={`canvas-layers-panel${className ? ` ${className}` : ''}`}>
      <div className="canvas-layers-panel__header">
        <div className="canvas-layers-panel__title">
          <span>Components</span>
        </div>
        <span className="canvas-layers-panel__count" aria-live="polite">
          {layers.length}
        </span>
      </div>
      <div
        className="canvas-layers-panel__tree"
        role="tree"
        aria-label="Components"
        aria-multiselectable="true"
      >
        {visibleRows.length === 0 ? (
          <p className="canvas-layers-panel__empty">{emptyMessage}</p>
        ) : (
          <div className="canvas-layers-panel__rows">
            {visibleRows.map((layer) => {
              const selected = selectedIds.includes(layer.id);
              const dropPosition =
                dropTarget?.targetId === layer.id ? dropTarget.position : undefined;
              return (
                <div
                  key={layer.id}
                  ref={(element) => {
                    if (element) rowRefs.current.set(layer.id, element);
                    else rowRefs.current.delete(layer.id);
                  }}
                  className={`canvas-layers-panel__item${selected ? ' is-selected' : ''}${
                    dropPosition ? ` is-drop-${dropPosition}` : ''
                  }`}
                  role="treeitem"
                  aria-level={layer.level}
                  aria-selected={selected}
                  aria-expanded={layer.hasChildren ? layer.expanded : undefined}
                  aria-posinset={layer.positionInSet}
                  aria-setsize={layer.setSize}
                  tabIndex={activeFocusedId === layer.id ? 0 : -1}
                  data-canvas-layer-id={layer.id}
                  draggable={!layer.locked}
                  onFocus={() => setFocusedId(layer.id)}
                  onClick={(event) => selectLayer(layer.id, event)}
                  onDoubleClick={() => beginRename(layer)}
                  onKeyDown={(event) => handleKeyboard(event, layer)}
                  onDragStart={(event) => {
                    setDraggedId(layer.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', layer.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    const intent = makeDropIntent(event, layer);
                    setDropTarget(intent);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    const intent = makeDropIntent(event, layer);
                    onDropIntent?.(intent);
                    setDraggedId(null);
                    setDropTarget(null);
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDropTarget(null);
                  }}
                >
                  <span className="canvas-layers-panel__content">
                    {layer.hasChildren && (
                      <IconButton
                        variant="ghost"
                        size="compact"
                        className="canvas-layers-panel__disclosure"
                        aria-label={`${layer.expanded ? 'Collapse' : 'Expand'} ${layer.name}`}
                        icon={
                          layer.expanded ? (
                            <ChevronIcon size={14} aria-hidden="true" />
                          ) : (
                            <ChevronRightIcon size={14} aria-hidden="true" />
                          )
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(layer);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      />
                    )}
                    <span className="canvas-layers-panel__icon" aria-hidden="true">
                      {layer.icon ?? <ComponentsIcon size={14} />}
                    </span>
                  </span>
                  {editingId === layer.id ? (
                    <input
                      ref={inputRef}
                      className="canvas-layers-panel__rename"
                      aria-label={`Rename ${layer.name}`}
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') commitRename();
                        if (event.key === 'Escape') cancelRename();
                      }}
                    />
                  ) : (
                    <span className="canvas-layers-panel__name">{layer.name}</span>
                  )}
                  <span className="canvas-layers-panel__actions">
                    <IconButton
                      variant="ghost"
                      size="compact"
                      aria-label={`${layer.visible === false ? 'Show' : 'Hide'} ${layer.name}`}
                      aria-pressed={layer.visible === false}
                      icon={
                        layer.visible === false ? (
                          <EyeOffIcon size={14} aria-hidden="true" />
                        ) : (
                          <EyeIcon size={14} aria-hidden="true" />
                        )
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleVisibility?.(layer.id, layer.visible === false);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                    <IconButton
                      variant="ghost"
                      size="compact"
                      aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}
                      aria-pressed={layer.locked === true}
                      icon={
                        layer.locked ? (
                          <LockedIcon size={14} aria-hidden="true" />
                        ) : (
                          <UnlockedIcon size={14} aria-hidden="true" />
                        )
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleLock?.(layer.id, layer.locked !== true);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
