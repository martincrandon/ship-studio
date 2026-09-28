import type { ReactNode } from 'react';
import { CloseIcon, PinIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';

export type EditPanelContext = 'CSS' | 'Visual Editor' | 'Component';

export interface EditPanelShellProps {
  context: EditPanelContext;
  children: ReactNode;
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
  className?: string;
  'aria-label'?: string;
}

/** Shared chrome for every edit surface. DockablePanel owns placement; this
 * shell owns the single title/action row and the bounded content surface. */
export function EditPanelShell({
  context,
  children,
  pinned = false,
  onTogglePin,
  onClose,
  className = '',
  'aria-label': ariaLabel = 'Edit panel',
}: EditPanelShellProps) {
  const showClose = context !== 'Component' && onClose;

  return (
    <section
      className={`ss-edit-panel ss-edit-panel--dockable${pinned ? ' ss-edit-panel--pinned' : ''}${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
    >
      <header className="ss-edit-panel__header" data-dockable-drag-handle>
        <div className="panel-heading-pair">
          <span className="panel-heading-pair-title">Edit</span>
          <span className="panel-heading-pair-meta">{context}</span>
        </div>
        {(onTogglePin || showClose) && (
          <span className="ss-edit-panel__header-actions">
            {onTogglePin && (
              <ToggleButton
                variant="ghost"
                size="compact"
                className="button--icon-only panel-pin-toggle"
                onClick={onTogglePin}
                title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
                aria-label={pinned ? 'Unpin Edit panel' : 'Pin Edit panel to the window'}
                pressed={pinned}
                leftIcon={<PinIcon size={13} />}
              />
            )}
            {showClose && (
              <IconButton
                variant="ghost"
                size="compact"
                onClick={onClose}
                title="Close Edit panel"
                aria-label="Close Edit panel"
                icon={<CloseIcon size={14} />}
              />
            )}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}
