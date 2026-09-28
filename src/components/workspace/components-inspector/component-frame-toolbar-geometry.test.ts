import { describe, expect, it } from 'vitest';
import type { SelectionRect } from '../../../hooks/useElementTree';
import { mapSelectionRectToComponentsViewport } from './component-frame-toolbar-geometry';

const selectionRect: SelectionRect = {
  left: 25,
  top: 30,
  width: 100,
  height: 80,
};

const baseInput = {
  selectionRect,
  iframeRect: { left: 200, top: 100, width: 400, height: 300 },
  iframeClientSize: { width: 800, height: 600 },
  viewportRect: { left: 100, top: 50, width: 700, height: 500 },
};

describe('mapSelectionRectToComponentsViewport', () => {
  it('projects iframe-local coordinates through display scale into viewport-local coordinates', () => {
    expect(mapSelectionRectToComponentsViewport(baseInput)).toEqual({
      left: 112.5,
      top: 65,
      width: 50,
      height: 40,
    });
  });

  it('clips each edge at the Components viewport without rounding fractions', () => {
    expect(
      mapSelectionRectToComponentsViewport({
        ...baseInput,
        selectionRect: { left: -100.5, top: -50.5, width: 500.75, height: 401.5 },
        viewportRect: { left: 100.25, top: 50.25, width: 180.875, height: 180.875 },
        iframeRect: { left: 120.25, top: 70.25, width: 400.5, height: 300.5 },
        iframeClientSize: { width: 801, height: 601 },
      })
    ).toEqual({
      left: 0,
      top: 0,
      width: 180.875,
      height: 180.875,
    });
  });

  it('returns null when the projected selection is completely outside the viewport', () => {
    expect(
      mapSelectionRectToComponentsViewport({
        ...baseInput,
        selectionRect: { left: 1500, top: 0, width: 10, height: 10 },
      })
    ).toBeNull();
  });

  it('fails closed for a rotated frame because an axis-aligned rect cannot project its quad', () => {
    expect(
      mapSelectionRectToComponentsViewport({
        ...baseInput,
        rotation: 15,
      })
    ).toBeNull();
  });

  it('fails closed for non-measurable or non-positive geometry', () => {
    expect(
      mapSelectionRectToComponentsViewport({
        ...baseInput,
        iframeClientSize: { width: 0, height: 600 },
      })
    ).toBeNull();
    expect(
      mapSelectionRectToComponentsViewport({
        ...baseInput,
        viewportRect: { left: 100, top: 50, width: Number.NaN, height: 500 },
      })
    ).toBeNull();
  });
});
