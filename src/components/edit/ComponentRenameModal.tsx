import { useEffect, useState } from 'react';
import { EditFieldIcon } from '@/components/icons';
import type { ComponentDescriptor } from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';

export interface ComponentRenameModalProps {
  component: ComponentDescriptor;
  isOpen: boolean;
  onClose: () => void;
  onRename: (input: {
    componentId: ComponentDescriptor['id'];
    newName: string;
  }) => void | Promise<void>;
}

/** Collects the new symbol name before the reviewed graph-aware rename plan. */
export function ComponentRenameModal({
  component,
  isOpen,
  onClose,
  onRename,
}: ComponentRenameModalProps) {
  const [newName, setNewName] = useState(component.localName);

  useEffect(() => {
    if (isOpen) {
      // The form starts from the selected definition each time it opens.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNewName(component.localName);
    }
  }, [component, isOpen]);

  const submit = () => {
    if (!newName.trim()) return;
    void onRename({ componentId: component.id, newName: newName.trim() });
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`Rename ${component.name}`}
      className="ss-components-refactor-modal"
    >
      <div className="ss-components-refactor-form">
        <p className="ss-components-muted">
          Rename the native exported symbol and every statically resolved reference. Nothing is
          written until you approve the complete source preview.
        </p>
        <label className="ss-components-refactor-form__field">
          <span>New component name</span>
          <TextField
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.currentTarget.value)}
            placeholder="NavHeader"
            aria-label="New component name"
          />
        </label>
        <p className="ss-components-refactor-form__hint">
          <EditFieldIcon size={14} aria-hidden="true" />
          React named exports only · direct imports and namespace references
        </p>
        <div className="ss-components-refactor-form__actions">
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!newName.trim()}
            onClick={submit}
            leftIcon={<EditFieldIcon size={14} />}
          >
            Review rename
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
