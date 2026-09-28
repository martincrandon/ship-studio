import { describe, expect, it } from 'vitest';
import type { ComponentCanvasNode } from './canvas';
import {
  bringCanvasNodesToFront,
  createCanvasGuide,
  deleteCanvasGuide,
  hitTestCanvasNodes,
  moveCanvasGuide,
  quantizeRotationDegrees,
  reorderCanvasNodes,
  resizeRect,
  rotationFromPointers,
  selectCanvasNodesInMarquee,
  snapCanvasRect,
  translateCanvasNodes,
} from './canvas-geometry';

const node = (id: string, x: number, y: number, order: number): ComponentCanvasNode => ({
  id,
  scope: 'all',
  componentId: id,
  presetId: null,
  x,
  y,
  width: 100,
  height: 80,
  order,
  collapsed: false,
  generated: false,
  presentation: { background: 'surface', breakpoint: null, locale: null },
});

describe('canvas scene geometry', () => {
  it('uses stable z-order hit testing and ordered marquee selection', () => {
    const nodes = [node('b', 0, 0, 1), node('a', 0, 0, 1), node('c', 150, 0, 0)];
    expect(hitTestCanvasNodes(nodes, { x: 20, y: 20 })?.id).toBe('b');
    expect(selectCanvasNodesInMarquee(nodes, { x: -1, y: -1, width: 110, height: 90 })).toEqual([
      'a',
      'b',
    ]);
  });

  it('translates only selected nodes and keeps resize opposite-edge anchored', () => {
    const nodes = [node('a', 10, 10, 0), node('b', 50, 50, 1)];
    expect(translateCanvasNodes(nodes, ['b'], { x: 5, y: -4 })[0]).toEqual(nodes[0]);
    expect(translateCanvasNodes(nodes, ['b'], { x: 5, y: -4 })[1]).toMatchObject({ x: 55, y: 46 });
    expect(resizeRect({ x: 10, y: 10, width: 100, height: 80 }, 'nw', { x: 20, y: 10 })).toEqual({
      x: 30,
      y: 20,
      width: 80,
      height: 70,
    });
  });

  it('snaps in world units using zoom-aware screen threshold and exposes guides', () => {
    const result = snapCanvasRect(
      { x: 98, y: 20, width: 40, height: 20 },
      [{ x: 100, y: 200, width: 80, height: 80, nodeId: 'peer' }],
      { zoom: 2, threshold: 8, gridSize: 100 }
    );
    expect(result.rect.x).toBe(100);
    expect(result.guides.some((guide) => guide.orientation === 'vertical')).toBe(true);
    expect(snapCanvasRect(result.rect, [], { ctrlKey: true }).guides).toEqual([]);
  });

  it('returns peer identity and finite cross-artboard guide ranges', () => {
    const result = snapCanvasRect(
      { x: 98, y: 250, width: 40, height: 20 },
      [{ x: 100, y: 200, width: 80, height: 80, nodeId: 'peer' }],
      { zoom: 1, threshold: 8, gridSize: 1000 }
    );
    expect(result.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orientation: 'vertical',
          peerNodeId: 'peer',
          segment: { start: 200, end: 280 },
        }),
      ])
    );
  });

  it('quantizes rotation by 15 degrees and reports Alt center-origin semantics', () => {
    expect(quantizeRotationDegrees(22, true)).toBe(15);
    expect(
      rotationFromPointers(
        { x: 10, y: 0 },
        { x: 0, y: 10 },
        { x: 0, y: 0, width: 20, height: 20 },
        { altKey: true, shiftKey: true }
      )
    ).toMatchObject({ angle: 90, centerOrigin: true, quantized: true, origin: { x: 10, y: 10 } });
  });

  it('reorders selected nodes and lets user guides participate in snapping', () => {
    const nodes = [node('a', 0, 0, 0), node('b', 20, 0, 1), node('c', 40, 0, 2)];
    expect(bringCanvasNodesToFront(nodes, ['a']).find((item) => item.id === 'a')?.order).toBe(2);
    expect(
      reorderCanvasNodes(nodes, ['c'], 'send-backward').find((item) => item.id === 'c')?.order
    ).toBe(1);
    const withGuide = createCanvasGuide([], { orientation: 'vertical', position: 100 });
    const movedGuide = moveCanvasGuide(withGuide, withGuide[0]!.id!, 102);
    const snapped = snapCanvasRect({ x: 100, y: 10, width: 20, height: 20 }, [], {
      threshold: 8,
      guides: movedGuide,
      gridSize: 1000,
    });
    expect(snapped.guides[0]).toMatchObject({ kind: 'guide', position: 102 });
  });

  it('snaps all rectangle anchors to a guide and respects locked guide lifecycle', () => {
    const guides = createCanvasGuide([], {
      id: 'center-line',
      orientation: 'vertical',
      position: 100,
    });
    const centered = snapCanvasRect({ x: 91, y: 10, width: 20, height: 20 }, [], {
      threshold: 2,
      gridSize: 1000,
      guides,
    });
    expect(centered.rect.x).toBe(90);
    expect(centered.guides[0]).toMatchObject({ id: 'center-line', position: 100 });

    const locked = createCanvasGuide([], {
      id: 'locked',
      orientation: 'horizontal',
      position: 10,
      locked: true,
    });
    expect(moveCanvasGuide(locked, 'locked', 20)).toEqual(locked);
    expect(deleteCanvasGuide(locked, 'locked')).toEqual(locked);
  });
});
