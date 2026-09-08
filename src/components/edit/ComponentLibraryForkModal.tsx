import { useEffect, useState } from 'react';
import { CopyIcon, LockedIcon } from '@/components/icons';
import type { ComponentDescriptor } from '../../lib/components/types';
import type { ComponentLibraryMetadata, LibraryForkInput } from '../../lib/components/libraries';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';

interface ComponentLibraryForkModalProps {
  component: ComponentDescriptor;
  library: ComponentLibraryMetadata;
  isOpen: boolean;
  onClose: () => void;
  onFork: (input: Omit<LibraryForkInput, 'newName'>) => void | Promise<void>;
}

/** Collects an explicit destination before a library definition is copied locally. */
export function ComponentLibraryForkModal({
  component,
  library,
  isOpen,
  onClose,
  onFork,
}: ComponentLibraryForkModalProps) {
  const [destinationFile, setDestinationFile] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    // The destination is intentionally blank: it is user-owned project data,
    // not a value Ship Studio can safely infer from a package path.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDestinationFile('');
  }, [component.id, isOpen]);

  const submit = () => {
    const destination = destinationFile.trim();
    if (!destination) return;
    void onFork({ componentId: component.id, destinationFile: destination });
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`Copy ${component.name} to this project`}
      className="ss-components-refactor-modal"
    >
      <div className="ss-components-refactor-form">
        <p className="ss-components-muted">
          This creates a reviewed local copy from <code>{library.packageName}</code>. The copy is
          detached from future library updates and no dependency or lockfile is changed.
        </p>
        <label className="ss-components-refactor-form__field">
          <span>Destination file</span>
          <TextField
            autoFocus
            value={destinationFile}
            onChange={(event) => setDestinationFile(event.currentTarget.value)}
            placeholder="src/components/Button.tsx"
            aria-label="Library fork destination file"
          />
        </label>
        <p className="ss-components-refactor-form__hint">
          <LockedIcon size={14} aria-hidden="true" />
          Source imports, path boundaries, and destination collisions are checked before review.
        </p>
        <div className="ss-components-refactor-form__actions">
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!destinationFile.trim()}
            onClick={submit}
            leftIcon={<CopyIcon size={14} />}
          >
            Review copy
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
