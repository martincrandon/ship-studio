import { type ComponentCanvasNode } from './canvas';
import { RendererFrameLifecycle, type RendererLifecycleCandidate } from './renderer-lifecycle';

/** The node counts used by the renderer release benchmark. Keep this list small: the
 * benchmark is intended to be repeatable during development, not a profiling suite. */
export const RENDERER_BENCHMARK_NODE_COUNTS = [1, 6, 25, 100] as const;
const DEFAULT_ITERATIONS = 25;

export interface RendererBenchmarkSample {
  logicalNodes: number;
  iterations: number;
  cpuMs: number;
  heapDeltaBytes: number | null;
  liveFrameCount: number;
  cachedFrameCount: number;
  liveFrameLimit: number;
}

export interface RendererBenchmarkOptions {
  iterations?: number;
  now?: () => number;
  heapUsed?: () => number | null;
}

/**
 * Exercise the same lifecycle/scheduling path used by the canvas with cached
 * snapshots for inactive nodes. This is deliberately framework-independent so it
 * can run in a focused Vitest benchmark without starting a project dev server.
 * `heapDeltaBytes` is null in runtimes that do not expose heap usage; it is a
 * diagnostic, never a product limit.
 */
export function runRendererBenchmark(
  options: RendererBenchmarkOptions = {}
): RendererBenchmarkSample[] {
  const iterations = Math.max(1, Math.round(options.iterations ?? DEFAULT_ITERATIONS));
  const now = options.now ?? defaultNow;
  const heapUsed = options.heapUsed ?? defaultHeapUsed;

  return RENDERER_BENCHMARK_NODE_COUNTS.map((logicalNodes) => {
    const candidates = createCandidates(logicalNodes);
    const lifecycle = new RendererFrameLifecycle();
    const beforeHeap = heapUsed();
    let peakHeap = beforeHeap;
    const startedAt = now();

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      lifecycle.setCandidates(candidates);
      lifecycle.setActiveFrame('benchmark-node-0');
      for (const nodeId of lifecycle.snapshot().queuedFrameIds) lifecycle.markLive(nodeId);
      lifecycle.snapshot();
      const currentHeap = heapUsed();
      if (currentHeap !== null) peakHeap = Math.max(peakHeap ?? currentHeap, currentHeap);
    }

    const elapsed = Math.max(0, now() - startedAt);
    const finalState = lifecycle.snapshot();
    return {
      logicalNodes,
      iterations,
      cpuMs: Math.round(elapsed * 100) / 100,
      heapDeltaBytes:
        beforeHeap !== null && peakHeap !== null ? Math.max(0, peakHeap - beforeHeap) : null,
      liveFrameCount: finalState.liveFrameIds.length,
      cachedFrameCount: finalState.frames.filter((frame) => frame.status === 'cached').length,
      liveFrameLimit: 6,
    };
  });
}

function createCandidates(logicalNodes: number): RendererLifecycleCandidate[] {
  return Array.from({ length: logicalNodes }, (_, index) => {
    const node = {
      id: `benchmark-node-${index}`,
      scope: 'all',
      componentId: 'benchmark-component',
      presetId: null,
      x: (index % 10) * 340,
      y: Math.floor(index / 10) * 500,
      width: 320,
      height: 480,
      order: index,
      collapsed: false,
      generated: true,
      presentation: { background: 'surface', breakpoint: null, locale: null },
    } satisfies ComponentCanvasNode;
    return {
      node,
      visible: true,
      distanceToViewportCenter: index,
      selected: index === 0,
      recentlyUsedAt: logicalNodes - index,
      snapshotKey: `benchmark-snapshot-${index}`,
      cachedSnapshotKey: `benchmark-snapshot-${index}`,
    } satisfies RendererLifecycleCandidate;
  });
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultHeapUsed(): number | null {
  const processLike = (
    globalThis as typeof globalThis & {
      process?: { memoryUsage?: () => { heapUsed?: number } };
    }
  ).process;
  const heap = processLike?.memoryUsage?.().heapUsed;
  return typeof heap === 'number' && Number.isFinite(heap) ? heap : null;
}
