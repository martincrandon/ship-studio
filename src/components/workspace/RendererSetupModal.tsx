import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import type { NextRendererHostPlan } from '../../lib/components/next-renderer-adapter';

export interface RendererSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  adapterEnabled: boolean;
  approved: boolean;
  phase: 'review' | 'preparing' | 'host-ready' | 'installing' | 'ready';
  plan: NextRendererHostPlan | null;
  error: string | null;
  onEnable: () => void;
  onReset: () => void;
  onDisable: () => void;
}

/** Setup confirmation only; the renderer surface remains in the workspace. */
export function RendererSetupModal({
  isOpen,
  onClose,
  adapterEnabled,
  approved,
  phase,
  plan,
  error,
  onEnable,
  onReset,
  onDisable,
}: RendererSetupModalProps) {
  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Set up component renderer">
      <div className="renderer-setup-modal">
        <p>
          Ship Studio will add temporary renderer files to the project&apos;s existing framework
          runtime. It will not import project modules into Ship Studio.
        </p>
        <p>
          The isolated frame runs project code through the project&apos;s development server and may
          perform the same network, storage, and other side effects as opening the project locally.
        </p>
        {!adapterEnabled && (
          <div className="components-workspace__panel-note" role="status">
            The Next adapter is catalog-only until its framework acceptance matrix passes.
          </div>
        )}
        {phase === 'preparing' && <p role="status">Preparing the approved renderer…</p>}
        {plan?.supported && (
          <>
            <p>Proposed {plan.router === 'app' ? 'App Router' : 'Pages Router'} files:</p>
            <ul>
              {plan.files.map((file) => (
                <li key={file.relativePath}>
                  <code>{file.relativePath}</code> <span>({file.kind})</span>
                </li>
              ))}
            </ul>
            <p>{plan.setupReason}</p>
            <p>Renderer boundaries:</p>
            <ul>
              <li>Only JSON-compatible props and plain-text slots cross the frame boundary.</li>
              <li>
                Server actions, request-bound APIs, cookies/auth, and browser-only dependencies
                remain project-runtime concerns.
              </li>
              <li>
                Components that require unsupported runtime context stay catalog-only with a
                specific reason.
              </li>
            </ul>
            {phase === 'review' && adapterEnabled && (
              <Button variant="primary" onClick={onEnable}>
                {approved ? 'Start live previews' : 'Allow and enable live previews'}
              </Button>
            )}
            {phase === 'installing' && <p role="status">Installing reviewed host…</p>}
            {phase === 'ready' && <p role="status">Renderer host is installed for this session.</p>}
          </>
        )}
        {plan && !plan.supported && <p className="components-workspace__error">{plan.reason}</p>}
        {error && <p className="components-workspace__error">{error}</p>}
        {approved && (phase === 'ready' || phase === 'review') && (
          <div className="components-workspace__toolbar-actions">
            {phase === 'ready' && (
              <Button variant="danger" onClick={onReset}>
                Stop this session
              </Button>
            )}
            <Button variant="default" onClick={onDisable}>
              Disable live previews
            </Button>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
