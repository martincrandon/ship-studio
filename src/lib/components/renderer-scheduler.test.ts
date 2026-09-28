import { describe, expect, it } from 'vitest';
import { componentSnapshotCacheKey, selectLiveRendererFrames } from './renderer-scheduler';
import type { ComponentCanvasNode } from './canvas';

const node = (id: string): ComponentCanvasNode => ({
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
});

describe('component renderer scheduler', () => {
  it('prioritizes selected visible frames and caps the live pool', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      node: node(String(index)),
      visible: true,
      distanceToViewportCenter: index,
      selected: index === 9,
      recentlyUsedAt: index,
    }));
    const selected = selectLiveRendererFrames(candidates);
    expect(selected).toHaveLength(6);
    expect(selected[0]).toBe('9');
  });

  it('prioritizes the most recently accessed frames before viewport distance', () => {
    const candidates = [
      {
        node: node('older-nearby'),
        visible: true,
        distanceToViewportCenter: 0,
        selected: false,
        recentlyUsedAt: 1,
      },
      {
        node: node('newer-far-away'),
        visible: true,
        distanceToViewportCenter: 100,
        selected: false,
        recentlyUsedAt: 2,
      },
    ];

    expect(selectLiveRendererFrames(candidates, 1)).toEqual(['newer-far-away']);
  });

  it('prioritizes uncached frames when access recency is tied', () => {
    const candidates = [
      {
        node: node('cached'),
        visible: true,
        distanceToViewportCenter: 0,
        selected: false,
        recentlyUsedAt: 0,
        needsSnapshot: false,
      },
      {
        node: node('uncached'),
        visible: false,
        distanceToViewportCenter: 100,
        selected: false,
        recentlyUsedAt: 0,
        needsSnapshot: true,
      },
    ];

    expect(selectLiveRendererFrames(candidates, 1)).toEqual(['uncached']);
  });

  it('changes the snapshot key when renderer inputs change', () => {
    const base = {
      componentRevision: 'r1',
      presetFingerprint: 'p1',
      width: 320,
      height: 480,
      background: 'surface',
      locale: null,
      rendererVersion: 'v1',
    };
    expect(componentSnapshotCacheKey(base)).toBe(componentSnapshotCacheKey({ ...base }));
    expect(componentSnapshotCacheKey(base)).not.toBe(
      componentSnapshotCacheKey({ ...base, width: 640 })
    );
  });
});
