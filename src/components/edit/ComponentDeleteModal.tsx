import { useEffect, useState } from 'react';
import { TrashIcon } from '@/components/icons';
import type { ComponentDescriptor } from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';

export interface ComponentDeleteModalProps {
  component: ComponentDescriptor;
  isOpen: boolean;
  onClose: () => void;
  onDelete: (input: {
    componentId: ComponentDescriptor['id'];
    removeAllUsages: true;
  }) => void | Promise<void>;
}

/** Collects the explicit destructive confirmation before a reviewed delete plan. */
export function ComponentDeleteModal({
  component,
  isOpen,
  onClose,
  onDelete,
}: ComponentDeleteModalProps) {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // The confirmation belongs to this modal-opening lifecycle.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirmed(false);
    }
  }, [component, isOpen]);

  const usageLabel = `${component.usageCount} statically resolved ${component.usageCount === 1 ? 'usage' : 'usages'}`;

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`Delete ${component.name}`}
      className="ss-components-refactor-modal"
    >
      <div className="ss-components-refactor-form">
        <p className="ss-components-muted">
          Remove the named export and all {usageLabel}. The definition file will be kept for now;
          nothing is changed until you approve the complete source preview.
        </p>
        <label className="ss-components-delete-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            aria-label="Confirm deleting the component and all usages"
          />
          <span>I understand that this removes the component and its resolved usages.</span>
        </label>
        <p className="ss-components-refactor-form__hint">
          <TrashIcon size={14} aria-hidden="true" />
          React named exports only · file deletion is not included
        </p>
        <div className="ss-components-refactor-form__actions">
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="compact"
            disabled={!confirmed}
            onClick={() => void onDelete({ componentId: component.id, removeAllUsages: true })}
            leftIcon={<TrashIcon size={14} />}
          >
            Review deletion
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
