/**
 * RemoteAccessModal — set up, then watch, remote access.
 *
 * Until an assistant has actually connected it is a guided setup
 * (`RemoteSetup`); after that it is a live view (`RemoteLive`). Which one is
 * decided by what's true — a link nobody has used isn't "set up".
 *
 * Owns the data: status (re-polled while open), the dashboard's projects,
 * the activity log, and the few setup choices only the user can make, kept
 * per-viewer in localStorage because losing them costs one extra click.
 *
 * @module components/remote/RemoteAccessModal
 */

import { useCallback, useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { useOptionalToast } from '../../contexts/ToastContext';
import { getDashboardProjects, type DashboardProject } from '../../lib/project';
import {
  getRemoteAccessStatus,
  getRemoteAudit,
  isSetupComplete,
  setRemoteProject,
  type AuditEntry,
  type RemoteAccessStatus,
  type SetupChoices,
} from '../../lib/remoteAccess';
import { errMsg, RemoteOnBar, type RemoteCtl } from './parts';
import { RemoteSetup } from './RemoteSetup';
import { RemoteLive } from './RemoteLive';

const CHOICES_KEY = 'shipstudio.remoteAccess.setup';
const NO_CHOICES: SetupChoices = {
  understood: false,
  projectsConfirmed: false,
  pushingSkipped: false,
};

function loadChoices(): SetupChoices {
  try {
    const raw = window.localStorage.getItem(CHOICES_KEY);
    return raw ? { ...NO_CHOICES, ...(JSON.parse(raw) as Partial<SetupChoices>) } : NO_CHOICES;
  } catch {
    return NO_CHOICES;
  }
}

function saveChoices(choices: SetupChoices) {
  try {
    window.localStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
  } catch {
    // Storage blocked: the choices just won't survive a restart.
  }
}

const loadAuditEntries = () => getRemoteAudit(50);

interface RemoteAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function RemoteAccessModal({ isOpen, onClose }: RemoteAccessModalProps) {
  const { showToast } = useOptionalToast();
  const status = useAsyncState<RemoteAccessStatus>(getRemoteAccessStatus);
  const projects = useAsyncState<DashboardProject[]>(getDashboardProjects);
  const audit = useAsyncState<AuditEntry[]>(loadAuditEntries);
  const [busy, setBusy] = useState<string | null>(null);
  const [choices, setChoices] = useState<SetupChoices>(loadChoices);
  // "3 min ago" needs a clock; it advances with each poll rather than being
  // read during render.
  const [now, setNow] = useState(() => Date.now());

  const { execute: loadStatus, setData: setStatus } = status;
  const { execute: loadProjects } = projects;
  const { execute: loadAudit } = audit;
  useEffect(() => {
    if (!isOpen) return;
    void loadStatus();
    void loadProjects();
    void loadAudit();
  }, [isOpen, loadStatus, loadProjects, loadAudit]);

  usePolling(
    async () => {
      setNow(Date.now());
      void loadAudit();
      return loadStatus();
    },
    { intervalMs: 5000, enabled: isOpen, name: 'remote-access' }
  );

  const act = useCallback(
    async (key: string, fn: () => Promise<RemoteAccessStatus>) => {
      setBusy(key);
      try {
        setStatus(await fn());
        void loadAudit();
        return true;
      } catch (err) {
        showToast(errMsg(err), 'error');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [setStatus, loadAudit, showToast]
  );

  const setChoice = useCallback((key: keyof SetupChoices, value: boolean) => {
    setChoices((prev) => {
      const next = { ...prev, [key]: value };
      saveChoices(next);
      return next;
    });
  }, []);

  const s = status.data;
  const onProjectChange = (path: string, shared: boolean) => {
    if (!s) return;
    void setRemoteProject(path, shared)
      .then((next) => setStatus({ ...s, projects: next }))
      .catch((err: unknown) => showToast(errMsg(err), 'error'));
  };

  const ctl: RemoteCtl | null = s ? { status: s, busy, act, now } : null;
  const complete = s ? isSetupComplete(s, choices) : false;

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title="Remote access"
      className="settings-modal remote-access-modal"
    >
      <div className="settings-modal-body remote-access">
        {!ctl ? (
          <div className="remote-loading">
            {status.error ? (
              <p className="remote-error">Couldn’t read remote access status.</p>
            ) : (
              <Spinner />
            )}
          </div>
        ) : complete ? (
          <RemoteLive
            ctl={ctl}
            projects={projects.data ?? []}
            onProjectChange={onProjectChange}
            activity={audit.data ?? []}
          />
        ) : (
          <>
            <p className="remote-intro">
              Keep your agents going from your phone, with any AI assistant that supports MCP
              connectors — Grok, Claude, ChatGPT and more. It drives Ship Studio on this computer —
              the same tabs, the same conversations — so everything is waiting when you’re back.
            </p>
            <RemoteOnBar ctl={ctl} />
            <RemoteSetup
              ctl={ctl}
              choices={choices}
              setChoice={setChoice}
              projects={projects.data ?? []}
              onProjectChange={onProjectChange}
            />
          </>
        )}
      </div>
    </ModalFrame>
  );
}
