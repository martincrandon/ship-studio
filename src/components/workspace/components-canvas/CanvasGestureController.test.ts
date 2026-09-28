import { describe, expect, it } from 'vitest';
import { canvasRectContains, normalizeCanvasRect, panFromPointer } from './CanvasGestureController';

describe('component canvas gestures', () => {
  it('normalizes a marquee regardless of drag direction', () => {
    expect(normalizeCanvasRect({ start: { x: 80, y: 40 }, current: { x: 20, y: 10 } })).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 30,
    });
  });

  it('selects only nodes fully contained by a marquee', () => {
    const rect = { x: 10, y: 10, width: 100, height: 100 };
    expect(canvasRectContains(rect, { x: 20, y: 20, width: 40, height: 40 })).toBe(true);
    expect(canvasRectContains(rect, { x: 0, y: 20, width: 40, height: 40 })).toBe(false);
  });

  it('keeps the camera origin stable while panning', () => {
    expect(panFromPointer({ x: 4, y: 8, zoom: 1.5 }, { x: 10, y: 10 }, { x: 25, y: 4 })).toEqual({
      x: 19,
      y: 2,
      zoom: 1.5,
    });
  });
});
