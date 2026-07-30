import { useEffect, useRef, type ReactNode, type MouseEvent } from 'react';
import { CloseIcon } from '../icons';
import { IconButton } from './IconButton';

interface ModalFrameProps {
  isOpen: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** If false, disables overlay click + ESC dismissal (for in-flight destructive ops). */
  dismissable?: boolean;
  /** Optional class appended to the content container for width/tone overrides. */
  className?: string;
  /** Render a close "×" in the header. Ignored when no title is provided. */
  showCloseButton?: boolean;
  /** aria-label for accessible dismissal. */
  ariaLabel?: string;
}

export function ModalFrame({
  isOpen,
  onClose,
  title,
  children,
  dismissable = true,
  className,
  showCloseButton = true,
  ariaLabel,
}: ModalFrameProps) {
  useEffect(() => {
    if (!isOpen || !dismissable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, dismissable, onClose]);

  // Only dismiss when the press STARTED on the overlay. A click fires on the
  // overlay when a text-selection drag begins inside the modal and the mouse
  // releases outside it — closing then would throw away unsaved input.
  const pressBeganOnOverlay = useRef(false);

  if (!isOpen) return null;

  const handleOverlayMouseDown = (e: MouseEvent) => {
    pressBeganOnOverlay.current = e.target === e.currentTarget;
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (dismissable && pressBeganOnOverlay.current && e.target === e.currentTarget) onClose();
    pressBeganOnOverlay.current = false;
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className="modal-frame-overlay"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
    >
      <div className={`modal-frame-content${className ? ` ${className}` : ''}`} onClick={stop}>
        {title !== undefined && (
          <div className="modal-frame-header">
            <div className="modal-frame-title">{title}</div>
            {showCloseButton && (
              <IconButton
                variant="ghost"
                size="compact"
                onClick={onClose}
                title="Close dialog"
                aria-label="Close dialog"
                icon={<CloseIcon size={16} />}
              />
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
