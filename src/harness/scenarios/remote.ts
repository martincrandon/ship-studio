/**
 * Remote access — the setup flow step by step, the live view, and the
 * sidebar indicator.
 *
 * Setup choices the user makes in the modal (read the warning, confirmed
 * projects, skipped pushing) live in localStorage, so the scenarios for
 * later steps seed it rather than clicking through.
 */

import type { Scenario } from '../types';

const DNS = 'studio-mac.tail1234.ts.net';
const MASKED = `https://${DNS}/shipstudio/mcp/3f9c••••••••`;
const PROJECTS = [
  '/Users/harness/ShipStudio/acme-marketing',
  '/Users/harness/ShipStudio/client-portal',
  '/Users/harness/ShipStudio/docs-site',
];
const MIN = 60_000;

/** The modal's whole input. Every scenario overrides only what it is about. */
export function remoteStatus(over: Record<string, unknown> = {}) {
  return {
    supported: true,
    enabled: false,
    serverRunning: false,
    tailscale: { state: 'notInstalled' },
    funnelOn: false,
    funnelApprovalUrl: null,
    funnelError: null,
    linkMasked: null,
    reachability: null,
    publish: { sinceMs: null, autoRetried: false, gaveUp: false },
    power: { hasBattery: true, onAc: false, batteryPercent: 64, charging: false },
    keepAwake: false,
    lidClosedMode: false,
    openAtLogin: false,
    openAtLoginAvailable: true,
    pushPin: 'notSet',
    projects: [],
    everConnected: false,
    activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
    ...over,
  };
}

/** What the sidebar polls. Off by default, so no indicator shows. */
export function remoteBrief(over: Record<string, unknown> = {}) {
  return {
    enabled: false,
    serverRunning: false,
    keepAwake: false,
    power: { hasBattery: true, onAc: true, batteryPercent: 90, charging: true },
    lidClosedMode: false,
    activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
    ...over,
  };
}

const dashboardProjects = PROJECTS.map((path) => ({
  name: path.split('/').pop(),
  path,
  thumbnail: null,
  last_opened: null,
  git_branch: 'main',
}));

const ON = {
  enabled: true,
  serverRunning: true,
  tailscale: { state: 'connected', dnsName: DNS },
  funnelOn: true,
  linkMasked: MASKED,
  reachability: { state: 'reachable' },
  keepAwake: true,
  power: { hasBattery: true, onAc: true, batteryPercent: 88, charging: true },
};

const choices = (c: Record<string, boolean>) => ({
  'shipstudio.remoteAccess.setup': JSON.stringify(c),
});

const audit = [
  {
    atMs: Date.now() - 2 * MIN,
    tool: 'send_to_agent',
    project: PROJECTS[0],
    detail:
      'The client wants the hero headline to say “Built for teams” — change it and check mobile',
    ok: true,
  },
  {
    atMs: Date.now() - 3 * MIN,
    tool: 'press_key',
    project: PROJECTS[0],
    detail: 'key enter',
    ok: true,
  },
  {
    atMs: Date.now() - 9 * MIN,
    tool: 'start_agent',
    project: PROJECTS[0],
    detail: 'Fix the broken contact form on /contact',
    ok: true,
  },
  { atMs: Date.now() - 10 * MIN, tool: 'connected', project: null, detail: 'grok', ok: true },
  {
    atMs: Date.now() - 50 * MIN,
    tool: 'confirm_push',
    project: PROJECTS[2],
    detail: 'push confirmed with PIN — refused: That PIN is wrong.',
    ok: false,
  },
];

const remote = (
  id: string,
  title: string,
  looksRightWhen: string,
  status: Record<string, unknown>,
  storage: Record<string, string> = {},
  extra: Record<string, unknown> = {}
): Scenario => ({
  id,
  title,
  looksRightWhen,
  command: 'modal.remoteAccess',
  requires: '.remote-access-modal',
  clipSelector: '.remote-access-modal',
  storage,
  commands: {
    get_dashboard_projects: dashboardProjects,
    get_remote_access_status: remoteStatus(status),
    get_remote_audit: [],
    ...extra,
  },
});

export const remoteScenarios: Scenario[] = [
  remote(
    'remote-setup-1-stay-on',
    'Remote access setup — step 1, the computer has to stay on',
    'All five steps are visible; only step 1 is open. It says plainly that nothing can wake the ' +
      'computer from a phone, lists battery, sleep, lid and restart as warnings with the lid and ' +
      'restart fixes inline, and asks for "Got it — set it up" before anything technical.',
    {}
  ),
  remote(
    'remote-setup-2-approve',
    'Remote access setup — step 2, Tailscale wants its one-time approval',
    'Step 1 is collapsed with a check and "2 things to fix…". Step 2 explains Funnel in one ' +
      'sentence and offers "Allow in Tailscale" and "I’ve allowed it". No link yet.',
    {
      ...ON,
      linkMasked: null,
      funnelOn: false,
      funnelApprovalUrl: 'https://login.tailscale.com/f/funnel?node=nabc123',
    },
    choices({ understood: true })
  ),
  remote(
    'remote-setup-3-projects',
    'Remote access setup — step 3, choose projects',
    'Step 2 shows the machine name as its summary. Step 3 lists the projects with one ticked, ' +
      'and Continue is enabled.',
    { ...ON, projects: [PROJECTS[0]] },
    choices({ understood: true })
  ),
  remote(
    'remote-setup-4-pushing',
    'Remote access setup — step 4, pushing is opt-in with a PIN',
    'Explains that the assistant never sees the PIN, two masked PIN fields, "Allow pushing", and a ' +
      'clear "Skip — I’ll push from the computer".',
    { ...ON, projects: [PROJECTS[0]] },
    choices({ understood: true, projectsConfirmed: true })
  ),
  remote(
    'remote-setup-5-connect',
    'Remote access setup — step 5, waiting for an assistant to connect',
    'The masked link with Copy link, three short instructions naming several assistants, and "Waiting for your assistant to ' +
      'connect…". Every earlier step is checked off with a summary.',
    { ...ON, projects: [PROJECTS[0]], pushPin: 'set' },
    choices({ understood: true, projectsConfirmed: true })
  ),
  remote(
    'remote-setup-5-publishing',
    'Remote access setup — step 5, Funnel on but public DNS not published yet',
    'The link is shown and copyable, with a spinner explaining Tailscale is still publishing ' +
      'the address (up to ten minutes the first time). No "Waiting for your assistant" and nothing ' +
      'green — the internet can’t reach it yet. This is the state a real first run hit.',
    { ...ON, projects: [PROJECTS[0]], pushPin: 'set', reachability: { state: 'noPublicDns' } },
    choices({ understood: true, projectsConfirmed: true })
  ),
  remote(
    'remote-setup-5-retried',
    'Remote access setup — still publishing, Ship Studio already asked Tailscale again',
    'The green "Remote access is on" bar with Turn off sits above the steps. Step 5 says it took ' +
      'longer than usual and that Ship Studio asked Tailscale again, with the minutes so far and ' +
      'an "Ask Tailscale again" button. This is the real first-run failure, now self-healing.',
    {
      ...ON,
      projects: [PROJECTS[0]],
      pushPin: 'set',
      reachability: { state: 'noPublicDns' },
      publish: { sinceMs: Date.now() - 3 * MIN, autoRetried: true, gaveUp: false },
    },
    choices({ understood: true, projectsConfirmed: true })
  ),
  remote(
    'remote-live',
    'Remote access — live, an assistant connected',
    'Green "Live" hero naming the client and the machine, with Turn off. "Before you leave" ' +
      'shows one warning (lid). Projects, pushing (on, with PIN), the masked link with Replace ' +
      'link…, and recent activity reading as sentences, with the refused push in amber.',
    {
      ...ON,
      projects: [PROJECTS[0], PROJECTS[2]],
      pushPin: 'set',
      everConnected: true,
      openAtLogin: true,
      activity: { lastRequestMs: Date.now() - 2 * MIN, lastClient: 'grok', rejectedRequests: 0 },
    },
    {},
    { get_remote_audit: audit }
  ),
  remote(
    'remote-live-locked',
    'Remote access — pushing locked after wrong PINs, link down',
    'Amber "Not reachable" hero with the reason, the connection panel inline, and pushing ' +
      'shown as a locked alert that suggests replacing the link. "3 refused" beside activity.',
    {
      ...ON,
      linkMasked: null,
      funnelOn: false,
      funnelError: 'Tailscale didn’t answer within 20 seconds.',
      projects: [PROJECTS[0]],
      pushPin: 'locked',
      everConnected: true,
      lidClosedMode: true,
      openAtLogin: true,
      activity: { lastRequestMs: Date.now() - 40 * MIN, lastClient: 'grok', rejectedRequests: 3 },
    },
    {},
    { get_remote_audit: audit }
  ),
  {
    id: 'remote-indicator-off',
    title: 'Sidebar — remote access never set up',
    looksRightWhen:
      'At the foot of the sidebar, a hollow grey dot and "Remote access off", quieter than ' +
      'everything around it. Clicking it opens Remote access setup.',
    clipSelector: '.workspace-sidebar-footer',
    requires: '[data-testid="remote-indicator"]',
    commands: {},
  },
  {
    id: 'remote-indicator-battery',
    title: 'Sidebar — remote access on, running on battery',
    looksRightWhen:
      'At the foot of the sidebar, an amber dot and "Remote on · battery 37%". Clicking it opens ' +
      'Remote access.',
    clipSelector: '.workspace-sidebar-footer',
    requires: '[data-testid="remote-indicator"]',
    commands: {
      get_remote_access_brief: remoteBrief({
        enabled: true,
        serverRunning: true,
        keepAwake: true,
        power: { hasBattery: true, onAc: false, batteryPercent: 37, charging: false },
      }),
    },
  },
];
