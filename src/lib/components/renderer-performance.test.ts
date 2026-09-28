import { describe, expect, it } from 'vitest';
import { RendererPerformanceTracker } from './renderer-performance';

describe('renderer performance counters', () => {
  it('records bounded transform latency, long frames, and topology', () => {
    const tracker = new RendererPerformanceTracker();
    tracker.markInput(100);
    tracker.markTransform(116);
    tracker.markTransform(180);
    tracker.setTopology({ mountedNodes: 25, liveIframes: 6 });

    expect(tracker.snapshot()).toEqual({
      inputToTransformMs: 16,
      maxInputToTransformMs: 16,
      longFrameCount: 1,
      mountedNodes: 25,
      liveIframes: 6,
    });
  });

  it('does not retain invalid input or negative topology counts', () => {
    const tracker = new RendererPerformanceTracker();
    tracker.markInput(Number.NaN);
    tracker.markTransform(Number.POSITIVE_INFINITY);
    tracker.setTopology({ mountedNodes: -2, liveIframes: -1 });

    expect(tracker.snapshot()).toMatchObject({
      inputToTransformMs: null,
      maxInputToTransformMs: null,
      mountedNodes: 0,
      liveIframes: 0,
    });
  });
});
