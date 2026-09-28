export const COMPONENT_RENDERER_LONG_FRAME_MS = 50;
const MAX_TRACKED_LATENCY_MS = 60_000;

export interface RendererPerformanceSnapshot {
  inputToTransformMs: number | null;
  maxInputToTransformMs: number | null;
  longFrameCount: number;
  mountedNodes: number;
  liveIframes: number;
}

/**
 * Small development-only counters for the canvas/renderer boundary. It stores
 * aggregate values rather than event history so instrumentation cannot become
 * an unbounded source of memory pressure or telemetry.
 */
export class RendererPerformanceTracker {
  private inputStartedAt: number | null = null;
  private inputToTransformMs: number | null = null;
  private maxInputToTransformMs: number | null = null;
  private previousTransformAt: number | null = null;
  private longFrameCount = 0;
  private mountedNodes = 0;
  private liveIframes = 0;

  markInput(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    this.inputStartedAt = timestamp;
  }

  markTransform(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    if (this.inputStartedAt !== null) {
      const latency = Math.max(
        0,
        Math.min(MAX_TRACKED_LATENCY_MS, timestamp - this.inputStartedAt)
      );
      this.inputToTransformMs = Math.round(latency * 100) / 100;
      this.maxInputToTransformMs = Math.max(
        this.maxInputToTransformMs ?? 0,
        this.inputToTransformMs
      );
      this.inputStartedAt = null;
    }
    if (
      this.previousTransformAt !== null &&
      timestamp - this.previousTransformAt >= COMPONENT_RENDERER_LONG_FRAME_MS &&
      timestamp - this.previousTransformAt < MAX_TRACKED_LATENCY_MS
    ) {
      this.longFrameCount += 1;
    }
    this.previousTransformAt = timestamp;
  }

  setTopology({ mountedNodes, liveIframes }: { mountedNodes: number; liveIframes: number }): void {
    this.mountedNodes = Math.max(0, Math.round(mountedNodes));
    this.liveIframes = Math.max(0, Math.round(liveIframes));
  }

  snapshot(): RendererPerformanceSnapshot {
    return {
      inputToTransformMs: this.inputToTransformMs,
      maxInputToTransformMs: this.maxInputToTransformMs,
      longFrameCount: this.longFrameCount,
      mountedNodes: this.mountedNodes,
      liveIframes: this.liveIframes,
    };
  }
}
