import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  loadRendererSnapshots,
  persistRendererSnapshot,
  readRendererSnapshots,
  upsertRendererSnapshot,
} from './renderer-snapshot-storage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe('renderer snapshot storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the backend-filtered project snapshot manifest', async () => {
    const snapshots = [
      { nodeId: 'node-a', snapshotKey: 'v1', path: '/project/.shipstudio/screenshots/a.png' },
    ];
    invokeMock.mockResolvedValue(snapshots);

    await expect(readRendererSnapshots('/project')).resolves.toEqual(snapshots);
    expect(invokeMock).toHaveBeenCalledWith('get_component_renderer_snapshots', {
      projectPath: '/project',
    });
  });

  it('upserts one node snapshot with the explicit renderer record', async () => {
    const snapshot = {
      nodeId: 'node-a',
      snapshotKey: 'v2',
      path: '/project/.shipstudio/screenshots/a-v2.png',
    };
    invokeMock.mockResolvedValue(snapshot);

    await expect(upsertRendererSnapshot('/project', snapshot)).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith('upsert_component_renderer_snapshot', {
      projectPath: '/project',
      request: snapshot,
    });
  });

  it('provides cache-oriented aliases without changing the command contract', async () => {
    invokeMock.mockResolvedValue([]);
    await loadRendererSnapshots('/project');
    expect(invokeMock).toHaveBeenLastCalledWith('get_component_renderer_snapshots', {
      projectPath: '/project',
    });

    const snapshot = {
      nodeId: 'node-a',
      snapshotKey: 'v1',
      path: '/project/.shipstudio/screenshots/a.png',
    };
    invokeMock.mockResolvedValue(snapshot);
    await persistRendererSnapshot('/project', snapshot);
    expect(invokeMock).toHaveBeenLastCalledWith('upsert_component_renderer_snapshot', {
      projectPath: '/project',
      request: snapshot,
    });
  });
});
