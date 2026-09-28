import { describe, expect, it } from 'vitest';
import {
  animateCamera,
  quantizeZoom,
  fitBounds,
  screenToWorld,
  wheelPanDelta,
  wheelZoomDelta,
  worldToScreen,
  zoomAt,
  zoomBy,
} from './canvas-camera';

describe('component canvas camera', () => {
  it('keeps the cursor world point fixed during zoom', () => {
    const camera = { x: 40, y: 20, zoom: 1 };
    const cursor = { x: 240, y: 140 };
    const next = zoomAt(camera, cursor, 2);
    const before = screenToWorld(cursor, camera);
    const after = screenToWorld(cursor, next);
    expect(after).toEqual(before);
  });

  it('matches Grida proportional wheel zoom', () => {
    const camera = { x: 40, y: 20, zoom: 2 };
    const cursor = { x: 240, y: 140 };
    const next = zoomBy(camera, cursor, wheelZoomDelta(50));

    expect(next.zoom).toBe(1);
    expect(screenToWorld(cursor, next)).toEqual(screenToWorld(cursor, camera));
  });

  it('matches Grida React surface wheel pan direction and sensitivity', () => {
    expect(wheelPanDelta(12, -8)).toEqual({ x: -24, y: 16 });
  });

  it('matches Grida keyboard zoom quantization', () => {
    expect(quantizeZoom(1.234)).toBe(1.23);
  });

  it('round-trips screen and world coordinates', () => {
    const camera = { x: -12, y: 8, zoom: 1.5 };
    const world = { x: 120, y: 80 };
    expect(screenToWorld(worldToScreen(world, camera), camera)).toEqual(world);
  });

  it('fits bounds inside a viewport and clamps extreme zoom', () => {
    const camera = fitBounds(
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 1000, height: 600 }
    );
    expect(camera.zoom).toBe(256);
    expect(worldToScreen({ x: 0.5, y: 0.5 }, camera)).toEqual({ x: 500, y: 300 });
  });

  it('can be cancelled before the interpolation completes', () => {
    const callbacks: FrameRequestCallback[] = [];
    const frames: ReturnType<typeof animateCamera>[] = [];
    const values: number[] = [];
    frames.push(
      animateCamera(
        { x: 0, y: 0, zoom: 1 },
        { x: 100, y: 50, zoom: 2 },
        {
          durationMs: 200,
          onFrame: (camera) => values.push(camera.x),
          requestFrame: (callback) => {
            callbacks.push(callback);
            return callbacks.length;
          },
          cancelFrame: () => undefined,
        }
      )
    );
    callbacks.shift()?.(100);
    frames[0]();
    callbacks.shift()?.(150);
    expect(values.length).toBe(1);
  });
});
