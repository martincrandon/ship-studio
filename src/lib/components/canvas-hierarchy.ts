import type { ComponentCanvasNode } from './canvas';

export type CanvasHierarchyNode = Pick<
  ComponentCanvasNode,
  'id' | 'x' | 'y' | 'width' | 'height'
> & {
  parentId?: string | null;
};

export interface CanvasSelectionNormalizationResult {
  ids: string[];
  removedDescendantIds: string[];
}

export interface CanvasReparentResult<T extends CanvasHierarchyNode> {
  nodes: T[];
  accepted: boolean;
  movedIds: string[];
  reason?: 'cycle' | 'missing-parent';
}

function parentOf(node: CanvasHierarchyNode): string | null {
  return typeof node.parentId === 'string' ? node.parentId : null;
}

function nodeMap(nodes: readonly CanvasHierarchyNode[]): Map<string, CanvasHierarchyNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** Cycle-safe ancestor check for malformed or partially edited scenes. */
export function isCanvasDescendant(
  nodes: readonly CanvasHierarchyNode[],
  nodeId: string,
  ancestorId: string
): boolean {
  const byId = nodeMap(nodes);
  const visited = new Set<string>();
  let current = byId.get(nodeId);
  while (current) {
    const parentId = parentOf(current);
    if (!parentId || visited.has(parentId)) return false;
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    current = byId.get(parentId);
  }
  return false;
}

/** Keeps the highest selected ancestor and drops selected descendants. */
export function normalizeCanvasHierarchySelection(
  nodeIds: readonly string[],
  nodes: readonly CanvasHierarchyNode[]
): CanvasSelectionNormalizationResult {
  const byId = nodeMap(nodes);
  const uniqueIds = [...new Set(nodeIds)].filter((id) => byId.has(id));
  const selected = new Set(uniqueIds);
  const removedDescendantIds: string[] = [];
  const ids = uniqueIds.filter((id) => {
    let current = byId.get(id);
    const visited = new Set<string>();
    while (current) {
      const parentId = parentOf(current);
      if (!parentId || visited.has(parentId)) break;
      if (selected.has(parentId)) {
        removedDescendantIds.push(id);
        return false;
      }
      visited.add(parentId);
      current = byId.get(parentId);
    }
    return true;
  });
  return { ids, removedDescendantIds };
}

function worldOrigin(
  nodeId: string,
  byId: Map<string, CanvasHierarchyNode>
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current = byId.get(nodeId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    x += Number.isFinite(current.x) ? current.x : 0;
    y += Number.isFinite(current.y) ? current.y : 0;
    const parentId = parentOf(current);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return { x, y };
}

export interface CanvasWorldPosition {
  x: number;
  y: number;
}

/** Returns an accumulated world position while defensively stopping cycles. */
export function canvasNodeWorldPosition(
  nodeId: string,
  nodes: readonly CanvasHierarchyNode[]
): CanvasWorldPosition {
  return worldOrigin(nodeId, nodeMap(nodes));
}

/** Converts a world position into the node's persisted parent-local position. */
export function canvasWorldToLocalPosition(
  nodeId: string,
  world: CanvasWorldPosition,
  nodes: readonly CanvasHierarchyNode[]
): CanvasWorldPosition {
  const byId = nodeMap(nodes);
  const node = byId.get(nodeId);
  const parentId = node ? parentOf(node) : null;
  const parentOrigin = parentId ? worldOrigin(parentId, byId) : { x: 0, y: 0 };
  return { x: world.x - parentOrigin.x, y: world.y - parentOrigin.y };
}

/** Projects parent-local persisted nodes into world-space interaction nodes. */
export function toCanvasWorldNodes<T extends CanvasHierarchyNode>(
  nodes: readonly T[],
  hierarchy: readonly CanvasHierarchyNode[] = nodes
): T[] {
  return nodes.map((node) => {
    const world = worldOrigin(node.id, nodeMap(hierarchy));
    return { ...node, x: world.x, y: world.y };
  });
}

/**
 * Reparents a normalized selection while keeping world-space position. The
 * whole operation is rejected when any moved node would become its own
 * ancestor, so partial hierarchy mutations cannot leave a confusing scene.
 */
export function reparentCanvasNodes<T extends CanvasHierarchyNode>(
  nodes: readonly T[],
  nodeIds: readonly string[],
  nextParentId: string | null
): CanvasReparentResult<T> {
  const normalized = normalizeCanvasHierarchySelection(nodeIds, nodes);
  const byId = nodeMap(nodes);
  if (nextParentId !== null && !byId.has(nextParentId)) {
    return { nodes: [...nodes], accepted: false, movedIds: [], reason: 'missing-parent' };
  }
  const moved = new Set(normalized.ids);
  if (
    nextParentId !== null &&
    (moved.has(nextParentId) ||
      normalized.ids.some((id) => isCanvasDescendant(nodes, nextParentId, id)))
  ) {
    return { nodes: [...nodes], accepted: false, movedIds: [], reason: 'cycle' };
  }
  const parentOrigin = nextParentId === null ? { x: 0, y: 0 } : worldOrigin(nextParentId, byId);
  const worldPositions = new Map(normalized.ids.map((id) => [id, worldOrigin(id, byId)]));
  const result = nodes.map((node) => {
    const world = worldPositions.get(node.id);
    if (!world) return node;
    return {
      ...node,
      parentId: nextParentId,
      x: world.x - parentOrigin.x,
      y: world.y - parentOrigin.y,
    };
  });
  return { nodes: result, accepted: true, movedIds: normalized.ids };
}

export const normalizeHierarchySelection = normalizeCanvasHierarchySelection;
export const reparentNodes = reparentCanvasNodes;
