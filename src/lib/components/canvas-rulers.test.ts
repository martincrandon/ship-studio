import { describe, expect, it } from 'vitest';
import {
  CANVAS_RULER_CORNER_FADE_CLEARANCE_PX,
  CANVAS_RULER_CORNER_FADE_DISTANCE_PX,
  CANVAS_RULER_THICKNESS_PX,
  canvasRulerMarkerOpacity,
  createCanvasRulerLayout,
} from './canvas-rulers';

const base = {
  viewport: { width: 640, height: 480 },
  rulerThickness: CANVAS_RULER_THICKNESS_PX,
  targetScreenSpacing: 80,
};

describe('canvas ruler layout', () => {
  it('fades marks through the short corner-clearance window', () => {
    const fadeEnd = CANVAS_RULER_THICKNESS_PX + CANVAS_RULER_CORNER_FADE_CLEARANCE_PX;
    expect(canvasRulerMarkerOpacity(fadeEnd)).toBe(0);
    expect(canvasRulerMarkerOpacity(fadeEnd + CANVAS_RULER_CORNER_FADE_DISTANCE_PX / 2)).toBe(0.5);
    expect(canvasRulerMarkerOpacity(fadeEnd + CANVAS_RULER_CORNER_FADE_DISTANCE_PX)).toBe(1);
    expect(canvasRulerMarkerOpacity(fadeEnd + CANVAS_RULER_CORNER_FADE_DISTANCE_PX * 2)).toBe(1);
    expect(canvasRulerMarkerOpacity(-(fadeEnd + CANVAS_RULER_CORNER_FADE_DISTANCE_PX / 2))).toBe(
      0.5
    );
  });

  it('projects major and minor ticks through pan and zoom', () => {
    const layout = createCanvasRulerLayout({
      ...base,
      camera: { x: 100, y: 50, zoom: 2 },
    });
    expect(layout.horizontal.start).toBe(CANVAS_RULER_THICKNESS_PX);
    expect(layout.horizontal.worldStart).toBe((CANVAS_RULER_THICKNESS_PX - 100) / 2);
    expect(layout.horizontal.majorStep).toBe(50);
    expect(layout.horizontal.ticks.find((tick) => tick.value === 0)).toMatchObject({
      offset: 100,
      major: true,
      label: '0',
    });
    expect(layout.vertical.ticks.some((tick) => !tick.major)).toBe(true);
  });

  it('keeps the 1-2-5 cadence when the visible spacing lands on a 2.5 step', () => {
    const layout = createCanvasRulerLayout({
      ...base,
      targetScreenSpacing: 25,
      camera: { x: 0, y: 0, zoom: 1 },
    });

    expect(layout.horizontal.majorStep).toBe(25);
    expect(layout.horizontal.minorStep).toBe(5);
    expect(
      layout.horizontal.ticks
        .filter((tick) => tick.value > 50 && tick.value < 75)
        .map((tick) => tick.value)
    ).toEqual([55, 60, 65, 70]);
  });

  it('keeps negative coordinates and labels deterministic', () => {
    const layout = createCanvasRulerLayout({
      ...base,
      camera: { x: 320, y: 296, zoom: 1 },
    });
    const labels = layout.horizontal.ticks.filter((tick) => tick.major).map((tick) => tick.label);
    expect(labels).toContain('-100');
    expect(labels).toContain('-200');
    expect(layout.horizontal.ticks.every((tick) => Number.isFinite(tick.offset))).toBe(true);
  });

  it('clips the selected range to each visible ruler and marks its labels', () => {
    const layout = createCanvasRulerLayout({
      ...base,
      camera: { x: 0, y: 0, zoom: 1 },
      selectedBounds: { x: 40, y: 100, width: 160, height: 120 },
    });
    expect(layout.horizontal.selectionBand).toEqual({
      start: 40,
      end: 200,
      worldStart: 40,
      worldEnd: 200,
      startLabel: '40',
      endLabel: '200',
    });
    expect(layout.vertical.selectionBand).toEqual({
      start: 100,
      end: 220,
      worldStart: 100,
      worldEnd: 220,
      startLabel: '100',
      endLabel: '220',
    });
    expect(
      layout.horizontal.ticks.filter((tick) => tick.selected).every((tick) => tick.major)
    ).toBe(false);
    expect(layout.horizontal.ticks.some((tick) => tick.major && tick.selected)).toBe(true);

    const clipped = createCanvasRulerLayout({
      ...base,
      camera: { x: 0, y: 0, zoom: 1 },
      selectedBounds: { x: -200, y: -200, width: 300, height: 300 },
    });
    expect(clipped.horizontal.selectionBand).toEqual({
      start: CANVAS_RULER_THICKNESS_PX,
      end: 100,
      worldStart: -200,
      worldEnd: 100,
      startLabel: '-200',
      endLabel: '100',
    });
  });

  it('keeps each axis bounded by the requested tick count', () => {
    const layout = createCanvasRulerLayout({
      viewport: { width: 10_000, height: 10_000 },
      rulerThickness: CANVAS_RULER_THICKNESS_PX,
      targetScreenSpacing: 2,
      maxTicks: 24,
      camera: { x: 0, y: 0, zoom: 0.1 },
    });
    expect(layout.horizontal.ticks.length).toBeLessThanOrEqual(24);
    expect(layout.vertical.ticks.length).toBeLessThanOrEqual(24);
    expect(layout.horizontal.ticks.filter((tick) => tick.major).length).toBeGreaterThan(0);
    expect(layout.vertical.ticks.filter((tick) => tick.major).length).toBeGreaterThan(0);
  });
});
