import { describe, expect, it } from 'vitest';
import { RendererSnapshotCache } from './renderer-snapshot-cache';

describe('RendererSnapshotCache', () => {
  it('only returns a snapshot for the exact render-input key', () => {
    const cache = new RendererSnapshotCache();
    cache.set('card', { snapshotKey: 'card:v2', path: '/project/card.png' });

    expect(cache.getExact('card', 'card:v2')?.path).toBe('/project/card.png');
    expect(cache.getExact('card', 'card:v1')).toBeUndefined();
  });

  it('keeps the cache bounded and evicts the oldest path', () => {
    const cache = new RendererSnapshotCache(2);
    cache.set('first', { snapshotKey: 'first', path: '/first.png' });
    cache.set('second', { snapshotKey: 'second', path: '/second.png' });
    cache.set('third', { snapshotKey: 'third', path: '/third.png' });

    expect(cache.size).toBe(2);
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')?.path).toBe('/second.png');
    expect(cache.get('third')?.path).toBe('/third.png');
  });
});
