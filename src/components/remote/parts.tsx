/**
 * The building blocks the Remote access setup and live views share: the
 * stay-on checklist, the connection panel, the project picker, the push PIN
 * panel, the link row, and the activity log.
 *
 * Each takes the same `RemoteCtl` — the current status plus a way to run an
 * action that returns fresh status — so the two views can arrange them
 * differently without either owning the state.
 *
 * @module components/remote/parts
 */

import { useState, type FormEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { Spinner } from '../primitives/Spinner';
import { TextField } from '../primitives/TextField';
import { CopyIcon, ExternalLinkIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import type { DashboardProject } from '../../lib/project';
import {
  agoText,
  clearRemotePushPin,
  connectionStep,
  copyRemoteLink,
  describeAudit,
  getRemoteAccessStatus,
  pinProblem,
  readinessItems,
  republishRemoteLink,
  resetRemoteLink,
  setLidClosedMode,
  setOpenAtLogin,
  setRemoteAccessEnabled,
  setRemotePushPin,
  TAILSCALE_DOWNLOAD_URL,
  type AuditEntry,
  type RemoteAccessStatus,
} from '../../lib/remoteAccess';

export const errMsg = (err: unknown) => formatCommandError(asCommandError(err));

export interface RemoteCtl {
  status: RemoteAccessStatus;
  /** Which action is running, if any. Everything else is disabled meanwhile. */
  busy: string | null;
  act: (key: string, fn: () => Promise<RemoteAccessStatus>) => Promise<boolean>;
  now: number;
}

/** Disable every action while one runs, and spin the one that is running. */
export function busyProps(busy: string | null, key: string) {
  return {
    disabled: busy !== null,
    leftIcon: busy === key ? <Spinner size="sm" /> : undefined,
  };
}

// ============================================================================
// Stay-on checklist
// ============================================================================

export function ReadinessList({ ctl }: { ctl: RemoteCtl }) {
  const { status, busy, act } = ctl;
  return (
    <ul className="remote-checklist">
      {readinessItems(status).map((item) => (
        <li key={item.id} className={`remote-check remote-check--${item.state}`}>
          <span className="remote-check__icon" aria-hidden>
            {item.state === 'ok' ? <SuccessIcon size={14} /> : <WarningIcon size={14} />}
          </span>
          <span className="remote-check__body">
            <span className="remote-check__title">{item.title}</span>
            <span className="remote-check__detail">{item.detail}</span>
            {item.id === 'lid' && status.lidClosedMode !== null && (
              <label className="remote-toggle">
                <Checkbox
                  checked={status.lidClosedMode}
                  disabled={busy !== null}
                  label="Keep running with the lid closed"
                  onChange={(on) => void act('lid', () => setLidClosedMode(on))}
                />
                <span className="remote-toggle__text">
                  Keep running with the lid closed
                  <span className="remote-toggle__hint">
                    Asks for your Mac password. Keep it plugged in. Switched back when you turn
                    remote access off.
                  </span>
                </span>
              </label>
            )}
            {item.id === 'restart' && (
              <label className="remote-toggle">
                <Checkbox
                  checked={status.openAtLogin}
                  disabled={busy !== null || !status.openAtLoginAvailable}
                  label="Reopen Ship Studio after a restart"
                  onChange={(on) => void act('login', () => setOpenAtLogin(on))}
                />
                <span className="remote-toggle__text">
                  Reopen Ship Studio after a restart
                  {!status.openAtLoginAvailable && (
                    <span className="remote-toggle__hint">Only in the installed app.</span>
                  )}
                </span>
              </label>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ============================================================================
// Connection
// ============================================================================

/** Everything between "no Tailscale" and "the link is live". */
export function ConnectionPanel({ ctl }: { ctl: RemoteCtl }) {
  const { status, busy, act } = ctl;
  const step = connectionStep(status, ctl.now);
  // On a laptop, offered alongside Turn on and ticked by default: closing the
  // lid is the most common way remote access silently stops.
  const offerLid = status.power.hasBattery && status.lidClosedMode === false;
  const [withLid, setWithLid] = useState(true);
  const turnOn = () =>
    void act('enable', async () => {
      const next = await setRemoteAccessEnabled(true);
      return offerLid && withLid ? setLidClosedMode(true) : next;
    });
  const recheck = () => void act('check', getRemoteAccessStatus);

  switch (step.kind) {
    case 'unsupported':
      return <p className="remote-note">Remote access is only available on macOS for now.</p>;
    case 'installTailscale':
      return (
        <>
          <p className="remote-note">
            Tailscale (free) gives this computer a private web address on <em>your</em> account.
            Your assistant talks to it directly — nothing passes through Ship Studio’s servers.
          </p>
          <div className="remote-actions">
            <Button
              variant="primary"
              rightIcon={<ExternalLinkIcon size={14} />}
              onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}
            >
              Get Tailscale
            </Button>
            <Button variant="secondary" {...busyProps(busy, 'check')} onClick={recheck}>
              I’ve installed it
            </Button>
          </div>
        </>
      );
    case 'signInTailscale':
      return (
        <>
          <p className="remote-note">
            Open Tailscale from the menu bar and sign in, then come back here.
          </p>
          <div className="remote-actions">
            <Button variant="secondary" {...busyProps(busy, 'check')} onClick={recheck}>
              I’ve signed in
            </Button>
          </div>
        </>
      );
    case 'tailscaleProblem':
      return (
        <>
          <p className="remote-error">Tailscale didn’t answer as expected: {step.detail}</p>
          <div className="remote-actions">
            <Button variant="secondary" {...busyProps(busy, 'check')} onClick={recheck}>
              Check again
            </Button>
          </div>
        </>
      );
    case 'off':
      return (
        <>
          <p className="remote-note">
            Turning this on keeps the computer awake and gives it a link only you have.
          </p>
          {offerLid && (
            <label className="remote-toggle">
              <Checkbox
                checked={withLid}
                disabled={busy !== null}
                label="Keep running with the lid closed"
                onChange={setWithLid}
              />
              <span className="remote-toggle__text">
                Keep running with the lid closed
                <span className="remote-toggle__hint">
                  Asks for your Mac password. Keep it plugged in — with the lid shut it keeps
                  working and uses battery, and shouldn’t go in a bag. Switched back when you turn
                  remote access off.
                </span>
              </span>
            </label>
          )}
          <div className="remote-actions">
            <Button variant="primary" {...busyProps(busy, 'enable')} onClick={turnOn}>
              Turn on remote access
            </Button>
          </div>
        </>
      );
    case 'approveFunnel':
      return (
        <>
          <p className="remote-note">
            Tailscale needs your OK, once, before this computer can have a public link. Tailscale
            calls this Funnel.
          </p>
          <div className="remote-actions">
            <Button
              variant="primary"
              rightIcon={<ExternalLinkIcon size={14} />}
              onClick={() => void openUrl(step.url)}
            >
              Allow in Tailscale
            </Button>
            <Button variant="secondary" {...busyProps(busy, 'enable')} onClick={turnOn}>
              I’ve allowed it
            </Button>
          </div>
        </>
      );
    case 'funnelFailed':
      return (
        <>
          <p className="remote-error">Couldn’t publish the link: {step.detail}</p>
          <div className="remote-actions">
            <Button variant="secondary" {...busyProps(busy, 'enable')} onClick={turnOn}>
              Try again
            </Button>
          </div>
        </>
      );
    case 'starting':
      return (
        <div className="remote-waiting">
          <Spinner size="sm" /> Waiting for Tailscale to confirm the link…
        </div>
      );
    case 'publishing': {
      const elapsed = step.minutes > 0 ? ` (${step.minutes} min so far)` : '';
      const message = {
        waiting: `Tailscale is making this address public — usually a minute or two${elapsed}. You can add the link to your assistant now; it starts working once this turns green.`,
        retried: `That took longer than usual, so Ship Studio asked Tailscale again${elapsed}. It normally goes through within a couple of minutes of asking.`,
        stuck: `Tailscale still hasn’t made this address public${elapsed}. Ask again below — if that doesn’t do it, the hold-up is on Tailscale’s side.`,
      }[step.stage];
      return (
        <>
          <LinkRow ctl={ctl} />
          <div
            className={`remote-waiting${step.stage === 'stuck' ? ' remote-waiting--warn' : ''}`}
            data-testid="remote-publishing"
          >
            {step.stage === 'stuck' ? <WarningIcon size={14} /> : <Spinner size="sm" />}
            <span>{message}</span>
          </div>
          <div className="remote-actions">
            <Button
              variant="secondary"
              size="compact"
              {...busyProps(busy, 'republish')}
              onClick={() => void act('republish', republishRemoteLink)}
            >
              Ask Tailscale again
            </Button>
          </div>
        </>
      );
    }
    case 'unreachable':
      return (
        <>
          <LinkRow ctl={ctl} />
          <p className="remote-error">Not reachable from the internet yet: {step.detail}</p>
          <div className="remote-actions">
            <Button variant="secondary" {...busyProps(busy, 'check')} onClick={recheck}>
              Check again
            </Button>
          </div>
        </>
      );
    case 'ready':
      return (
        <>
          <LinkRow ctl={ctl} />
          <p className="remote-ok">
            <SuccessIcon size={14} /> Reachable from the internet — checked just now.
          </p>
        </>
      );
  }
}

/**
 * Shown above setup whenever remote access is on, so it can always be turned
 * off — including mid-setup, when the live view (and its Turn off) isn't
 * reachable yet.
 */
export function RemoteOnBar({ ctl }: { ctl: RemoteCtl }) {
  const { status, busy, act } = ctl;
  if (!status.enabled) return null;
  return (
    <div className="remote-onbar" data-testid="remote-onbar">
      <span className="remote-onbar__dot" aria-hidden />
      <span className="remote-onbar__text">
        Remote access is on — this computer is being kept awake.
      </span>
      <Button
        variant="secondary"
        size="compact"
        {...busyProps(busy, 'disable')}
        onClick={() => void act('disable', () => setRemoteAccessEnabled(false))}
      >
        Turn off
      </Button>
    </div>
  );
}

/** The masked link, Copy, and New link. The real link never reaches the page. */
export function LinkRow({ ctl, allowReset = false }: { ctl: RemoteCtl; allowReset?: boolean }) {
  const { status, busy, act } = ctl;
  const { showToast } = useOptionalToast();
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  if (!status.linkMasked) return null;

  const copy = async () => {
    try {
      await copyRemoteLink();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      showToast(
        'Link copied — paste it into your assistant’s connector settings only. It clears from your clipboard in 90 seconds.',
        'success'
      );
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  return (
    <div className="remote-link">
      <div className="remote-link__row">
        <code className="remote-link__url" data-testid="remote-link">
          {status.linkMasked}
        </code>
        <Button
          variant="secondary"
          size="compact"
          leftIcon={<CopyIcon size={14} />}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <div className="remote-keynote" role="note">
        <WarningIcon size={16} />
        <span>
          <strong>This link is a key to this computer.</strong> Paste it only into your own AI
          assistant’s connector settings — never into a chat message, email, screenshot, shared doc
          or issue. If it might have leaked, replace it
          {allowReset ? ' below' : ' from Remote access'}.
        </span>
      </div>
      {allowReset &&
        (confirmReset ? (
          <div className="remote-confirm">
            <span>
              The old link stops working at once, and you’ll add the new one to your assistant.
            </span>
            <Button variant="ghost" size="compact" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="compact"
              {...busyProps(busy, 'reset')}
              onClick={() => void act('reset', resetRemoteLink).then(() => setConfirmReset(false))}
            >
              Replace link
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="compact" onClick={() => setConfirmReset(true)}>
            Replace link…
          </Button>
        ))}
    </div>
  );
}

// ============================================================================
// Projects
// ============================================================================

export function ProjectPicker({
  status,
  projects,
  onChange,
}: {
  status: RemoteAccessStatus;
  projects: DashboardProject[];
  onChange: (path: string, shared: boolean) => void;
}) {
  const shared = new Set(status.projects);
  if (projects.length === 0) {
    return <p className="remote-note">No projects yet.</p>;
  }
  return (
    <ul className="remote-projects">
      {projects.map((p) => (
        <li key={p.path}>
          <label className="remote-toggle remote-toggle--row">
            <Checkbox
              checked={shared.has(p.path)}
              label={`Share ${p.name}`}
              onChange={(on) => onChange(p.path, on)}
            />
            <span className="remote-project__name">{p.name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

// ============================================================================
// Push PIN
// ============================================================================

/**
 * Set or change the push PIN. Two fields, so a typo can't lock the user out
 * of pushing from their phone; the rules are checked before anything is sent.
 */
export function PinForm({
  ctl,
  submitLabel,
  onDone,
  onCancel,
}: {
  ctl: RemoteCtl;
  submitLabel: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = pinProblem(pin);
  const mismatch = again.length > 0 && again !== pin;
  const canSubmit = problem === null && again === pin;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    const ok = await ctl.act('pin', () => setRemotePushPin(pin));
    if (ok) {
      setPin('');
      setAgain('');
      onDone?.();
    }
  };

  return (
    <form className="remote-pin" onSubmit={(e) => void submit(e)}>
      <div className="remote-pin__fields">
        <label className="remote-pin__field">
          <span>Push PIN</span>
          <TextField
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={12}
            value={pin}
            invalid={touched && problem !== null}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onBlur={() => setTouched(true)}
            aria-label="Push PIN"
          />
        </label>
        <label className="remote-pin__field">
          <span>Again</span>
          <TextField
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={12}
            value={again}
            invalid={mismatch}
            onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
            aria-label="Push PIN again"
          />
        </label>
      </div>
      <p className={`remote-hint${touched && (problem || mismatch) ? ' remote-hint--error' : ''}`}>
        {touched && problem
          ? problem
          : mismatch
            ? 'The two PINs don’t match.'
            : '6–12 digits. Not your phone or bank PIN — and never written in a chat until you want to push.'}
      </p>
      <div className="remote-actions">
        <Button type="submit" variant="primary" {...busyProps(ctl.busy, 'pin')}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** Pushing in the live view: on, off, or locked — and how to change it. */
export function PushPanel({ ctl }: { ctl: RemoteCtl }) {
  const { status, busy, act } = ctl;
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <PinForm
        ctl={ctl}
        submitLabel={status.pushPin === 'notSet' ? 'Allow pushing' : 'Save new PIN'}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  switch (status.pushPin) {
    case 'notSet':
      return (
        <div className="remote-row">
          <p className="remote-note">Off. Your assistant can’t push anything.</p>
          <Button variant="secondary" size="compact" onClick={() => setEditing(true)}>
            Allow with a PIN…
          </Button>
        </div>
      );
    case 'set':
      return (
        <div className="remote-row">
          <p className="remote-note">On. Every push needs your PIN, typed by you in the chat.</p>
          <span className="remote-row__actions">
            <Button variant="ghost" size="compact" onClick={() => setEditing(true)}>
              Change PIN
            </Button>
            <Button
              variant="secondary"
              size="compact"
              {...busyProps(busy, 'pinOff')}
              onClick={() => void act('pinOff', clearRemotePushPin)}
            >
              Turn off pushing
            </Button>
          </span>
        </div>
      );
    case 'locked':
      return (
        <div className="remote-alert" role="alert">
          <WarningIcon size={14} />
          <div>
            <p className="remote-alert__title">Pushing is locked</p>
            <p className="remote-note">
              Five wrong PINs in a row. If that wasn’t you, replace the link too — someone else may
              have it.
            </p>
            <div className="remote-actions">
              <Button variant="secondary" size="compact" onClick={() => setEditing(true)}>
                Set a new PIN…
              </Button>
              <Button
                variant="ghost"
                size="compact"
                {...busyProps(busy, 'pinOff')}
                onClick={() => void act('pinOff', clearRemotePushPin)}
              >
                Leave pushing off
              </Button>
            </div>
          </div>
        </div>
      );
  }
}

// ============================================================================
// Activity
// ============================================================================

export function ActivityList({ entries, now }: { entries: AuditEntry[]; now: number }) {
  if (entries.length === 0) {
    return (
      <p className="remote-note">Nothing yet. Everything your assistant does shows up here.</p>
    );
  }
  return (
    <ul className="remote-activity">
      {entries.map((e, i) => (
        <li
          key={`${e.atMs}-${i}`}
          className={`remote-activity__item${e.ok ? '' : ' remote-activity__item--refused'}`}
        >
          <span className="remote-activity__text">{describeAudit(e)}</span>
          <span className="remote-activity__when">{agoText(e.atMs, now)}</span>
        </li>
      ))}
    </ul>
  );
}
