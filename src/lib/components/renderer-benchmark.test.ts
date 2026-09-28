import { describe, expect, it } from 'vitest';
import { RENDERER_BENCHMARK_NODE_COUNTS, runRendererBenchmark } from './renderer-benchmark';

describe('renderer benchmark fixture', () => {
  it('covers the release node counts while keeping the live-frame budget bounded', () => {
    const samples = runRendererBenchmark({ iterations: 2 });

    expect(samples.map((sample) => sample.logicalNodes)).toEqual([
      ...RENDERER_BENCHMARK_NODE_COUNTS,
    ]);
    expect(samples.every((sample) => sample.cpuMs >= 0)).toBe(true);
    expect(samples.every((sample) => sample.liveFrameCount <= 6)).toBe(true);
    expect(samples.map((sample) => sample.cachedFrameCount)).toEqual([0, 0, 19, 94]);
    expect(samples.every((sample) => sample.liveFrameLimit === 6)).toBe(true);
  });

  it('accepts deterministic clocks and heap readings for repeatable reports', () => {
    let clock = 100;
    const samples = runRendererBenchmark({
      iterations: 1,
      now: () => {
        clock += 4;
        return clock;
      },
      heapUsed: () => 1_000,
    });

    expect(samples.every((sample) => sample.cpuMs === 4)).toBe(true);
    expect(samples.every((sample) => sample.heapDeltaBytes === 0)).toBe(true);
  });
});
