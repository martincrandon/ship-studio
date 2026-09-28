/** Keep these in sync with Grida's React canvas surface implementation. */
export const CANVAS_MIN_ZOOM = 0.02;
export const CANVAS_MAX_ZOOM = 256;
export const CANVAS_FIT_MARGIN = 64;
export const CANVAS_WHEEL_PAN_SENSITIVITY = 2;
export const CANVAS_WHEEL_ZOOM_SENSITIVITY = 0.01;
export const CANVAS_KEYBOARD_ZOOM_STEP = 2;
export const CANVAS_ZOOM_QUANTIZATION = 0.01;
export const CANVAS_CAMERA_ANIMATION_MS = 200;
export const CANVAS_DRAG_THRESHOLD_PX = 4;

export interface CameraPoint {
  x: number;
  y: number;
}

export interface CameraBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasCameraState extends CameraPoint {
  zoom: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom));
}

/** Match Grida's keyboard zoom quantization before applying its clamp. */
export function quantizeZoom(zoom: number): number {
  return Math.round(zoom / CANVAS_ZOOM_QUANTIZATION) * CANVAS_ZOOM_QUANTIZATION;
}

export function screenToWorld(point: CameraPoint, camera: CanvasCameraState): CameraPoint {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

export function worldToScreen(point: CameraPoint, camera: CanvasCameraState): CameraPoint {
  return {
    x: point.x * camera.zoom + camera.x,
    y: point.y * camera.zoom + camera.y,
  };
}

/** Zoom around a screen-space cursor while keeping the world point below it fixed. */
export function zoomAt(
  camera: CanvasCameraState,
  screenPoint: CameraPoint,
  nextZoom: number
): CanvasCameraState {
  const zoom = clampZoom(nextZoom);
  const worldPoint = screenToWorld(screenPoint, camera);
  return {
    zoom,
    x: screenPoint.x - worldPoint.x * zoom,
    y: screenPoint.y - worldPoint.y * zoom,
  };
}

/** Apply Grida's proportional zoom delta around a screen-space origin. */
export function zoomBy(
  camera: CanvasCameraState,
  screenPoint: CameraPoint,
  delta: number
): CanvasCameraState {
  return zoomAt(camera, screenPoint, camera.zoom + camera.zoom * delta);
}

/** Convert a wheel delta into Grida's proportional zoom delta. */
export function wheelZoomDelta(deltaY: number): number {
  return -deltaY * CANVAS_WHEEL_ZOOM_SENSITIVITY;
}

/** Convert a wheel delta into Grida's screen-space pan delta. */
export function wheelPanDelta(deltaX: number, deltaY: number): CameraPoint {
  return {
    x: -deltaX * CANVAS_WHEEL_PAN_SENSITIVITY,
    y: -deltaY * CANVAS_WHEEL_PAN_SENSITIVITY,
  };
}

export function pan(camera: CanvasCameraState, delta: CameraPoint): CanvasCameraState {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

export function fitBounds(
  bounds: CameraBounds,
  viewport: CameraBounds,
  padding = CANVAS_FIT_MARGIN
): CanvasCameraState {
  if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
  }
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clampZoom(Math.min(availableWidth / bounds.width, availableHeight / bounds.height));
  return {
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}

export function cameraAnimationStep(
  from: CanvasCameraState,
  to: CanvasCameraState,
  progress: number
): CanvasCameraState {
  const amount = Math.min(1, Math.max(0, progress));
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    zoom: from.zoom + (to.zoom - from.zoom) * amount,
  };
}

/**
 * Starts a cancellable camera interpolation. Gesture callers can cancel the
 * returned handle before applying an immediate camera update.
 */
export function animateCamera(
  from: CanvasCameraState,
  to: CanvasCameraState,
  options: {
    durationMs?: number;
    onFrame: (camera: CanvasCameraState) => void;
    onComplete?: () => void;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (handle: number) => void;
  }
): () => void {
  const requestFrame =
    options.requestFrame ??
    ((callback: FrameRequestCallback) =>
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(callback)
        : window.setTimeout(() => callback(Date.now()), 16));
  const cancelFrame =
    options.cancelFrame ??
    ((handle: number) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
      else window.clearTimeout(handle);
    });
  const duration = Math.max(1, options.durationMs ?? CANVAS_CAMERA_ANIMATION_MS);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let cancelled = false;
  let handle = 0;
  const tick = (timestamp: number) => {
    if (cancelled) return;
    const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration));
    // Smoothstep keeps the fit transition calm without delaying direct input.
    const eased = progress * progress * (3 - 2 * progress);
    options.onFrame(cameraAnimationStep(from, to, eased));
    if (progress >= 1) {
      options.onComplete?.();
      return;
    }
    handle = requestFrame(tick);
  };
  handle = requestFrame(tick);
  return () => {
    cancelled = true;
    if (handle) cancelFrame(handle);
  };
}
