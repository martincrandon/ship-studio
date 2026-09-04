import { useEffect, useState } from 'react';
import { DuplicateIcon } from '@/components/icons';
import type { ComponentDescriptor } from '../../lib/components/types';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';

export interface ComponentDuplicateModalProps {
  component: ComponentDescriptor;
  isOpen: boolean;
  onClose: () => void;
  onDuplicate: (input: {
    componentId: ComponentDescriptor['id'];
    newName: string;
    destinationFile: string;
  }) => void | Promise<void>;
}

function extensionOf(file: string) {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? '.tsx' : file.slice(dot);
}

function directoryOf(file: string) {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

function defaultDestination(component: ComponentDescriptor, name: string) {
  const directory = directoryOf(component.definition.file);
  return `${directory ? `${directory}/` : ''}${name}${extensionOf(component.definition.file)}`;
}

function defaultDuplicateName(component: ComponentDescriptor) {
  return `${component.localName}Copy`;
}

/** Collects the explicit name/path confirmation required before a definition is copied. */
export function ComponentDuplicateModal({
  component,
  isOpen,
  onClose,
  onDuplicate,
}: ComponentDuplicateModalProps) {
  const [newName, setNewName] = useState(defaultDuplicateName(component));
  const [destinationFile, setDestinationFile] = useState(
    defaultDestination(component, defaultDuplicateName(component))
  );

  useEffect(() => {
    if (!isOpen) return;
    const name = defaultDuplicateName(component);
    // Reset both fields with the selected definition when the modal opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNewName(name);
    setDestinationFile(defaultDestination(component, name));
  }, [component, isOpen]);

  const submit = () => {
    if (!newName.trim() || !destinationFile.trim()) return;
    void onDuplicate({
      componentId: component.id,
      newName: newName.trim(),
      destinationFile: destinationFile.trim(),
    });
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`Duplicate ${component.name}`}
      className="ss-components-refactor-modal"
    >
      <div className="ss-components-refactor-form">
        <p className="ss-components-muted">
          Create a reviewed copy beside the current definition. Relative imports stay unchanged; the
          new file is added only after you approve the source preview.
        </p>
        <label className="ss-components-refactor-form__field">
          <span>New component name</span>
          <TextField
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.currentTarget.value)}
            placeholder="NavWrap"
            aria-label="New component name"
          />
        </label>
        <label className="ss-components-refactor-form__field">
          <span>Destination file</span>
          <TextField
            value={destinationFile}
            onChange={(event) => setDestinationFile(event.currentTarget.value)}
            placeholder={defaultDestination(component, 'NavWrap')}
            aria-label="Destination file"
          />
        </label>
        <p className="ss-components-refactor-form__hint">
          <DuplicateIcon size={14} aria-hidden="true" />
          React definitions only · same folder and extension
        </p>
        <div className="ss-components-refactor-form__actions">
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!newName.trim() || !destinationFile.trim()}
            onClick={submit}
            leftIcon={<DuplicateIcon size={14} />}
          >
            Review duplicate
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
