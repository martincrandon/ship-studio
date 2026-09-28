import { COMPONENT_CANVAS_MAX_LIVE_FRAMES, type ComponentCanvasNode } from './canvas';
import { sha256 } from './ranges';

export interface RendererScheduleCandidate {
  node: ComponentCanvasNode;
  visible: boolean;
  distanceToViewportCenter: number;
  selected: boolean;
  /** Monotonic access sequence; larger values were accessed more recently. */
  recentlyUsedAt: number;
  /** Uncached frames are given work priority during the background sweep. */
  needsSnapshot?: boolean;
}

export function prioritizeRendererFrames(
  candidates: readonly RendererScheduleCandidate[]
): RendererScheduleCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      Number(right.selected) - Number(left.selected) ||
      right.recentlyUsedAt - left.recentlyUsedAt ||
      Number(right.needsSnapshot) - Number(left.needsSnapshot) ||
      Number(right.visible) - Number(left.visible) ||
      left.distanceToViewportCenter - right.distanceToViewportCenter ||
      left.node.id.localeCompare(right.node.id)
  );
}

export function selectLiveRendererFrames(
  candidates: readonly RendererScheduleCandidate[],
  limit = COMPONENT_CANVAS_MAX_LIVE_FRAMES
): string[] {
  return prioritizeRendererFrames(candidates)
    .slice(0, Math.max(0, Math.min(limit, COMPONENT_CANVAS_MAX_LIVE_FRAMES)))
    .map((candidate) => candidate.node.id);
}

export function componentSnapshotCacheKey(input: {
  componentRevision: string;
  presetFingerprint: string;
  width: number | null;
  height: number;
  background: string;
  breakpoint?: string | null;
  locale: string | null;
  rendererVersion: string;
}): string {
  return sha256(JSON.stringify(input));
}
