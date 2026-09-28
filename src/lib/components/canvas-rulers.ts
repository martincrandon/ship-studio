import type { CanvasCameraState } from './canvas-camera';

export type CanvasRulerOrientation = 'horizontal' | 'vertical';

export interface CanvasRulerViewport {
  width: number;
  height: number;
}

export interface CanvasRulerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasRulerTick {
  /** The world coordinate represented by this tick. */
  value: number;
  /** Screen-space offset within the viewport. */
  offset: number;
  major: boolean;
  /** Major ticks have labels; minor ticks intentionally do not. */
  label?: string;
  /** True when the tick falls inside the projected selected range. */
  selected: boolean;
}

export interface CanvasRulerSelectionBand {
  /** Screen-space start/end, clipped to the visible ruler axis. */
  start: number;
  end: number;
  /** Unclipped world-coordinate endpoints shown at the selection edges. */
  worldStart: number;
  worldEnd: number;
  startLabel: string;
  endLabel: string;
}

export interface CanvasRulerAxis {
  orientation: CanvasRulerOrientation;
  start: number;
  end: number;
  worldStart: number;
  worldEnd: number;
  majorStep: number;
  minorStep: number;
  ticks: CanvasRulerTick[];
  selectionBand?: CanvasRulerSelectionBand;
}

export interface CanvasRulerLayoutOptions {
  camera: CanvasCameraState;
  viewport: CanvasRulerViewport;
  /** The square screen-space corner occupied by the two ruler strips. */
  rulerThickness: number;
  /** Desired distance between major ticks, in screen pixels. */
  targetScreenSpacing?: number;
  /** Hard cap per axis, including major and minor ticks. */
  maxTicks?: number;
  selectedBounds?: CanvasRulerBounds | null;
}

export interface CanvasRulerLayout {
  horizontal: CanvasRulerAxis;
  vertical: CanvasRulerAxis;
}

/**
 * Pixel fallback for the screen-space ruler token.
 *
 * The rendered ruler uses `--component-canvas-ruler-thickness`, which resolves
 * to the shared `--size-control-medium` token. Keeping the corresponding
 * geometry value beside the adapter avoids a second ruler-specific literal in
 * consumers.
 */
export const CANVAS_RULER_THICKNESS_PX = 24;
/** Short fade distance that keeps labels clear of the ruler corner. */
export const CANVAS_RULER_CORNER_FADE_DISTANCE_PX = 24;
/** Extra clearance between a fully faded marker and the corner edge. */
export const CANVAS_RULER_CORNER_FADE_CLEARANCE_PX = 8;

/**
 * Fades ruler marks as they approach the shared corner, keeping their labels
 * from crossing into the opposite ruler. The fade is intentionally shorter
 * than Grida's broad overlap window and ends before Ship's inner ruler edge,
 * so a label's bounds have cleared the corner before it becomes visible.
 */
export function canvasRulerMarkerOpacity(offset: number): number {
  const fadeEnd = CANVAS_RULER_THICKNESS_PX + CANVAS_RULER_CORNER_FADE_CLEARANCE_PX;
  const distancePastFadeEnd = Math.max(0, Math.abs(finite(offset, 0)) - fadeEnd);
  return Math.min(1, distancePastFadeEnd / CANVAS_RULER_CORNER_FADE_DISTANCE_PX);
}

const DEFAULT_TARGET_SCREEN_SPACING = 80;
const DEFAULT_MAX_TICKS = 200;
const NICE_STEPS = [1, 2, 2.5, 5] as const;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function safeZoom(value: number): number {
  return Math.max(Number.EPSILON, finite(value, 1));
}

function safeAxisSize(value: number): number {
  return Math.max(0, finite(value, 0));
}

function safeRulerThickness(value: number): number {
  return Math.min(Math.max(0, finite(value, 0)), Number.MAX_SAFE_INTEGER);
}

function normalizeBounds(bounds: CanvasRulerBounds): CanvasRulerBounds {
  const x2 = bounds.x + bounds.width;
  const y2 = bounds.y + bounds.height;
  return {
    x: Math.min(bounds.x, x2),
    y: Math.min(bounds.y, y2),
    width: Math.abs(bounds.width),
    height: Math.abs(bounds.height),
  };
}

function niceStep(targetWorldSpacing: number): number {
  const target = Math.max(Number.EPSILON, targetWorldSpacing);
  const exponent = Math.floor(Math.log10(target));
  const power = 10 ** exponent;
  const scaled = target / power;
  const factor = NICE_STEPS.find((candidate) => scaled <= candidate) ?? 10;
  return factor * power;
}

function decimalPlaces(step: number): number {
  if (Number.isInteger(step)) return 0;
  let places = 0;
  let normalized = Math.abs(step);
  while (places < 8 && Math.abs(Math.round(normalized) - normalized) > 1e-8) {
    normalized *= 10;
    places += 1;
  }
  return places;
}

function formatWorldValue(value: number, step: number): string {
  const rounded = Math.abs(value) < step / 1000 ? 0 : value;
  const places = decimalPlaces(step);
  return places === 0 ? String(Math.round(rounded)) : rounded.toFixed(places);
}

function formatBoundaryValue(value: number): string {
  const quantized = Math.round(value * 100) / 100;
  return String(Object.is(quantized, -0) ? 0 : quantized);
}

function subticksForStep(step: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const leading = Math.round((step / magnitude) * 10) / 10;
  if (leading === 1) return 10;
  if (leading === 2) return 4;
  if (leading === 2.5) return 5;
  if (leading === 5) return 5;
  return 5;
}

function axisRange(
  orientation: CanvasRulerOrientation,
  camera: CanvasCameraState,
  viewport: CanvasRulerViewport,
  rulerThickness: number
): { start: number; end: number; worldStart: number; worldEnd: number } {
  const dimension = orientation === 'horizontal' ? viewport.width : viewport.height;
  const translation = orientation === 'horizontal' ? camera.x : camera.y;
  const start = rulerThickness;
  const end = Math.max(start, dimension);
  const zoom = safeZoom(camera.zoom);
  return {
    start,
    end,
    worldStart: (start - finite(translation, 0)) / zoom,
    worldEnd: (end - finite(translation, 0)) / zoom,
  };
}

function selectedWorldRange(
  orientation: CanvasRulerOrientation,
  bounds: CanvasRulerBounds | null | undefined
): { start: number; end: number } | undefined {
  if (!bounds) return undefined;
  const normalized = normalizeBounds(bounds);
  return orientation === 'horizontal'
    ? { start: normalized.x, end: normalized.x + normalized.width }
    : { start: normalized.y, end: normalized.y + normalized.height };
}

function projectSelectionBand(
  range: ReturnType<typeof axisRange>,
  selectedRange: { start: number; end: number } | undefined,
  zoom: number,
  translation: number
): CanvasRulerSelectionBand | undefined {
  if (!selectedRange) return undefined;
  const projectedStart = selectedRange.start * zoom + translation;
  const projectedEnd = selectedRange.end * zoom + translation;
  const start = Math.max(range.start, Math.min(range.end, Math.min(projectedStart, projectedEnd)));
  const end = Math.max(range.start, Math.min(range.end, Math.max(projectedStart, projectedEnd)));
  if (end <= range.start || start >= range.end || end <= start) return undefined;
  return {
    start,
    end,
    worldStart: selectedRange.start,
    worldEnd: selectedRange.end,
    startLabel: formatBoundaryValue(selectedRange.start),
    endLabel: formatBoundaryValue(selectedRange.end),
  };
}

function buildAxis(
  orientation: CanvasRulerOrientation,
  options: CanvasRulerLayoutOptions
): CanvasRulerAxis {
  const viewport = {
    width: safeAxisSize(options.viewport.width),
    height: safeAxisSize(options.viewport.height),
  };
  const rulerThickness = safeRulerThickness(options.rulerThickness);
  const range = axisRange(orientation, options.camera, viewport, rulerThickness);
  const zoom = safeZoom(options.camera.zoom);
  const translation = finite(orientation === 'horizontal' ? options.camera.x : options.camera.y, 0);
  const targetSpacing = Math.max(
    1,
    finite(
      options.targetScreenSpacing ?? DEFAULT_TARGET_SCREEN_SPACING,
      DEFAULT_TARGET_SCREEN_SPACING
    )
  );
  const maxTicks = Math.max(
    3,
    Math.floor(finite(options.maxTicks ?? DEFAULT_MAX_TICKS, DEFAULT_MAX_TICKS))
  );
  const worldSpan = Math.max(0, range.worldEnd - range.worldStart);
  let majorStep = niceStep(targetSpacing / zoom);
  const minorStepFor = (step: number) => step / subticksForStep(step);
  while (worldSpan / minorStepFor(majorStep) + 2 > maxTicks) {
    majorStep = niceStep(majorStep * 2);
  }
  const minorStep = minorStepFor(majorStep);
  const firstMinorIndex = Math.floor(range.worldStart / minorStep);
  const lastMinorIndex = Math.ceil(range.worldEnd / minorStep);
  const selectedRange = selectedWorldRange(orientation, options.selectedBounds);
  const selectionBand = projectSelectionBand(range, selectedRange, zoom, translation);
  const ticks: CanvasRulerTick[] = [];
  const epsilon = minorStep * 1e-7;
  for (
    let index = firstMinorIndex;
    index <= lastMinorIndex && ticks.length < maxTicks;
    index += 1
  ) {
    const value = index * minorStep;
    if (value < range.worldStart - epsilon || value > range.worldEnd + epsilon) continue;
    const offset = value * zoom + translation;
    const major = Math.abs(value / majorStep - Math.round(value / majorStep)) < epsilon;
    const selected =
      selectionBand !== undefined && offset >= selectionBand.start && offset <= selectionBand.end;
    ticks.push({
      value,
      offset,
      major,
      selected,
      ...(major ? { label: formatWorldValue(value, majorStep) } : {}),
    });
  }
  return {
    orientation,
    start: range.start,
    end: range.end,
    worldStart: range.worldStart,
    worldEnd: range.worldEnd,
    majorStep,
    minorStep,
    ticks,
    selectionBand,
  };
}

/** Build bounded, deterministic ruler geometry in screen space. */
export function createCanvasRulerLayout(options: CanvasRulerLayoutOptions): CanvasRulerLayout {
  return {
    horizontal: buildAxis('horizontal', options),
    vertical: buildAxis('vertical', options),
  };
}
