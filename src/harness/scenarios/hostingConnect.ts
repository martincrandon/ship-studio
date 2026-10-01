/**
 * The hosting **connect** flow — the token modal and the link picker.
 *
 * Why this file exists: the hosting *status* row had ten scenarios and a unit
 * test the day it landed, and the two screens a user must get through before
 * any of that can happen had neither. Nobody had looked at them. They are the
 * first hosting UI a new user touches and the only ones that write anything.
 *
 * What is different about these scenarios: they are not a single fixture and a
 * screenshot. The modal opens from a button *inside* the push popover, and its
 * interesting states only exist after typing or clicking again — so each one
 * declares `steps` (see `../types`) and the runner fails the capture if a step
 * never found its control.
 *
 * ## Fixtures shaped so the defect can appear
 *
 * A fixture that cannot show the bug certifies it. Each of these is shaped
 * against a specific known defect, so the capture would look different if the
 * defect were fixed — or if it got worse:
 *
 * - **Nothing verifies a pasted token** (`verify_hosting_token` is a registered
 *   command with no callers). `hosting-connect-token-saved-but-rejected` pastes
 *   a token into the *rejected* state and lets the save succeed: the modal
 *   closes on a token that was never checked, and the row behind it still says
 *   the connection is broken. That is the whole complaint, in one image.
 * - **An empty project list is presented as a fact about the account.** The two
 *   `-empty-` scenarios are the exact shape a permissions problem (Cloudflare
 *   without `Account Settings:Read`) and a scoping problem (Vercel projects
 *   owned by a team, which `list_projects` never asks for) arrive in. If that
 *   copy ever goes back to asserting the account is empty, these captures show
 *   it.
 * - **The picker renders `choice.name` and nothing else.** Cloudflare's adapter
 *   walks every account the token can see, so two accounts owning a project of
 *   the same name is reachable, not hypothetical — and the list then offers two
 *   identical rows. `hosting-connect-picker-projects` contains that pair on
 *   purpose; a picker that distinguishes them would look different.
 *
 * ## Fixture truthfulness
 *
 * `HostingProjectChoice` skips `scope_id` / `scope_name` when they are `None`,
 * and Vercel's `list_projects` only sets them when it was given a scope — which
 * the picker never does. So the Vercel fixtures here omit both fields, exactly
 * as the wire does, and only the Cloudflare fixtures carry them.
 */

import type { CommandMap, Scenario } from '../types';
import { rejectsWith, neverAnswers } from '../reject';
import { unlinkedHostingStatus } from './base';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

/** The push popover, then the hosting row's only button. */
const OPEN_POPOVER = '.source-control-push-button';
const ROW_ACTION = '.hosting-row-action button';
const TOKEN_INPUT = '.connect-modal-field input';
/** The modal's primary is its last action button; the first is Cancel. */
const SAVE_BUTTON = '.connect-modal-actions button:last-of-type';

/** Shared scaffolding: open the workspace, open the popover, open the modal. */
const connectFlow = {
  project: WORKSPACE_PROJECT,
  openSelector: OPEN_POPOVER,
  clipSelector: '.connect-modal',
  requires: '.connect-modal',
} as const;

/**
 * One provider row in a given auth state, with no deployment lookup.
 *
 * Both connect entry points are auth states, so nothing here needs a
 * deployment: `no_token` and `rejected` short-circuit the reducer before any
 * lookup is read.
 */
const authState = (
  auth: 'no_token' | 'rejected',
  provider: 'vercel' | 'cloudflare' | 'netlify'
) => ({
  commit: unlinkedHostingStatus.commit,
  providers: [
    {
      link: {
        provider,
        project_id: provider === 'cloudflare' ? 'acme-marketing' : 'prj_harness0000000000000000000',
        ...(provider === 'cloudflare' ? { scope_id: 'acct_harness00000000000000000' } : {}),
        project_name: 'acme-marketing',
        source: provider === 'vercel' ? 'vercel_cli_file' : 'user_picked',
        linked_at: 1_757_000_000_000,
      },
      auth: { kind: auth },
      token_source: 'keychain',
      lookup: null,
      fetched_at: Date.now(),
      from_cache: false,
    },
  ],
  detected: [],
});

/** Commands every connect scenario needs beyond the workspace defaults. */
const connectCommands: CommandMap = {
  ...workspaceCommands,
  // The keychain write the modal makes. `null` is what the real command
  // returns on success.
  set_account_credential: null,
  set_hosting_link: null,
};

/** A Vercel choice, in the shape the adapter actually serialises. */
const vercelChoice = (id: string, name: string) => ({ id, name });

export const hostingConnectScenarios: Scenario[] = [
  // -------------------------------------------------------------------------
  // The token modal
  // -------------------------------------------------------------------------
  {
    id: 'hosting-connect-token',
    title: 'Connect a host — the token modal, untouched',
    looksRightWhen:
      'Says what the token is for and where to make one, the field is masked, and Save is disabled until something is typed. Nothing here should imply the token will be checked — it is not.',
    ...connectFlow,
    steps: [{ click: ROW_ACTION }],
    commands: { ...connectCommands, get_hosting_status: authState('no_token', 'vercel') },
  },
  {
    id: 'hosting-connect-token-cloudflare',
    title: 'Connect a host — Cloudflare, with its permission requirement',
    looksRightWhen:
      'The Cloudflare-only line naming Pages:Read and Account Settings:Read is visible and readable. It is the only warning a user gets before an under-permissioned token silently produces an empty project list.',
    ...connectFlow,
    steps: [{ click: ROW_ACTION }],
    commands: { ...connectCommands, get_hosting_status: authState('no_token', 'cloudflare') },
  },
  {
    id: 'hosting-connect-token-typed',
    title: 'Connect a host — a token pasted in',
    looksRightWhen:
      'The value is masked (this is a credential), and Save has become enabled. Save is enabled purely because the field is non-empty — no format, length or account check stands between here and the keychain.',
    ...connectFlow,
    steps: [
      { click: ROW_ACTION },
      { fill: TOKEN_INPUT, value: 'vercel_9WQ2harnessTOKEN0000000000' },
    ],
    commands: { ...connectCommands, get_hosting_status: authState('no_token', 'vercel') },
  },
  {
    id: 'hosting-connect-token-saving',
    title: 'Connect a host — save in flight',
    looksRightWhen:
      'Says "Saving…" and cannot be pressed twice. This is the whole of the wait: it covers a keychain write only, because nothing asks the provider whether the token works.',
    ...connectFlow,
    steps: [
      { click: ROW_ACTION },
      { fill: TOKEN_INPUT, value: 'vercel_9WQ2harnessTOKEN0000000000' },
      { click: SAVE_BUTTON },
    ],
    commands: {
      ...connectCommands,
      get_hosting_status: authState('no_token', 'vercel'),
      set_account_credential: neverAnswers(),
    },
  },
  {
    id: 'hosting-connect-token-save-failed',
    title: 'Connect a host — the keychain refused the write',
    looksRightWhen:
      'The failure is visible as a toast, the modal stays open with the typed token intact, and Save is pressable again. Not clipped to the modal on purpose: the only report of this failure renders outside it, and clipping would photograph a dialog that looks perfectly healthy.',
    project: WORKSPACE_PROJECT,
    openSelector: OPEN_POPOVER,
    requires: '.toast-error',
    steps: [
      { click: ROW_ACTION },
      { fill: TOKEN_INPUT, value: 'vercel_9WQ2harnessTOKEN0000000000' },
      { click: SAVE_BUTTON },
    ],
    commands: {
      ...connectCommands,
      get_hosting_status: authState('no_token', 'vercel'),
      set_account_credential: rejectsWith(
        'The keychain refused to store this item (errSecAuthFailed)'
      ),
    },
  },
  {
    id: 'hosting-connect-token-rejected',
    title: 'Connect a host — reconnecting after the provider refused the old one',
    looksRightWhen:
      'The copy admits the previous sign-in was refused rather than reading like a first-time setup. This is the state users arrive in from the "the saved token was rejected" row.',
    ...connectFlow,
    steps: [{ click: ROW_ACTION }],
    commands: { ...connectCommands, get_hosting_status: authState('rejected', 'vercel') },
  },
  {
    id: 'hosting-connect-token-saved-but-rejected',
    title: 'Connect a host — a wrong token is accepted without a word',
    looksRightWhen:
      'The end of the flow, not the modal: the token was saved, the dialog closed as if that worked, and the row underneath still says the connection is broken. Nothing between typing and here checks the token, so the only feedback a user gets for a wrong or under-permissioned token is the unchanged row behind the dialog they just dismissed.',
    project: WORKSPACE_PROJECT,
    openSelector: OPEN_POPOVER,
    clipSelector: '.publish-dropdown-menu',
    // Asserts the *outcome*, not the surface: the modal is gone and the row
    // is still in the rejected state it started in.
    requires: '.hosting-row[data-state="token_rejected"]',
    steps: [
      { click: ROW_ACTION },
      { fill: TOKEN_INPUT, value: 'vercel_WRONGtoken000000000000000' },
      { click: SAVE_BUTTON },
    ],
    commands: { ...connectCommands, get_hosting_status: authState('rejected', 'vercel') },
  },

  // -------------------------------------------------------------------------
  // The link picker
  // -------------------------------------------------------------------------
  {
    id: 'hosting-connect-picker',
    title: 'Connect hosting — choosing a provider',
    looksRightWhen:
      'Three providers, evenly weighted, with an explanation of what linking buys. Netlify has no brand mark in the icon set yet and shows the neutral circle.',
    ...connectFlow,
    steps: [{ click: ROW_ACTION }],
    commands: { ...connectCommands, get_hosting_status: unlinkedHostingStatus },
  },
  {
    id: 'hosting-connect-picker-detected',
    title: 'Connect hosting — a link the provider CLI already left on disk',
    looksRightWhen:
      "Offers the project the user already linked with the provider's own CLI as one click, names it, and still allows picking something else. No network is needed for this path.",
    ...connectFlow,
    steps: [{ click: ROW_ACTION }],
    commands: {
      ...connectCommands,
      get_hosting_status: {
        ...unlinkedHostingStatus,
        // `.vercel/project.json` on disk, unconfirmed. `scope_id` is present
        // because that file carries `orgId`.
        detected: [
          {
            provider: 'vercel',
            project_id: 'prj_harness0000000000000000000',
            scope_id: 'team_harness000000000000000',
            project_name: 'acme-marketing',
            source: 'vercel_cli_file',
          },
        ],
      },
    },
  },
  {
    id: 'hosting-connect-picker-loading',
    title: "Connect hosting — fetching the account's projects",
    looksRightWhen:
      'A spinner that names the provider it is waiting on, with Back still available. Nothing claims a result yet.',
    ...connectFlow,
    steps: [
      { click: ROW_ACTION },
      // The provider buttons are the first three in the body; Vercel is first.
      { click: '.connect-modal-body > button:first-of-type' },
    ],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      list_hosting_projects: neverAnswers(),
    },
  },
  {
    id: 'hosting-connect-picker-projects',
    title: "Connect hosting — the account's projects (Cloudflare, two accounts)",
    looksRightWhen:
      'A pickable list. Note the two rows both called "acme-docs": Cloudflare\'s adapter walks every account the token can see, and the picker prints only the project name — so two accounts owning the same name are indistinguishable here, and picking the wrong one links this repo to another account\'s project.',
    ...connectFlow,
    steps: [
      { click: ROW_ACTION },
      // Cloudflare is the second provider button.
      { click: '.connect-modal-body > button:nth-of-type(2)' },
      { click: '.connect-modal-provider-choices button:first-of-type' },
    ],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      // Cloudflare's `list_projects` uses the project *name* as the id and
      // carries the account it came from — both fields are real here.
      list_hosting_projects: [
        {
          id: 'acme-marketing',
          name: 'acme-marketing',
          scope_id: 'acct_11harness00000000000000000',
          scope_name: 'Acme Inc',
        },
        {
          id: 'acme-docs',
          name: 'acme-docs',
          scope_id: 'acct_11harness00000000000000000',
          scope_name: 'Acme Inc',
        },
        {
          id: 'acme-docs',
          name: 'acme-docs',
          scope_id: 'acct_22harness00000000000000000',
          scope_name: 'Acme Labs',
        },
      ],
    },
  },
  {
    id: 'hosting-connect-picker-workers',
    title: 'Connect hosting — choose a Cloudflare Worker script',
    looksRightWhen:
      'Workers is a separate request from Pages. The same script name can exist alongside a Pages project without ambiguity, the account is visible, and the row says Workers before the user links it.',
    ...connectFlow,
    steps: [
      { click: ROW_ACTION },
      { click: '.connect-modal-body > button:nth-of-type(2)' },
      { click: '.connect-modal-provider-choices button:nth-of-type(2)' },
    ],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      list_hosting_projects: (args: Record<string, unknown>) =>
        args.cloudflareProduct === 'workers'
          ? [
              {
                id: 'acme-docs',
                name: 'acme-docs',
                scope_id: 'acct_11harness00000000000000000',
                scope_name: 'Acme Inc',
                cloudflare_target: { kind: 'workers', script_tag: 'tag-harness-001' },
              },
            ]
          : [
              {
                id: 'acme-docs',
                name: 'acme-docs',
                scope_id: 'acct_11harness00000000000000000',
                scope_name: 'Acme Inc',
                cloudflare_target: { kind: 'pages' },
              },
            ],
    },
  },
  {
    id: 'hosting-connect-picker-empty-cloudflare',
    title: 'Connect hosting — Cloudflare returned nothing',
    looksRightWhen:
      'Must NOT assert that the account has no projects. An under-permissioned Cloudflare token (no Account Settings:Read) sees no accounts, so it lists no Pages projects — identical on the wire to a genuinely empty account. The copy has to name the likelier cause instead of reporting a fact it cannot know.',
    ...connectFlow,
    steps: [
      { click: ROW_ACTION },
      { click: '.connect-modal-body > button:nth-of-type(2)' },
      { click: '.connect-modal-provider-choices button:first-of-type' },
    ],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      list_hosting_projects: [],
    },
  },
  {
    id: 'hosting-connect-picker-empty-vercel',
    title: 'Connect hosting — Vercel returned nothing',
    looksRightWhen:
      'Same shape, different cause: `list_projects` asks Vercel without a `teamId`, so a user whose projects all live in a team sees exactly this. The copy must not tell them their account is empty.',
    ...connectFlow,
    steps: [{ click: ROW_ACTION }, { click: '.connect-modal-body > button:first-of-type' }],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      list_hosting_projects: [],
    },
  },
  {
    id: 'hosting-connect-picker-error',
    title: 'Connect hosting — the provider call failed',
    looksRightWhen:
      'The error is reported (as a toast) and the picker falls back to the provider choice rather than showing an empty list, which would read as "you have no projects". Unclipped for the same reason as the failed save: the report renders outside the dialog.',
    project: WORKSPACE_PROJECT,
    openSelector: OPEN_POPOVER,
    requires: '.toast-error',
    steps: [{ click: ROW_ACTION }, { click: '.connect-modal-body > button:first-of-type' }],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      list_hosting_projects: rejectsWith('Vercel is temporarily unavailable (503)'),
    },
  },
  {
    id: 'hosting-connect-picker-long',
    title: 'Connect hosting — an account with many projects',
    looksRightWhen:
      'The list scrolls inside the dialog instead of growing it past the viewport, and Back stays reachable at the bottom. Thirty-two projects: real accounts reach this easily, and the adapter stops asking at 100 whatever the account holds.',
    ...connectFlow,
    steps: [{ click: ROW_ACTION }, { click: '.connect-modal-body > button:first-of-type' }],
    commands: {
      ...connectCommands,
      get_hosting_status: unlinkedHostingStatus,
      list_hosting_projects: [
        vercelChoice('prj_h00', 'acme-marketing'),
        vercelChoice('prj_h01', 'acme-docs'),
        vercelChoice('prj_h02', 'acme-blog'),
        vercelChoice('prj_h03', 'acme-status'),
        vercelChoice('prj_h04', 'acme-careers'),
        vercelChoice('prj_h05', 'acme-changelog'),
        vercelChoice('prj_h06', 'acme-pricing-experiment'),
        vercelChoice('prj_h07', 'acme-checkout'),
        vercelChoice('prj_h08', 'acme-dashboard'),
        vercelChoice('prj_h09', 'acme-admin'),
        vercelChoice('prj_h10', 'acme-support'),
        vercelChoice('prj_h11', 'acme-partners'),
        vercelChoice('prj_h12', 'acme-events'),
        vercelChoice('prj_h13', 'acme-webinars'),
        vercelChoice('prj_h14', 'acme-legal'),
        vercelChoice('prj_h15', 'acme-brand'),
        vercelChoice('prj_h16', 'acme-design-system'),
        vercelChoice('prj_h17', 'acme-storybook'),
        vercelChoice('prj_h18', 'acme-api-reference'),
        vercelChoice('prj_h19', 'acme-developers'),
        vercelChoice('prj_h20', 'acme-integrations'),
        vercelChoice('prj_h21', 'acme-marketplace'),
        vercelChoice('prj_h22', 'acme-community'),
        vercelChoice('prj_h23', 'acme-newsletter'),
        vercelChoice('prj_h24', 'acme-jobs-board'),
        vercelChoice('prj_h25', 'acme-investors'),
        vercelChoice('prj_h26', 'acme-press'),
        vercelChoice('prj_h27', 'acme-security'),
        vercelChoice('prj_h28', 'acme-trust-centre'),
        vercelChoice('prj_h29', 'acme-onboarding'),
        vercelChoice('prj_h30', 'acme-referrals'),
        vercelChoice('prj_h31', 'acme-labs'),
      ],
    },
  },
  {
    id: 'hosting-deployment-environment-unknown',
    title: 'Deployments — unknown environment remains explicit',
    looksRightWhen:
      'The successful Worker build is labelled Environment unknown rather than Preview or Production. Without serving proof or a preview URL, no site address is offered.',
    project: WORKSPACE_PROJECT,
    command: 'hosting.deployments',
    clipSelector: '.deployments-modal',
    requires: '.deployments-modal',
    commands: {
      ...workspaceCommands,
      get_hosting_status: {
        ...unlinkedHostingStatus,
        providers: [
          {
            link: {
              provider: 'cloudflare',
              project_id: 'acme-docs',
              scope_id: 'acct_11harness00000000000000000',
              project_name: 'acme-docs',
              cloudflare_target: { kind: 'workers', script_tag: 'tag-harness-001' },
              source: 'user_picked',
              linked_at: 1_757_000_000_000,
            },
            auth: { kind: 'ok' },
            token_source: 'keychain',
            fetched_at: Date.now(),
            from_cache: false,
          },
        ],
      },
      list_recent_deployments: [
        {
          id: 'worker-build-harness-001',
          status_label: 'Success',
          phase: { phase: 'unknown', raw: 'build succeeded; deployment unconfirmed' },
          detail: { detail: 'deployment_unconfirmed' },
          environment: 'unknown',
          branch: 'main',
          commit_sha: unlinkedHostingStatus.commit.sha,
          commit_message: 'Worker build',
          urls: { aliases: [] },
          created_at: Date.now() - 45_000,
        },
      ],
      get_deployment_log: {
        deployment_id: 'worker-build-harness-001',
        lines: [],
        truncated: false,
      },
    },
  },
];
