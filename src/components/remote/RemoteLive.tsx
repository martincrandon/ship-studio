/**
 * The view once setup is finished: is it reachable, will it stay reachable,
 * what can it reach, and what has it done.
 *
 * The hero answers the first question in one glance — Live / Not reachable /
 * Off — from what Tailscale confirms. Problems that could cut the phone off
 * are pulled up out of the checklist so they can't be scrolled past.
 *
 * @module components/remote/RemoteLive
 */

import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import type { DashboardProject } from '../../lib/project';
import {
  describeLastRequest,
  liveState,
  setRemoteAccessEnabled,
  TAILSCALE_MACHINES_URL,
  warningCount,
  type AuditEntry,
} from '../../lib/remoteAccess';
import {
  ActivityList,
  busyProps,
  ConnectionPanel,
  LinkRow,
  ProjectPicker,
  PushPanel,
  ReadinessList,
  type RemoteCtl,
} from './parts';

interface Props {
  ctl: RemoteCtl;
  projects: DashboardProject[];
  onProjectChange: (path: string, shared: boolean) => void;
  activity: AuditEntry[];
}

const ACTIVITY_PREVIEW = 6;

export function RemoteLive({ ctl, projects, onProjectChange, activity }: Props) {
  const { status, busy, act, now } = ctl;
  const state = liveState(status);
  const toFix = warningCount(status);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const lastRequest = describeLastRequest(status.activity, now);
  const host = status.tailscale.state === 'connected' ? status.tailscale.dnsName : null;

  const headline = { live: 'Live', down: 'Not reachable', off: 'Off' }[state];
  const subline =
    state === 'live'
      ? (lastRequest ?? 'Waiting for your assistant’s next message')
      : state === 'down'
        ? status.reachability?.state === 'noPublicDns'
          ? 'Tailscale is still publishing this computer’s address.'
          : 'Remote access is on, but the internet can’t reach this computer right now.'
        : 'Your assistant can’t reach this computer.';

  return (
    <div className="remote-live">
      <div className={`remote-hero remote-hero--${state}`} data-testid="remote-hero">
        <span className="remote-hero__dot" aria-hidden />
        <div className="remote-hero__text">
          <span className="remote-hero__headline">{headline}</span>
          <span className="remote-hero__sub">{subline}</span>
          {host && state === 'live' && <span className="remote-hero__host">{host}</span>}
        </div>
        {state === 'off' ? (
          <Button
            variant="primary"
            {...busyProps(busy, 'enable')}
            onClick={() => void act('enable', () => setRemoteAccessEnabled(true))}
          >
            Turn on
          </Button>
        ) : (
          <Button
            variant="secondary"
            {...busyProps(busy, 'disable')}
            onClick={() => void act('disable', () => setRemoteAccessEnabled(false))}
          >
            Turn off
          </Button>
        )}
      </div>

      {state === 'down' && (
        <section className="remote-section">
          <ConnectionPanel ctl={ctl} />
        </section>
      )}

      <section className="remote-section">
        <div className="remote-section__head">
          <h3 className="remote-heading">Before you leave</h3>
          <span
            className={`remote-badge remote-badge--${toFix === 0 ? 'ok' : 'warn'}`}
            data-testid="remote-readiness"
          >
            {toFix === 0 ? 'Ready to leave' : `${toFix} to fix`}
          </span>
        </div>
        <ReadinessList ctl={ctl} />
      </section>

      <section className="remote-section">
        <h3 className="remote-heading">Projects your assistant can reach</h3>
        <ProjectPicker status={status} projects={projects} onChange={onProjectChange} />
      </section>

      <section className="remote-section">
        <h3 className="remote-heading">Pushing from your phone</h3>
        <PushPanel ctl={ctl} />
      </section>

      {state === 'live' && (
        <section className="remote-section">
          <h3 className="remote-heading">Link</h3>
          <LinkRow ctl={ctl} allowReset />
        </section>
      )}

      <section className="remote-section">
        <div className="remote-section__head">
          <h3 className="remote-heading">Recent activity</h3>
          {status.activity.rejectedRequests > 0 && (
            <span className="remote-badge remote-badge--warn">
              {status.activity.rejectedRequests} refused
            </span>
          )}
        </div>
        <ActivityList
          entries={showAllActivity ? activity : activity.slice(0, ACTIVITY_PREVIEW)}
          now={now}
        />
        {activity.length > ACTIVITY_PREVIEW && (
          <TextButton onClick={() => setShowAllActivity((v) => !v)}>
            {showAllActivity ? 'Show less' : `Show all ${activity.length}`}
          </TextButton>
        )}
      </section>

      <p className="remote-footnote">
        Lost your phone, or something looks wrong? Turn off here, or remove this Mac in{' '}
        <TextButton onClick={() => void openUrl(TAILSCALE_MACHINES_URL)}>
          Tailscale’s admin console
        </TextButton>{' '}
        from any device — that cuts the link off immediately.
      </p>
    </div>
  );
}
