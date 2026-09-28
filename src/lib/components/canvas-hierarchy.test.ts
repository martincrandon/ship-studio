import { describe, expect, it } from 'vitest';
import {
  canvasNodeWorldPosition,
  canvasWorldToLocalPosition,
  normalizeCanvasHierarchySelection,
  reparentCanvasNodes,
  toCanvasWorldNodes,
  type CanvasHierarchyNode,
} from './canvas-hierarchy';

const node = (
  id: string,
  x: number,
  y: number,
  parentId: string | null = null
): CanvasHierarchyNode => ({
  id,
  x,
  y,
  width: 100,
  height: 80,
  parentId,
});

describe('canvas hierarchy operations', () => {
  it('normalizes multi-selection to avoid ancestor and descendant together', () => {
    const nodes = [node('root', 10, 20), node('child', 5, 6, 'root'), node('leaf', 2, 3, 'child')];
    expect(normalizeCanvasHierarchySelection(['leaf', 'root', 'child'], nodes)).toEqual({
      ids: ['root'],
      removedDescendantIds: ['leaf', 'child'],
    });
  });

  it('reparents deterministically while preserving world position', () => {
    const nodes = [node('a', 10, 20), node('b', 100, 200), node('child', 5, 6, 'a')];
    const result = reparentCanvasNodes(nodes, ['child'], 'b');
    expect(result.accepted).toBe(true);
    expect(result.nodes.find((item) => item.id === 'child')).toMatchObject({
      parentId: 'b',
      x: -85,
      y: -174,
    });
  });

  it('projects nested parent-local nodes into world space and back safely', () => {
    const nodes = [
      node('root', 10, 20),
      node('parent', 30, 40, 'root'),
      node('child', 5, 6, 'parent'),
    ];
    expect(canvasNodeWorldPosition('child', nodes)).toEqual({ x: 45, y: 66 });
    expect(toCanvasWorldNodes([nodes[2]], nodes)[0]).toMatchObject({ x: 45, y: 66 });
    expect(canvasWorldToLocalPosition('child', { x: 80, y: 90 }, nodes)).toEqual({
      x: 40,
      y: 30,
    });
  });

  it('stops malformed hierarchy cycles without looping', () => {
    const nodes = [node('a', 10, 20, 'b'), node('b', 30, 40, 'a')];
    expect(canvasNodeWorldPosition('a', nodes)).toEqual({ x: 40, y: 60 });
    expect(toCanvasWorldNodes(nodes, nodes).map((item) => [item.x, item.y])).toEqual([
      [40, 60],
      [40, 60],
    ]);
  });

  it('rejects cycles without partially mutating the scene', () => {
    const nodes = [node('root', 0, 0), node('child', 1, 2, 'root')];
    const result = reparentCanvasNodes(nodes, ['root'], 'child');
    expect(result).toMatchObject({ accepted: false, reason: 'cycle', movedIds: [] });
    expect(result.nodes).toEqual(nodes);
  });
});
