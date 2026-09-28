import { COMPONENT_CANVAS_MAX_LOGICAL_NODES } from './canvas';

export interface RendererStaticSnapshot {
  snapshotKey: string;
  path: string;
}

/**
 * Small project-scoped cache for screenshots used by non-live canvas cards.
 *
 * The cache stores only the path returned by the native screenshot command.
 * Image bytes are loaded by the card that is currently mounted, and an exact
 * render-input key is required before a path can be shown again.
 */
export class RendererSnapshotCache {
  private readonly maxEntries: number;
  private readonly snapshots = new Map<string, RendererStaticSnapshot>();

  constructor(maxEntries = COMPONENT_CANVAS_MAX_LOGICAL_NODES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(nodeId: string): RendererStaticSnapshot | undefined {
    return this.snapshots.get(nodeId);
  }

  getExact(nodeId: string, snapshotKey: string): RendererStaticSnapshot | undefined {
    const snapshot = this.snapshots.get(nodeId);
    return snapshot?.snapshotKey === snapshotKey ? snapshot : undefined;
  }

  set(nodeId: string, snapshot: RendererStaticSnapshot): void {
    this.snapshots.delete(nodeId);
    this.snapshots.set(nodeId, snapshot);
    while (this.snapshots.size > this.maxEntries) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }

  delete(nodeId: string): void {
    this.snapshots.delete(nodeId);
  }

  clear(): void {
    this.snapshots.clear();
  }

  get size(): number {
    return this.snapshots.size;
  }
}
