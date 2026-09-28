import { type ReactNode } from 'react';
import type { CanvasCameraState } from '../../../lib/components/canvas-camera';

export function CanvasWorld({
  camera,
  children,
  rendererStageActive = false,
}: {
  camera: CanvasCameraState;
  children: ReactNode;
  /** The shared renderer applies the camera inside its own document. */
  rendererStageActive?: boolean;
}) {
  return (
    <div
      className="components-workspace__world"
      style={
        rendererStageActive
          ? undefined
          : { transform: `translate3d(${camera.x}px, ${camera.y}px, 0)` }
      }
      data-testid="component-canvas-world"
    >
      {children}
    </div>
  );
}
