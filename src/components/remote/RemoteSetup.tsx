/**
 * First-time setup, as five steps that each finish on something real.
 *
 * 1. **This computer has to stay on** — first, and acknowledged, because it
 *    is the thing people would otherwise find out from their phone.
 * 2. **A private link** — Tailscale, then the Funnel. Done when Tailscale
 *    confirms it, not when we asked.
 * 3. **Projects** — nothing is reachable until it's ticked.
 * 4. **Pushing** — off unless the user sets a PIN; skipping is a real choice.
 * 5. **Connect your assistant** — done when an assistant has actually connected.
 *
 * Done steps collapse to a one-line summary and can be reopened. Upcoming
 * steps show their title only, so the whole path is visible from the start.
 *
 * @module components/remote/RemoteSetup
 */

import { useState, type ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { CheckIcon } from '@/components/icons';
import type { DashboardProject } from '../../lib/project';
import {
  setupSteps,
  warningCount,
  type SetupChoices,
  type SetupStepId,
} from '../../lib/remoteAccess';
import { ConnectionPanel, PinForm, ProjectPicker, ReadinessList, type RemoteCtl } from './parts';

interface Props {
  ctl: RemoteCtl;
  choices: SetupChoices;
  setChoice: (key: keyof SetupChoices, value: boolean) => void;
  projects: DashboardProject[];
  onProjectChange: (path: string, shared: boolean) => void;
}

export function RemoteSetup({ ctl, choices, setChoice, projects, onProjectChange }: Props) {
  const { status } = ctl;
  const steps = setupSteps(status, choices);
  const [reopened, setReopened] = useState<SetupStepId | null>(null);
  const toFix = warningCount(status);

  const summary: Record<SetupStepId, string> = {
    stayOn:
      toFix === 0
        ? 'Ready to leave'
        : `${toFix} thing${toFix === 1 ? '' : 's'} to fix before you leave`,
    connect: status.tailscale.state === 'connected' ? status.tailscale.dnsName : 'Link is live',
    projects: `${status.projects.length} project${status.projects.length === 1 ? '' : 's'} shared`,
    pushing: status.pushPin === 'notSet' ? 'Off — no pushing from your phone' : 'On, with your PIN',
    assistant: 'Connected',
  };

  const body: Record<SetupStepId, ReactNode> = {
    stayOn: (
      <>
        <p className="remote-lede">
          Your assistant doesn’t run your agents — this computer does. If it sleeps, shuts down,
          loses Wi-Fi, or Ship Studio quits, your assistant can’t reach it, and{' '}
          <strong>nothing can wake it up from your phone</strong>.
        </p>
        <ReadinessList ctl={ctl} />
        <div className="remote-actions">
          <Button
            variant="primary"
            onClick={() => {
              setChoice('understood', true);
              setReopened(null);
            }}
          >
            Got it — set it up
          </Button>
        </div>
      </>
    ),
    connect: <ConnectionPanel ctl={ctl} />,
    projects: (
      <>
        <p className="remote-note">
          Your assistant only sees the projects you tick. You can change this any time.
        </p>
        <ProjectPicker status={status} projects={projects} onChange={onProjectChange} />
        <div className="remote-actions">
          <Button
            variant="primary"
            disabled={status.projects.length === 0}
            onClick={() => {
              setChoice('projectsConfirmed', true);
              setReopened(null);
            }}
          >
            Continue
          </Button>
        </div>
      </>
    ),
    pushing: (
      <>
        <p className="remote-note">
          To push from your phone, set a PIN here. Your assistant never sees it: when you want to
          push, it shows you what would go out and you type the PIN yourself. Five wrong tries lock
          pushing until you’re back.
        </p>
        <PinForm ctl={ctl} submitLabel="Allow pushing" onDone={() => setReopened(null)} />
        <div className="remote-actions">
          <Button
            variant="ghost"
            onClick={() => {
              setChoice('pushingSkipped', true);
              setReopened(null);
            }}
          >
            Skip — I’ll push from the computer
          </Button>
        </div>
      </>
    ),
    assistant: (
      <>
        <ConnectionPanel ctl={ctl} />
        <ol className="remote-steps-mini">
          <li>Copy the link.</li>
          <li>
            In your AI assistant, add a custom MCP connector, name it <strong>Ship Studio</strong>,
            and paste the link. Grok, Claude, ChatGPT and Cursor all have one — anything that speaks
            MCP works.
          </li>
          <li>
            Ask it: <em>“What are my Ship Studio agents doing?”</em>
          </li>
        </ol>
        {status.reachability?.state === 'reachable' && (
          <div className="remote-waiting">
            <Spinner size="sm" /> Waiting for your assistant to connect…
          </div>
        )}
      </>
    ),
  };

  return (
    <ol className="remote-stepper">
      {steps.map((step, i) => {
        const open = step.state === 'current' || reopened === step.id;
        return (
          <li key={step.id} className={`remote-step remote-step--${step.state}`}>
            <div className="remote-step__head">
              <span className="remote-step__marker" aria-hidden>
                {step.state === 'done' ? <CheckIcon size={12} /> : i + 1}
              </span>
              <span className="remote-step__title">{step.title}</span>
              {step.state === 'done' && !open && (
                <>
                  <span className="remote-step__summary">{summary[step.id]}</span>
                  {step.id !== 'assistant' && (
                    <Button
                      variant="ghost"
                      size="compact"
                      className="remote-step__edit"
                      onClick={() => setReopened(step.id)}
                    >
                      Change
                    </Button>
                  )}
                </>
              )}
            </div>
            {open && <div className="remote-step__body">{body[step.id]}</div>}
          </li>
        );
      })}
    </ol>
  );
}
