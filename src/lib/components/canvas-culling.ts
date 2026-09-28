import { screenToWorld, type CanvasCameraState } from './canvas-camera';
import type { ComponentCanvasNode } from './canvas';
import { rotatedRectBounds } from './canvas-geometry';

export const COMPONENT_CANVAS_DEFAULT_OVERSCAN = 320;

export interface CanvasViewportSize {
  width: number;
  height: number;
}

/** Converts the screen viewport into world bounds with a small overscan. */
export function canvasViewportWorldBounds(
  camera: CanvasCameraState,
  viewport: CanvasViewportSize,
  overscan = COMPONENT_CANVAS_DEFAULT_OVERSCAN
) {
  const safeZoom = Math.max(camera.zoom, Number.EPSILON);
  const padding = overscan / safeZoom;
  const topLeft = screenToWorld({ x: 0, y: 0 }, camera);
  const bottomRight = screenToWorld({ x: viewport.width, y: viewport.height }, camera);
  return {
    x: topLeft.x - padding,
    y: topLeft.y - padding,
    width: bottomRight.x - topLeft.x + padding * 2,
    height: bottomRight.y - topLeft.y + padding * 2,
  };
}

/** Mounts only nearby nodes; selected nodes remain mounted for keyboard focus. */
export function cullCanvasNodes(
  nodes: readonly ComponentCanvasNode[],
  camera: CanvasCameraState,
  viewport: CanvasViewportSize,
  keepNodeIds: readonly string[] = [],
  overscan = COMPONENT_CANVAS_DEFAULT_OVERSCAN
): ComponentCanvasNode[] {
  const bounds = canvasViewportWorldBounds(camera, viewport, overscan);
  const keep = new Set(keepNodeIds);
  return nodes.filter((node) => {
    if (keep.has(node.id)) return true;
    const rotation =
      typeof (node as ComponentCanvasNode & { rotation?: unknown }).rotation === 'number'
        ? ((node as ComponentCanvasNode & { rotation?: number }).rotation ?? 0)
        : 0;
    const visibleBounds = rotatedRectBounds(
      { x: node.x, y: node.y, width: node.width, height: node.height },
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      rotation
    );
    return (
      visibleBounds.x < bounds.x + bounds.width &&
      visibleBounds.x + visibleBounds.width > bounds.x &&
      visibleBounds.y < bounds.y + bounds.height &&
      visibleBounds.y + visibleBounds.height > bounds.y
    );
  });
}
