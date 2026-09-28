import { describe, expect, it } from 'vitest';
import { RendererFrameLifecycle, rendererSnapshotCommitIsCurrent } from './renderer-lifecycle';
import type { ComponentCanvasNode } from './canvas';

function candidate(
  id: string,
  overrides: Partial<Parameters<RendererFrameLifecycle['setCandidates']>[0][number]> = {}
) {
  const node: ComponentCanvasNode = {
    id,
    scope: 'all',
    componentId: `react:${id}`,
    presetId: null,
    x: 0,
    y: 0,
    width: 320,
    height: 480,
    order: 0,
    collapsed: false,
    generated: true,
    presentation: { background: 'surface', breakpoint: null, locale: null },
  };
  return {
    node,
    visible: true,
    distanceToViewportCenter: 0,
    selected: false,
    recentlyUsedAt: 0,
    ...overrides,
  };
}

describe('RendererFrameLifecycle', () => {
  it('allows snapshot commits only for the same live surface or its normal eviction', () => {
    const liveState = {
      nodeId: 'a',
      status: 'live' as const,
      snapshotKey: 'a:v1',
      failureCount: 0,
      retryNonce: 2,
      circuitOpen: false,
    };

    expect(rendererSnapshotCommitIsCurrent(liveState, 'a:v1', 2)).toBe(true);
    expect(rendererSnapshotCommitIsCurrent({ ...liveState, status: 'suspended' }, 'a:v1', 2)).toBe(
      true
    );
    expect(rendererSnapshotCommitIsCurrent({ ...liveState, status: 'queued' }, 'a:v1', 2)).toBe(
      false
    );
    expect(
      rendererSnapshotCommitIsCurrent({ ...liveState, status: 'placeholder' }, 'a:v1', 2)
    ).toBe(false);
    expect(rendererSnapshotCommitIsCurrent(liveState, 'a:v2', 2)).toBe(false);
    expect(rendererSnapshotCommitIsCurrent(liveState, 'a:v1', 3)).toBe(false);
    expect(rendererSnapshotCommitIsCurrent(null, 'a:v1', 2)).toBe(false);
  });

  it('queues the bounded live set and only becomes live after a handshake', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1 });
    expect(lifecycle.setCandidates([candidate('a'), candidate('b')])).toEqual(['a']);
    expect(lifecycle.stateFor('a')?.status).toBe('queued');
    expect(lifecycle.stateFor('b')?.status).toBe('suspended');
    expect(lifecycle.markLive('a')).toBe(true);
    expect(lifecycle.stateFor('a')?.status).toBe('live');
  });

  it('retains live frames until the hard budget requires deterministic eviction', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1, retainLiveFrames: true });
    lifecycle.setCandidates([candidate('a', { selected: true }), candidate('b')]);
    lifecycle.markLive('a');

    expect(lifecycle.setCandidates([candidate('a'), candidate('b', { selected: true })])).toEqual([
      'b',
    ]);
    expect(lifecycle.stateFor('a')?.status).toBe('suspended');
    expect(lifecycle.stateFor('b')?.status).toBe('queued');
    expect(lifecycle.consumeCancelledRequestIds()).toEqual(['a']);
  });

  it('evicts retained frames deterministically at the hard live budget', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 2, retainLiveFrames: true });
    lifecycle.setCandidates([candidate('a'), candidate('b')]);
    lifecycle.markLive('a');
    lifecycle.markLive('b');

    expect(
      lifecycle.setCandidates([
        candidate('a', { distanceToViewportCenter: 2 }),
        candidate('b', { distanceToViewportCenter: 3 }),
        candidate('c', { selected: true }),
      ])
    ).toEqual(['c']);
    const snapshot = lifecycle.snapshot();
    expect(snapshot.liveFrameIds).toEqual(['a']);
    expect(snapshot.queuedFrameIds).toEqual(['c']);
    expect(snapshot.liveFrameIds.length + snapshot.queuedFrameIds.length).toBeLessThanOrEqual(2);
    expect(lifecycle.stateFor('b')?.status).toBe('suspended');
    expect(lifecycle.consumeCancelledRequestIds()).toEqual(['b']);
    expect(lifecycle.markLive('b')).toBe(false);
  });

  it('keeps the six most recently accessed candidates in the live set', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 2, retainLiveFrames: true });
    lifecycle.setCandidates([
      candidate('a', { recentlyUsedAt: 1 }),
      candidate('b', { recentlyUsedAt: 2 }),
      candidate('c', { recentlyUsedAt: 3 }),
    ]);
    lifecycle.markLive('c');
    lifecycle.markLive('b');

    expect(
      lifecycle.setCandidates([
        candidate('a', { recentlyUsedAt: 4 }),
        candidate('b', { recentlyUsedAt: 1 }),
        candidate('c', { recentlyUsedAt: 3 }),
      ])
    ).toEqual(['a']);
    expect(lifecycle.snapshot().liveFrameIds).toEqual(['c']);
    expect(lifecycle.snapshot().queuedFrameIds).toEqual(['a']);
    expect(lifecycle.stateFor('b')?.status).toBe('suspended');
  });

  it('evicts the deterministic lowest-priority live frame for an imperative promotion', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1, retainLiveFrames: true });
    lifecycle.setCandidates([candidate('a'), candidate('b')]);
    lifecycle.markLive('a');

    lifecycle.setActiveFrame('b');

    expect(lifecycle.snapshot().liveFrameIds).toEqual([]);
    expect(lifecycle.snapshot().queuedFrameIds).toEqual(['b']);
    expect(lifecycle.consumeCancelledRequestIds()).toEqual(['a']);
  });

  it('uses only an exact snapshot key for inactive frames', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1 });
    lifecycle.setCandidates([
      candidate('a', { selected: true, snapshotKey: 'a:v2' }),
      candidate('b', { snapshotKey: 'b:v2', cachedSnapshotKey: 'b:v2' }),
      candidate('c', { snapshotKey: 'c:v2', cachedSnapshotKey: 'c:v1' }),
    ]);
    expect(lifecycle.stateFor('b')?.status).toBe('cached');
    expect(lifecycle.stateFor('c')?.status).toBe('suspended');
  });

  it('keeps a live selected frame live when its background snapshot is captured', () => {
    const selected = candidate('selected', { selected: true, snapshotKey: 'selected:v1' });
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1, retainLiveFrames: true });
    lifecycle.setCandidates([selected]);
    lifecycle.setActiveFrame('selected');
    expect(lifecycle.markLive('selected')).toBe(true);

    expect(lifecycle.markSnapshot('selected', 'selected:v1')).toBe(true);
    expect(lifecycle.stateFor('selected')?.status).toBe('live');
    expect(lifecycle.setCandidates([{ ...selected, cachedSnapshotKey: 'selected:v1' }])).toEqual(
      []
    );
    expect(lifecycle.stateFor('selected')?.status).toBe('live');
  });

  it('opens a circuit after repeated failures and allows explicit retry', () => {
    let now = 1_000;
    const lifecycle = new RendererFrameLifecycle({ now: () => now, liveLimit: 1 });
    lifecycle.setCandidates([candidate('a')]);
    lifecycle.markError('a');
    lifecycle.markError('a');
    const blocked = lifecycle.markError('a');
    expect(blocked?.circuitOpen).toBe(true);
    expect(lifecycle.setCandidates([candidate('a')])).toEqual([]);
    expect(lifecycle.retry('a')).toBe(true);
    expect(lifecycle.stateFor('a')?.retryNonce).toBe(1);
    now += 31_000;
    expect(lifecycle.setCandidates([candidate('a')])).toEqual([]);
    expect(lifecycle.stateFor('a')?.circuitOpen).toBe(false);
  });

  it('invalidates render state without changing the canvas node identity', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1 });
    lifecycle.setCandidates([candidate('a')]);
    lifecycle.markLive('a');
    lifecycle.invalidate(['a']);
    expect(lifecycle.stateFor('a')).toMatchObject({ nodeId: 'a', status: 'placeholder' });
  });

  it('reports queued work cancelled when scope culling removes it', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1 });
    lifecycle.setCandidates([candidate('a', { selected: true }), candidate('b')]);
    lifecycle.setCandidates([candidate('b', { selected: true })]);
    expect(lifecycle.consumeCancelledRequestIds()).toEqual(['a']);
    expect(lifecycle.stateFor('a')?.status).toBe('suspended');
  });

  it('cancels a stale revision request before queueing the replacement', () => {
    const lifecycle = new RendererFrameLifecycle({ liveLimit: 1 });
    lifecycle.setCandidates([candidate('a', { selected: true, snapshotKey: 'a:v1' })]);
    expect(
      lifecycle.setCandidates([candidate('a', { selected: true, snapshotKey: 'a:v2' })])
    ).toEqual(['a']);
    expect(lifecycle.consumeCancelledRequestIds()).toEqual(['a']);
    expect(lifecycle.stateFor('a')?.status).toBe('queued');
  });
});
