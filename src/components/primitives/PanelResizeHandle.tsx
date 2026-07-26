import { useCallback, useRef } from 'react';

interface PanelResizeHandleProps {
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (clientX: number) => void;
  onResizeBy: (delta: number) => void;
}

const KEYBOARD_RESIZE_STEP = 10;

/**
 * Shared vertical separator for horizontally resizable panels.
 *
 * The owning panel translates the pointer's viewport X coordinate into its
 * local width, keeping this handle independent of its surrounding layout.
 */
export function PanelResizeHandle({
  value,
  min,
  max,
  label,
  onResize,
  onResizeBy,
}: PanelResizeHandleProps) {
  const isDragging = useRef(false);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      isDragging.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      let animationFrame: number | null = null;
      let latestClientX = event.clientX;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        latestClientX = moveEvent.clientX;
        if (!isDragging.current || animationFrame !== null) return;

        animationFrame = requestAnimationFrame(() => {
          animationFrame = null;
          if (isDragging.current) onResize(latestClientX);
        });
      };

      const handleMouseUp = () => {
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [onResize]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      onResizeBy(event.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP);
    },
    [onResizeBy]
  );

  return (
    <div
      className="panel-resize-handle"
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
    />
  );
}
