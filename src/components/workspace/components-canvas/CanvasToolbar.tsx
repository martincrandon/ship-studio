import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { CropIcon, ExpandIcon, ZoomInIcon, ZoomOutIcon } from '@/components/icons';
import { IconButton } from '../../primitives/IconButton';
import { TextField } from '../../primitives/TextField';

export function CanvasToolbar({
  zoom,
  onZoomOut,
  onZoomIn,
  onZoomChange,
  onFit,
  onFitSelection,
  rulersControl,
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomChange: (zoom: number) => void;
  onFit: () => void;
  onFitSelection?: () => void;
  rulersControl?: ReactNode;
}) {
  const [isEditingZoom, setIsEditingZoom] = useState(false);
  const [zoomInput, setZoomInput] = useState('');
  const zoomPercentage = Math.round(zoom * 100);

  const beginZoomEdit = () => {
    setZoomInput(String(zoomPercentage));
    setIsEditingZoom(true);
  };

  const commitZoomEdit = () => {
    const normalizedValue = zoomInput.trim().replace(/%$/, '').trim();
    const percentage = Number(normalizedValue);

    if (Number.isFinite(percentage) && percentage > 0) {
      onZoomChange(percentage / 100);
    }

    setIsEditingZoom(false);
  };

  const handleZoomInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitZoomEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setIsEditingZoom(false);
    }
  };

  return (
    <div
      className="components-workspace__canvas-toolbar"
      role="group"
      aria-label="Canvas viewport controls"
    >
      <div className="components-workspace__zoom-group" role="group" aria-label="Zoom controls">
        <IconButton
          variant="ghost"
          size="default"
          aria-label="Zoom out"
          icon={<ZoomOutIcon size={14} />}
          onClick={onZoomOut}
        />
        {isEditingZoom ? (
          <TextField
            className="components-workspace__zoom-input"
            type="text"
            inputMode="decimal"
            aria-label="Zoom percentage"
            autoFocus
            value={zoomInput}
            onChange={(event) => setZoomInput(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={commitZoomEdit}
            onKeyDown={handleZoomInputKeyDown}
          />
        ) : (
          <button
            type="button"
            className="components-workspace__zoom"
            aria-label={`Zoom ${zoomPercentage}%`}
            aria-live="polite"
            title="Edit zoom percentage"
            onClick={beginZoomEdit}
          >
            {zoomPercentage}%
          </button>
        )}
        <IconButton
          variant="ghost"
          size="default"
          aria-label="Zoom in"
          icon={<ZoomInIcon size={14} />}
          onClick={onZoomIn}
        />
      </div>
      <div
        className="components-workspace__floating-toolbar-group"
        role="group"
        aria-label="Fit controls"
      >
        <IconButton
          variant="ghost"
          size="default"
          aria-label="Fit scene"
          title="Fit scene"
          icon={<ExpandIcon size={14} />}
          onClick={onFit}
        />
        {onFitSelection && (
          <IconButton
            variant="ghost"
            size="default"
            aria-label="Fit selection"
            title="Fit selection"
            icon={<CropIcon size={14} />}
            onClick={onFitSelection}
          />
        )}
        {rulersControl}
      </div>
    </div>
  );
}
