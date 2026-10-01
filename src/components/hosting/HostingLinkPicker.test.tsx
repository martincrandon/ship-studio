/**
 * The link picker — where a project is told which provider project it deploys
 * to, and the screen that decides what every later hosting answer is *about*.
 *
 * It had no test and no harness scenario. Three things it does are worth
 * pinning, and all three are honesty rules rather than mechanics:
 *
 * 1. **An empty list is not a fact about the account.** For Cloudflare an empty
 *    list is what a token missing `Account Settings:Read` produces — the
 *    `/accounts` call returns nothing, so no Pages project is ever enumerated.
 *    For Vercel it is what a personal-scoped token produces when the work lives
 *    in a team, because `list_projects` asks with no `teamId`. Telling either
 *    user to go and create a project is advice about a problem they do not
 *    have.
 * 2. **A project must be identifiable before it is picked.** Cloudflare walks
 *    every account a token can see, so two accounts owning a project of the
 *    same name is reachable; a row printing only the name lets someone link
 *    this repo to another account's project and never know.
 * 3. **An abandoned request must not land behind the user.** The component
 *    guards this with a generation counter; the guard is only worth having if
 *    something holds it in place.
 *
 * Assertions read `document.body`, not `container` — `ModalFrame` portals, so
 * `container.textContent` is `''` and a negative assertion on it is inert
 * whatever the dialog says.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockIPC } from '@tauri-apps/api/mocks';
import { ToastContext } from '../../contexts/ToastContext';
import { HostingLinkPicker } from './HostingLinkPicker';
import type { DetectedLink } from '../../lib/hosting';

const showToast = vi.fn();

interface Handlers {
  onLinked: () => void;
  onNeedsToken: (provider: string, cloudflareProduct?: string) => void;
  onClose: () => void;
}

function renderPicker(detected: DetectedLink[] = [], over: Partial<Handlers> = {}) {
  const handlers: Handlers = {
    onLinked: over.onLinked ?? vi.fn(),
    onNeedsToken: over.onNeedsToken ?? vi.fn(),
    onClose: over.onClose ?? vi.fn(),
  };
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      <HostingLinkPicker
        projectPath="/Users/harness/ShipStudio/acme-marketing"
        detected={detected}
        {...handlers}
      />
    </ToastContext.Provider>
  );
  return handlers;
}

/** Answer `list_hosting_projects` with a fixed list, recording every call. */
function withProjects(projects: unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, ...((args ?? {}) as Record<string, unknown>) });
    if (cmd === 'list_hosting_projects') return projects;
    return null;
  });
  return calls;
}

const pickProvider = (name: RegExp) => userEvent.click(screen.getByRole('button', { name }));

describe('HostingLinkPicker — an empty project list', () => {
  beforeEach(() => showToast.mockClear());

  it('does not tell a Cloudflare user their account is empty', async () => {
    withProjects([]);
    renderPicker();

    await pickProvider(/^cloudflare$/i);
    await userEvent.click(screen.getByRole('button', { name: 'Pages' }));

    await waitFor(() => {
      expect(screen.getByText(/nothing came back from cloudflare pages/i)).toBeInTheDocument();
    });

    // The exact sentence this replaced. It stated as fact the one thing an
    // empty response cannot tell us, and then sent the user off to create a
    // project they very likely already have.
    expect(document.body.textContent).not.toMatch(/nothing was returned for this account/i);
    expect(document.body.textContent).not.toMatch(/create a project on the provider first/i);
    // The likely cause, named.
    expect(document.body.textContent).toMatch(/Account Settings:Read/);
  });

  it('names the team scope, not an empty account, for Vercel', async () => {
    withProjects([]);
    renderPicker();

    await pickProvider(/^vercel$/i);

    await waitFor(() => {
      expect(screen.getByText(/nothing came back from vercel/i)).toBeInTheDocument();
    });
    // `list_projects` asks Vercel with no `teamId`, so a token whose projects
    // live in a team sees exactly this.
    expect(document.body.textContent).toMatch(/team/i);
    expect(document.body.textContent).not.toMatch(/nothing was returned for this account/i);
  });

  it('offers a way back rather than a dead end', async () => {
    withProjects([]);
    renderPicker();

    await pickProvider(/^netlify$/i);

    await waitFor(() => {
      expect(screen.getByText(/nothing came back from netlify/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });
});

describe('HostingLinkPicker — choosing a project', () => {
  beforeEach(() => showToast.mockClear());

  it('lists what the provider returned and links the one that was clicked', async () => {
    const calls = withProjects([
      { id: 'prj_1', name: 'acme-marketing' },
      { id: 'prj_2', name: 'acme-docs' },
    ]);
    const { onLinked } = renderPicker();

    await pickProvider(/^vercel$/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'acme-docs' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'acme-docs' }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    const write = calls.find((c) => c.cmd === 'set_hosting_link');
    expect(write?.link).toMatchObject({
      provider: 'vercel',
      project_id: 'prj_2',
      project_name: 'acme-docs',
      source: 'user_picked',
    });
  });

  it('distinguishes two projects of the same name in different accounts', async () => {
    // Reachable, not hypothetical: Cloudflare's adapter enumerates every
    // account a token can see and uses the project *name* as its id, so the
    // list can hold two rows that differ only in the account they belong to.
    withProjects([
      { id: 'acme-docs', name: 'acme-docs', scope_id: 'acct_1', scope_name: 'Acme Inc' },
      { id: 'acme-docs', name: 'acme-docs', scope_id: 'acct_2', scope_name: 'Acme Labs' },
    ]);
    renderPicker();

    await pickProvider(/^cloudflare$/i);
    await userEvent.click(screen.getByRole('button', { name: 'Pages' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /acme-docs — Acme Inc/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /acme-docs — Acme Labs/ })).toBeInTheDocument();
    // Two rows a person can tell apart, rather than two identical labels one
    // of which links this repo to the wrong account's project.
    expect(screen.queryAllByRole('button', { name: 'acme-docs' })).toHaveLength(0);
  });

  it('carries the account through to the saved link', async () => {
    const calls = withProjects([
      { id: 'acme-docs', name: 'acme-docs', scope_id: 'acct_2', scope_name: 'Acme Labs' },
    ]);
    renderPicker();

    await pickProvider(/^cloudflare$/i);
    await userEvent.click(screen.getByRole('button', { name: 'Pages' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /acme-docs — Acme Labs/ })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole('button', { name: /acme-docs — Acme Labs/ }));

    await waitFor(() => expect(calls.some((c) => c.cmd === 'set_hosting_link')).toBe(true));
    // Without the scope, a later status call asks the wrong account about this
    // project — the one thing the row above is there to prevent.
    expect(calls.find((c) => c.cmd === 'set_hosting_link')?.link).toMatchObject({
      provider: 'cloudflare',
      project_id: 'acme-docs',
      scope_id: 'acct_2',
    });
  });

  it('requests Workers separately and persists its provider-supplied immutable tag', async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockIPC((cmd, args) => {
      if (cmd === 'list_hosting_projects') {
        calls.push({ cmd, ...((args ?? {}) as Record<string, unknown>) });
        return [
          {
            id: 'acme-api',
            name: 'acme-api',
            scope_id: 'acct_2',
            scope_name: 'Acme Labs',
            cloudflare_target: { kind: 'workers', script_tag: 'immutable-tag-2' },
          },
        ];
      }
      if (cmd === 'set_hosting_link') {
        calls.push({ cmd, ...((args ?? {}) as Record<string, unknown>) });
      }
      return null;
    });
    const { onLinked } = renderPicker();

    await pickProvider(/^cloudflare$/i);
    await userEvent.click(screen.getByRole('button', { name: 'Workers' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Workers · acme-api — Acme Labs/ })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole('button', { name: /Workers · acme-api — Acme Labs/ }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      cmd: 'list_hosting_projects',
      projectPath: '/Users/harness/ShipStudio/acme-marketing',
      provider: 'cloudflare',
      cloudflareProduct: 'workers',
    });
    expect(calls[1]).toMatchObject({
      cmd: 'set_hosting_link',
      projectPath: '/Users/harness/ShipStudio/acme-marketing',
      link: {
        provider: 'cloudflare',
        project_id: 'acme-api',
        scope_id: 'acct_2',
        cloudflare_target: { kind: 'workers', script_tag: 'immutable-tag-2' },
      },
    });
  });

  it('does not allow a Workers row without its provider-supplied immutable tag to be linked', async () => {
    withProjects([{ id: 'acme-api', name: 'acme-api', scope_id: 'acct_2' }]);
    renderPicker();

    await pickProvider(/^cloudflare$/i);
    await userEvent.click(screen.getByRole('button', { name: 'Workers' }));
    const choice = await screen.findByRole('button', { name: /Workers · acme-api/ });
    expect(choice).toBeDisabled();
  });
});

describe('HostingLinkPicker — a link the provider CLI already left on disk', () => {
  beforeEach(() => showToast.mockClear());

  const detected: DetectedLink[] = [
    {
      provider: 'vercel',
      project_id: 'prj_from_disk',
      scope_id: 'team_abc',
      project_name: 'acme-marketing',
      source: 'vercel_cli_file',
    },
  ];

  it('offers it by name, and saves exactly what was on disk', async () => {
    const calls = withProjects([]);
    const { onLinked } = renderPicker(detected);

    await userEvent.click(screen.getByRole('button', { name: /Vercel — acme-marketing/ }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(calls.find((c) => c.cmd === 'set_hosting_link')?.link).toMatchObject({
      provider: 'vercel',
      project_id: 'prj_from_disk',
      scope_id: 'team_abc',
      source: 'vercel_cli_file',
    });
    // No network for this path: the CLI already answered this question.
    expect(calls.some((c) => c.cmd === 'list_hosting_projects')).toBe(false);
  });
});

describe('HostingLinkPicker — failures', () => {
  beforeEach(() => showToast.mockClear());

  it('sends a missing credential to the connect flow instead of a red toast', async () => {
    mockIPC((cmd) => {
      if (cmd === 'list_hosting_projects') {
        // A rejected *object*, not an `Error`: that is what a `CommandError`
        // arrives as over the real IPC, and `asCommandError` reads `.type` off
        // it. Rejecting with an Error here would test a shape the app never
        // receives, and the `NotAuthenticated` branch would never be taken.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a plain CommandError object, the shape under test
        return Promise.reject({ type: 'NotAuthenticated', service: 'Cloudflare' });
      }
      return null;
    });
    const { onNeedsToken } = renderPicker();

    await pickProvider(/^cloudflare$/i);
    await userEvent.click(screen.getByRole('button', { name: 'Pages' }));

    await waitFor(() => expect(onNeedsToken).toHaveBeenCalledWith('cloudflare', 'pages'));
    // Having no token yet is the expected first-run state, not an error.
    expect(showToast).not.toHaveBeenCalled();
  });

  it('reports a real failure and does not show an empty list in its place', async () => {
    mockIPC((cmd) => {
      if (cmd === 'list_hosting_projects') throw new Error('Vercel is temporarily unavailable');
      return null;
    });
    renderPicker();

    await pickProvider(/^vercel$/i);

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast.mock.calls[0][1]).toBe('error');
    // An empty list here would read as "you have no projects", which is the
    // same lie as the empty state used to tell, arrived at from a failure.
    expect(document.body.textContent).not.toMatch(/nothing came back from/i);
    expect(screen.getByRole('button', { name: /^cloudflare$/i })).toBeInTheDocument();
  });

  it('never lets an abandoned provider’s response land behind the user', async () => {
    // Pick Vercel, go back, pick Netlify: Vercel's slower answer must not
    // populate a list the header says is Netlify's. Choosing a row there wrote
    // a Vercel project id as this project's *Netlify* link.
    let releaseVercel: (v: unknown) => void = () => {};
    const slowVercel = new Promise((resolve) => {
      releaseVercel = resolve;
    });

    mockIPC((cmd, args) => {
      if (cmd === 'list_hosting_projects') {
        const provider = (args as { provider?: string })?.provider;
        if (provider === 'vercel') return slowVercel;
        return [{ id: 'site_n', name: 'netlify-site' }];
      }
      return null;
    });
    renderPicker();

    await pickProvider(/^vercel$/i);
    await screen.findByText(/loading your vercel projects/i);
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    await pickProvider(/^netlify$/i);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'netlify-site' })).toBeInTheDocument()
    );

    releaseVercel([{ id: 'prj_v', name: 'vercel-project' }]);

    // Give the abandoned response every chance to be rendered.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'vercel-project' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'netlify-site' })).toBeInTheDocument();
  });
});
