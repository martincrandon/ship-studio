/**
 * The "Hosting" block inside the Push popover.
 *
 * Replaces a slot that rendered an external plugin's hover menu, which the host
 * then reshaped with CSS written against that plugin's own class names and held
 * open with a synthetic `mouseover` dispatched from a MutationObserver. All of
 * that is gone: this owns its markup, so it can own its geometry.
 *
 * @see lib/hosting for the state reducer, lib/hostingCopy for every string.
 */

import { useCallback, useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useHostingStatus } from '../../hooks/useHostingStatus';
import { useOptionalToast } from '../../contexts/ToastContext';
import { HostingRow, HostingLinks } from './HostingRow';
import { HostingUrls } from './HostingUrls';
import { HostingTokenModal } from './HostingTokenModal';
import { HostingLinkPicker } from './HostingLinkPicker';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ExternalLinkIcon, GlobeIcon } from '@/components/icons';
import { copyFor } from '../../lib/hostingCopy';
import { logger } from '../../lib/logger';
import {
  ACCOUNT_CREDENTIALS_CHANGED_EVENT,
  getProjectAccountId,
  notifyAccountCredentialsChanged,
  DEFAULT_ACCOUNT_ID,
} from '../../lib/accounts';
import type { AccountCredentialsChangedDetail } from '../../lib/accounts';
import { PROVIDER_LABELS, type CloudflareProduct, type HostingProvider } from '../../lib/hosting';

interface Props {
  projectPath: string;
  /** True only while the popover is on screen, so nothing polls in the dark. */
  open: boolean;
  /** When the push completed, if it happened in this session. */
  pushedAt?: number;
  /** The accepted push commit and branch, so the monitor cannot drift to a newer push. */
  pushedCommitSha?: string;
  pushedBranch?: string;
}

export function HostingSection({
  projectPath,
  open,
  pushedAt,
  pushedCommitSha,
  pushedBranch,
}: Props) {
  const { status, state, refresh } = useHostingStatus({
    projectPath,
    open,
    pushedAt,
    commitSha: pushedCommitSha,
    branch: pushedBranch,
  });
  const { showToast } = useOptionalToast();

  const [connecting, setConnecting] = useState<{
    provider: HostingProvider;
    cloudflareProduct?: CloudflareProduct;
  } | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * Which workspace's keychain the token belongs to — the project's, matching
   * how git push authenticates, not whichever workspace happens to be active.
   *
   * `null` means "not resolved yet", and it is deliberately not the same value
   * as `DEFAULT_ACCOUNT_ID`. Starting at Default meant that between mounting
   * and the lookup returning — and, worse, across a `projectPath` change, when
   * the *previous* project's id was still in state — a `no_token` row could
   * open the connect modal against an account this project does not belong to,
   * saving the credential into the wrong workspace's keychain and notifying
   * the wrong workspace's terminals. Default is the answer for a project that
   * has no tag, not the answer for a project we have not asked about.
   */
  const [account, setAccount] = useState<{ path: string; id: string } | null>(null);

  /**
   * Derived, not reset. Storing the path the answer belongs to means a stale
   * id cannot outlive its project: the moment `projectPath` changes this is
   * `null` again, with no effect needing to remember to clear it. Same shape
   * as the log cache in `DeploymentsModal`, and it keeps the effect free of a
   * synchronous `setState` that `react-hooks/set-state-in-effect` would
   * rightly reject.
   */
  const accountId = account?.path === projectPath ? account.id : null;

  useEffect(() => {
    if (!accountId) return;
    const handleCredentialsChanged = (event: Event) => {
      const changedAccountId = (event as CustomEvent<AccountCredentialsChangedDetail>).detail
        ?.accountId;
      if (changedAccountId === accountId) refresh();
    };
    window.addEventListener(ACCOUNT_CREDENTIALS_CHANGED_EVENT, handleCredentialsChanged);
    return () =>
      window.removeEventListener(ACCOUNT_CREDENTIALS_CHANGED_EVENT, handleCredentialsChanged);
  }, [accountId, refresh]);

  useEffect(() => {
    let cancelled = false;
    void getProjectAccountId(projectPath)
      .then((id) => {
        if (!cancelled) setAccount({ path: projectPath, id });
      })
      .catch(() => {
        // An untagged project genuinely lives in Default. A failed lookup is
        // the one case where that is an answer rather than a guess.
        if (!cancelled) setAccount({ path: projectPath, id: DEFAULT_ACCOUNT_ID });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const copy = copyFor(state, status?.commit?.subject, status?.commit?.short_sha);
  const linkedProvider =
    state.provider ??
    (status?.providers.length === 1 ? status.providers[0]?.link.provider : undefined);
  const linkedProviderName = linkedProvider ? PROVIDER_LABELS[linkedProvider] : null;
  const dashboardUrl = state.deployment?.dashboard_url;
  const dashboardLabel = state.provider ? `Open in ${PROVIDER_LABELS[state.provider]}` : null;

  const openExternal = useCallback(
    (url?: string | null) => {
      if (!url) return;
      void openUrl(url).catch((err) => {
        logger.warn('hosting: failed to open url', { error: String(err) });
        showToast("Couldn't open that link", 'error');
      });
    },
    [showToast]
  );

  const handleAction = useCallback(() => {
    switch (state.kind) {
      // Every state that has a deployment opens it on the provider. The
      // addresses are already clickable directly above, so the button spends
      // its space on the one thing the row cannot show.
      case 'ready':
      case 'queued':
      case 'building':
      case 'publishing':
      case 'failed':
      case 'canceled':
      case 'skipped':
      case 'gated':
      case 'unknown':
        openExternal(state.deployment?.dashboard_url);
        return;
      case 'no_token':
      case 'token_rejected':
        setConnecting({
          provider: state.provider ?? 'vercel',
          ...(state.provider === 'cloudflare'
            ? {
                cloudflareProduct:
                  status?.providers.find((item) => item.link.provider === state.provider)?.link
                    .cloudflare_target?.kind === 'workers'
                    ? 'workers'
                    : 'pages',
              }
            : {}),
        });
        return;
      case 'offline':
        refresh();
        return;
      default:
        return;
    }
  }, [state, status?.providers, refresh, openExternal]);

  return (
    <>
      <section className="publish-hosting-section" aria-labelledby="publish-hosting-heading">
        <div className="publish-section-heading" id="publish-hosting-heading">
          <GlobeIcon size={14} />
          <span>Hosting</span>
          {linkedProviderName && <strong>{linkedProviderName}</strong>}
        </div>
        {state.kind === 'no_link' ? (
          <div className="publish-hosting-connect-row">
            <span>Connect hosting to track deployments</span>
            <Button variant="default" onClick={() => setPicking(true)}>
              Connect
            </Button>
          </div>
        ) : (
          <HostingRow
            state={state}
            commitSubject={status?.commit?.subject}
            shortSha={status?.commit?.short_sha}
            actionSlot={
              state.deployment ? (
                dashboardUrl && dashboardLabel ? (
                  <IconButton
                    variant="ghost"
                    size="compact"
                    icon={<ExternalLinkIcon size={14} />}
                    aria-label={dashboardLabel}
                    title={dashboardLabel}
                    onClick={() => openExternal(dashboardUrl)}
                  />
                ) : null
              ) : undefined
            }
            onAction={handleAction}
          />
        )}
        <HostingUrls
          deployment={state.deployment}
          notDeployed={state.kind === 'not_pushed'}
          onOpen={openExternal}
        />
        {state.kind !== 'no_link' && <HostingLinks state={state} hint={copy.hint} />}
      </section>

      {/* Gated on a resolved account: a token saved against the wrong
          workspace is worse than a connect button that waits a moment. */}
      {connecting && accountId ? (
        <HostingTokenModal
          provider={connecting.provider}
          cloudflareProduct={connecting.cloudflareProduct}
          accountId={accountId}
          workspaceName="this workspace"
          wasRejected={state.kind === 'token_rejected'}
          onSaved={() => {
            setConnecting(null);
            // Terminals in this workspace get the new token too, so tell them.
            notifyAccountCredentialsChanged(accountId);
          }}
          onClose={() => setConnecting(null)}
        />
      ) : null}

      {picking ? (
        <HostingLinkPicker
          projectPath={projectPath}
          detected={status?.detected ?? []}
          onLinked={() => {
            setPicking(false);
            refresh();
          }}
          onNeedsToken={(provider, cloudflareProduct) => {
            setPicking(false);
            setConnecting({ provider, cloudflareProduct });
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}
