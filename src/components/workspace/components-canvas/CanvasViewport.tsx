import { forwardRef, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import type { CanvasCameraState } from '../../../lib/components/canvas-camera';

export interface CanvasViewportProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  camera: CanvasCameraState;
  children?: ReactNode;
}

/** The screen-space surface for the component canvas.
 *
 * Camera transforms intentionally live on CanvasWorld. Keeping the viewport
 * untransformed means pointer coordinates, focus rings, banners, and marquee
 * overlays remain in screen space and can share one gesture boundary.
 */
export const CanvasViewport = forwardRef(function CanvasViewport(
  { camera: _camera, children, className, ...props }: CanvasViewportProps,
  ref: Ref<HTMLDivElement>
) {
  return (
    <div ref={ref} className={className ?? 'components-workspace__viewport'} {...props}>
      {children}
    </div>
  );
});

CanvasViewport.displayName = 'CanvasViewport';
