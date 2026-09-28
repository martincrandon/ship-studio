import { invoke } from '@tauri-apps/api/core';

/** Metadata for a renderer image persisted in the active project's manifest. */
export interface RendererSnapshotRecord {
  nodeId: string;
  snapshotKey: string;
  path: string;
}

/**
 * Load the explicit project-scoped renderer snapshot records.
 *
 * The native command filters stale or unsafe records and only returns image
 * paths that still exist in this project's managed screenshots directory.
 */
export function readRendererSnapshots(projectPath: string): Promise<RendererSnapshotRecord[]> {
  return invoke<RendererSnapshotRecord[]>('get_component_renderer_snapshots', { projectPath });
}

/** Persist the latest snapshot for one canvas node. */
export function upsertRendererSnapshot(
  projectPath: string,
  snapshot: RendererSnapshotRecord
): Promise<RendererSnapshotRecord> {
  return invoke<RendererSnapshotRecord>('upsert_component_renderer_snapshot', {
    projectPath,
    request: snapshot,
  });
}

// These names read naturally at call sites that treat the manifest as a
// project cache. Keep the command-oriented names above as the canonical API.
export const loadRendererSnapshots = readRendererSnapshots;
export const persistRendererSnapshot = upsertRendererSnapshot;
export const readRendererSnapshotRecords = readRendererSnapshots;
export const persistRendererSnapshotRecord = upsertRendererSnapshot;
