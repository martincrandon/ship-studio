import type { CanvasGuide } from '../../../lib/components/canvas-geometry';
import type { CanvasCameraState } from '../../../lib/components/canvas-camera';

export function CanvasGuidesOverlay({
  guides,
  camera,
}: {
  guides: readonly CanvasGuide[];
  camera?: CanvasCameraState;
}) {
  if (guides.length === 0) return null;
  const resolvedCamera = camera ?? { x: 0, y: 0, zoom: 1 };
  return (
    <div
      className="component-canvas-guides"
      aria-hidden="true"
      data-testid="component-canvas-guides"
    >
      {guides.map((guide, index) => (
        <span key={`${guide.orientation}-${guide.position}-${index}`}>
          <span
            className={`component-canvas-guide component-canvas-guide--${guide.orientation}${guide.kind !== 'guide' ? ' is-snap' : ''}`}
            style={
              guide.orientation === 'vertical'
                ? {
                    left: guide.position * resolvedCamera.zoom + resolvedCamera.x,
                    top: guide.segment
                      ? guide.segment.start * resolvedCamera.zoom + resolvedCamera.y
                      : undefined,
                    height: guide.segment
                      ? (guide.segment.end - guide.segment.start) * resolvedCamera.zoom
                      : undefined,
                  }
                : {
                    top: guide.position * resolvedCamera.zoom + resolvedCamera.y,
                    left: guide.segment
                      ? guide.segment.start * resolvedCamera.zoom + resolvedCamera.x
                      : undefined,
                    width: guide.segment
                      ? (guide.segment.end - guide.segment.start) * resolvedCamera.zoom
                      : undefined,
                  }
            }
          />
          {guide.kind !== 'guide' && guide.segment ? (
            <>
              <span
                className={`component-canvas-guide-marker component-canvas-guide-marker--${guide.orientation}`}
                style={
                  guide.orientation === 'vertical'
                    ? {
                        left: guide.position * resolvedCamera.zoom + resolvedCamera.x,
                        top: guide.segment.start * resolvedCamera.zoom + resolvedCamera.y,
                      }
                    : {
                        left: guide.segment.start * resolvedCamera.zoom + resolvedCamera.x,
                        top: guide.position * resolvedCamera.zoom + resolvedCamera.y,
                      }
                }
              />
              <span
                className={`component-canvas-guide-marker component-canvas-guide-marker--${guide.orientation}`}
                style={
                  guide.orientation === 'vertical'
                    ? {
                        left: guide.position * resolvedCamera.zoom + resolvedCamera.x,
                        top: guide.segment.end * resolvedCamera.zoom + resolvedCamera.y,
                      }
                    : {
                        left: guide.segment.end * resolvedCamera.zoom + resolvedCamera.x,
                        top: guide.position * resolvedCamera.zoom + resolvedCamera.y,
                      }
                }
              />
            </>
          ) : null}
        </span>
      ))}
    </div>
  );
}
