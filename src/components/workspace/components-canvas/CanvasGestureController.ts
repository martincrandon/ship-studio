import type { CameraPoint, CanvasCameraState } from '../../../lib/components/canvas-camera';

export interface CanvasMarquee {
  start: CameraPoint;
  current: CameraPoint;
  shiftKey?: boolean;
}

export function normalizeCanvasRect(marquee: CanvasMarquee) {
  return {
    x: Math.min(marquee.start.x, marquee.current.x),
    y: Math.min(marquee.start.y, marquee.current.y),
    width: Math.abs(marquee.current.x - marquee.start.x),
    height: Math.abs(marquee.current.y - marquee.start.y),
  };
}

export function canvasRectContains(
  rect: { x: number; y: number; width: number; height: number },
  node: { x: number; y: number; width: number; height: number }
) {
  return (
    node.x >= rect.x &&
    node.y >= rect.y &&
    node.x + node.width <= rect.x + rect.width &&
    node.y + node.height <= rect.y + rect.height
  );
}

export function panFromPointer(
  origin: CanvasCameraState,
  start: CameraPoint,
  current: CameraPoint
): CanvasCameraState {
  return { ...origin, x: origin.x + current.x - start.x, y: origin.y + current.y - start.y };
}
