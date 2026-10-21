import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { useAsyncState } from '../hooks/useAsyncState';
import { getRemoteAccessBrief } from '../lib/remoteAccess';

interface QuitConfirmModalProps {
  onCancel: () => void;
  onQuit: () => void;
}

/**
 * Cmd+Q confirmation. Rendered by every top-level view branch in App.tsx, so
 * it lives at the component root alongside the other app-global chrome.
 */
export function QuitConfirmModal({ onCancel, onQuit }: QuitConfirmModalProps) {
  // Someone may be relying on this computer from their phone. Quitting is the
  // one thing that silently cuts them off, so say so here, where it's decided.
  const remote = useAsyncState(getRemoteAccessBrief, { immediate: true });
  const remoteOn = remote.data?.enabled === true;
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      ariaLabel="Quit Ship Studio"
      showCloseButton={false}
      className="quit-confirm-modal"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter') onQuit();
        }}
      >
        <p>Are you sure you want to quit Ship Studio?</p>
        {remoteOn && (
          <p className="quit-confirm-remote">
            Remote access is on. Quitting stops your assistant reaching this computer until Ship
            Studio is open again.
          </p>
        )}
        <div className="quit-confirm-actions">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onQuit} autoFocus>
            Quit
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
