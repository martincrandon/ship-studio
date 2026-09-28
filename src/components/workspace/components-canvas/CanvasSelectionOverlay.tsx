import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { CanvasCameraState } from '../../../lib/components/canvas-camera';

export interface CanvasSelectionNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export type CanvasResizeHandle =
  | 'rotate'
  | 'north-west'
  | 'north'
  | 'north-east'
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west';

export interface CanvasSelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CanvasTitleNode extends CanvasSelectionNode {
  name: string;
  /** Shows that the frame currently displays its cached poster image. */
  snapshot?: boolean;
}

function rotatedCorners(node: CanvasSelectionNode): Array<{ x: number; y: number }> {
  const radians = ((node.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  return [
    { x: -node.width / 2, y: -node.height / 2 },
    { x: node.width / 2, y: -node.height / 2 },
    { x: node.width / 2, y: node.height / 2 },
    { x: -node.width / 2, y: node.height / 2 },
  ].map((point) => ({
    x: center.x + point.x * cos - point.y * sin,
    y: center.y + point.x * sin + point.y * cos,
  }));
}

export function selectionBoundsForNodes(
  nodes: readonly CanvasSelectionNode[]
): CanvasSelectionBounds | null {
  if (nodes.length === 0) return null;
  const corners = nodes.flatMap(rotatedCorners);
  return {
    left: Math.min(...corners.map((corner) => corner.x)),
    top: Math.min(...corners.map((corner) => corner.y)),
    right: Math.max(...corners.map((corner) => corner.x)),
    bottom: Math.max(...corners.map((corner) => corner.y)),
  };
}

function screenBoundsForNode(
  node: CanvasSelectionNode,
  camera: CanvasCameraState
): CanvasSelectionBounds {
  const corners = rotatedCorners(node);
  return {
    left: Math.min(...corners.map((corner) => corner.x)) * camera.zoom + camera.x,
    top: Math.min(...corners.map((corner) => corner.y)) * camera.zoom + camera.y,
    right: Math.max(...corners.map((corner) => corner.x)) * camera.zoom + camera.x,
    bottom: Math.max(...corners.map((corner) => corner.y)) * camera.zoom + camera.y,
  };
}

export function CanvasSelectionOverlay({
  nodes,
  selectedIds,
  onResizeStart,
  onResizeKeyboardStart,
  camera,
  label,
  titleNodes,
  onTitlePointerDown,
  onTitleSelect,
  onTitleRename,
}: {
  nodes: readonly CanvasSelectionNode[];
  selectedIds: readonly string[];
  onResizeStart?: (event: ReactPointerEvent<HTMLButtonElement>, handle: CanvasResizeHandle) => void;
  onResizeKeyboardStart?: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    handle: CanvasResizeHandle
  ) => void;
  camera?: CanvasCameraState;
  label?: string;
  titleNodes?: readonly CanvasTitleNode[];
  onTitlePointerDown?: (event: ReactPointerEvent<HTMLElement>, nodeId: string) => void;
  onTitleSelect?: (nodeId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onTitleRename?: (nodeId: string, name: string) => void;
}) {
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editingTitleRef = useRef<HTMLSpanElement>(null);
  const titles = titleNodes ?? [];
  const selected = useMemo(
    () => nodes.filter((node) => selectedIds.includes(node.id)),
    [nodes, selectedIds]
  );
  const beginTitleRename = useCallback((node: CanvasTitleNode) => {
    setEditingTitleId(node.id);
    setEditingTitle(node.name);
  }, []);

  const cancelTitleRename = useCallback(() => {
    setEditingTitleId(null);
    setEditingTitle('');
  }, []);

  const commitTitleRename = useCallback(
    (node: CanvasTitleNode) => {
      const next = editingTitle.trim().slice(0, 128);
      if (next && next !== node.name) onTitleRename?.(node.id, next);
      cancelTitleRename();
    },
    [cancelTitleRename, editingTitle, onTitleRename]
  );

  useEffect(() => {
    if (!editingTitleId || !editingTitleRef.current) return;
    const ownerDocument = editingTitleRef.current.ownerDocument;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && editingTitleRef.current?.contains(event.target)) return;
      const node = titles.find((candidate) => candidate.id === editingTitleId);
      if (node) commitTitleRename(node);
    };
    ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
    return () => ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
  }, [commitTitleRename, editingTitleId, titles]);

  const bounds = selectionBoundsForNodes(selected);
  const single = selected.length === 1;
  const resolvedCamera = camera ?? { x: 0, y: 0, zoom: 1 };
  if (!bounds && titles.length === 0) return null;
  const screenLeft = bounds ? bounds.left * resolvedCamera.zoom + resolvedCamera.x : 0;
  const screenTop = bounds ? bounds.top * resolvedCamera.zoom + resolvedCamera.y : 0;
  const screenWidth = bounds ? (bounds.right - bounds.left) * resolvedCamera.zoom : 0;
  const screenHeight = bounds ? (bounds.bottom - bounds.top) * resolvedCamera.zoom : 0;
  const dimensions = bounds
    ? `${Math.round(bounds.right - bounds.left)} × ${Math.round(bounds.bottom - bounds.top)}`
    : '';
  const resizeHandles = [
    'north',
    'east',
    'south',
    'west',
    'north-west',
    'north-east',
    'south-east',
    'south-west',
  ] as const;
  const rotationHandles = ['north-west', 'north-east', 'south-east', 'south-west'] as const;
  const cornerHandles = new Set<CanvasResizeHandle>([
    'north-west',
    'north-east',
    'south-east',
    'south-west',
  ]);

  return (
    <div
      className="component-canvas-selection-layer"
      data-testid="component-canvas-selection-layer"
    >
      {titles.map((node) => {
        const projected = screenBoundsForNode(node, resolvedCamera);
        const selectedTitle = selectedIds.includes(node.id);
        const editing = editingTitleId === node.id;
        return (
          <span
            key={node.id}
            ref={editing ? editingTitleRef : undefined}
            className={`component-canvas-node-title${selectedTitle ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
            style={{
              left: projected.left,
              top: projected.top,
              maxWidth: editing ? 'none' : projected.right - projected.left,
            }}
            data-testid={`component-canvas-node-title-${node.id}`}
            data-selected={selectedTitle ? 'true' : undefined}
            data-editing-value={editing ? editingTitle || ' ' : undefined}
            onPointerDown={(event) => {
              if (editing || event.detail === 2) {
                event.stopPropagation();
                return;
              }
              onTitlePointerDown?.(event, node.id);
            }}
            onClick={(event) => onTitleSelect?.(node.id, event)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
              beginTitleRename(node);
            }}
            role="button"
            tabIndex={0}
            aria-label={`Rename ${node.name}${node.snapshot ? ', snapshot' : ''}`}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !editing) {
                event.preventDefault();
                beginTitleRename(node);
              }
            }}
          >
            {editing ? (
              <input
                autoFocus
                className="component-canvas-node-title__input"
                aria-label={`Rename ${node.name}`}
                size={1}
                value={editingTitle}
                onChange={(event) => setEditingTitle(event.target.value)}
                onBlur={() => commitTitleRename(node)}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') commitTitleRename(node);
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelTitleRename();
                  }
                }}
              />
            ) : (
              <>
                {node.name}
                {node.snapshot ? (
                  <span
                    className="component-canvas-node-title__snapshot"
                    data-testid={`component-canvas-node-title-snapshot-${node.id}`}
                    aria-hidden="true"
                  >
                    Snapshot
                  </span>
                ) : null}
              </>
            )}
          </span>
        );
      })}
      {bounds ? (
        <div
          className="component-canvas-selection-overlay"
          style={{ left: screenLeft, top: screenTop, width: screenWidth, height: screenHeight }}
          data-testid="component-canvas-selection-overlay"
        >
          {single ? (
            <>
              <span className="component-canvas-selection-dimensions">{dimensions}</span>
              {label ? <span className="component-canvas-selection-label">{label}</span> : null}
            </>
          ) : null}
          {single && onResizeStart
            ? rotationHandles.map((handle) => (
                <button
                  key={`rotate-${handle}`}
                  type="button"
                  className={`component-canvas-selection-handle component-canvas-selection-handle--rotate component-canvas-selection-handle--rotate-${handle}`}
                  aria-label={`Rotate selection from ${handle.replace(/-/g, ' ')} corner`}
                  data-canvas-handle-kind="rotate"
                  data-canvas-handle-visibility="hit-zone"
                  onPointerDown={(event) => onResizeStart(event, 'rotate')}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onResizeKeyboardStart?.(event, 'rotate');
                  }}
                />
              ))
            : null}
          {single && onResizeStart
            ? resizeHandles.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  className={`component-canvas-selection-handle component-canvas-selection-handle--${handle} component-canvas-selection-handle--${cornerHandles.has(handle) ? 'corner' : 'edge'}`}
                  aria-label={`Resize selection ${handle.replace('-', ' ')}`}
                  data-canvas-handle-visibility={cornerHandles.has(handle) ? 'visible' : 'hit-zone'}
                  onPointerDown={(event) => onResizeStart(event, handle)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onResizeKeyboardStart?.(event, handle);
                  }}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}
