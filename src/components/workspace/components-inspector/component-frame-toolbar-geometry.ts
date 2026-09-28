import type { SelectionRect } from '../../../hooks/useElementTree';

/** A client-space rectangle with no dependency on DOM APIs. */
export interface NumericRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The untransformed client dimensions reported by an iframe element. */
export interface IframeClientSize {
  width: number;
  height: number;
}

export interface ComponentFrameToolbarGeometryInput {
  /** The selected element's rect in iframe-local CSS pixels. */
  selectionRect: SelectionRect;
  /** The iframe's transformed client-space bounds. */
  iframeRect: NumericRect;
  /** The iframe's untransformed client dimensions. */
  iframeClientSize: IframeClientSize;
  /** The Components canvas viewport's client-space bounds. */
  viewportRect: NumericRect;
  /** Canvas-frame rotation in degrees. Any non-zero value is unsupported. */
  rotation?: number;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isPositiveRect(rect: NumericRect): boolean {
  return (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function isPositiveSize(size: IframeClientSize): boolean {
  return (
    isFiniteNumber(size.width) &&
    isFiniteNumber(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/**
 * Projects an iframe-local selection into Components viewport coordinates.
 *
 * `getBoundingClientRect()` includes CSS transforms while `clientWidth` and
 * `clientHeight` do not, so the projection derives an x/y scale from those
 * two measurements. The result is local to `viewportRect` and is clipped to
 * its visible bounds. No values are rounded, which keeps sub-pixel canvas
 * zoom and fractional iframe measurements intact.
 *
 * A rotated frame needs a quad/matrix projection: its axis-aligned iframe
 * rect is not enough to locate a descendant. Until that projection exists,
 * every non-zero rotation fails closed instead of returning a misleading
 * toolbar position.
 */
export function mapSelectionRectToComponentsViewport(
  input: ComponentFrameToolbarGeometryInput
): SelectionRect | null {
  const { selectionRect, iframeRect, iframeClientSize, viewportRect, rotation = 0 } = input;

  if (
    !isFiniteNumber(rotation) ||
    rotation !== 0 ||
    !isPositiveRect(iframeRect) ||
    !isPositiveSize(iframeClientSize) ||
    !isPositiveRect(viewportRect) ||
    !isFiniteNumber(selectionRect.top) ||
    !isFiniteNumber(selectionRect.left) ||
    !isFiniteNumber(selectionRect.width) ||
    !isFiniteNumber(selectionRect.height) ||
    selectionRect.width <= 0 ||
    selectionRect.height <= 0
  ) {
    return null;
  }

  const scaleX = iframeRect.width / iframeClientSize.width;
  const scaleY = iframeRect.height / iframeClientSize.height;
  if (!isFiniteNumber(scaleX) || !isFiniteNumber(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return null;
  }

  const left = iframeRect.left + selectionRect.left * scaleX - viewportRect.left;
  const top = iframeRect.top + selectionRect.top * scaleY - viewportRect.top;
  const right = left + selectionRect.width * scaleX;
  const bottom = top + selectionRect.height * scaleY;

  const clippedLeft = Math.max(0, left);
  const clippedTop = Math.max(0, top);
  const clippedRight = Math.min(viewportRect.width, right);
  const clippedBottom = Math.min(viewportRect.height, bottom);
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return null;

  return {
    left: clippedLeft,
    top: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };
}
