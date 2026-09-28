import { describe, expect, it } from 'vitest';
import { canvasViewportWorldBounds, cullCanvasNodes } from './canvas-culling';
import type { ComponentCanvasNode } from './canvas';

const node = (id: string, x: number, y: number): ComponentCanvasNode => ({
  id,
  scope: 'all',
  componentId: `react:${id}`,
  presetId: null,
  x,
  y,
  width: 100,
  height: 100,
  order: 0,
  collapsed: false,
  generated: true,
  presentation: { background: 'surface', breakpoint: null, locale: null },
});

describe('component canvas culling', () => {
  it('converts the viewport to world bounds at the current zoom', () => {
    expect(
      canvasViewportWorldBounds({ x: 10, y: 20, zoom: 2 }, { width: 200, height: 100 }, 0)
    ).toEqual({
      x: -5,
      y: -10,
      width: 100,
      height: 50,
    });
  });

  it('keeps nearby nodes and the selected node outside the viewport', () => {
    const nodes = [node('near', 20, 20), node('far', 10_000, 10_000)];
    expect(
      cullCanvasNodes(nodes, { x: 0, y: 0, zoom: 1 }, { width: 200, height: 200 }, ['far'], 0).map(
        (item) => item.id
      )
    ).toEqual(['near', 'far']);
  });

  it('culls by rotated visible extents rather than the unrotated card box', () => {
    const rotated = { ...node('rotated', 60, -40), width: 100, height: 40, rotation: 90 };
    expect(
      cullCanvasNodes([rotated], { x: 0, y: 0, zoom: 1 }, { width: 100, height: 100 }, [], 0)
    ).toEqual([rotated]);
  });
});
