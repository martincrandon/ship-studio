import { forwardRef, type ReactNode } from 'react';
import { CanvasViewport, type CanvasViewportProps } from './CanvasViewport';
import { CanvasWorld } from './CanvasWorld';

/** Compatibility shell: existing workspace state stays authoritative while the
 * canvas internals move into small, testable layers. */
export const ComponentsCanvas = forwardRef<
  HTMLDivElement,
  CanvasViewportProps & {
    children: ReactNode;
    overlay?: ReactNode;
    rendererStageActive?: boolean;
  }
>(function ComponentsCanvas(
  { camera, children, overlay, rendererStageActive = false, ...viewportProps },
  ref
) {
  return (
    <CanvasViewport ref={ref} camera={camera} {...viewportProps}>
      <CanvasWorld camera={camera} rendererStageActive={rendererStageActive}>
        {children}
      </CanvasWorld>
      {overlay ? <div className="components-workspace__screen-overlay">{overlay}</div> : null}
    </CanvasViewport>
  );
});

ComponentsCanvas.displayName = 'ComponentsCanvas';
