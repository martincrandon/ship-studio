/**
 * The addresses a deployment produced, named the way the provider names them.
 *
 * Vercel's own vocabulary: a project has a **production domain**, and each
 * deployment gets its own **deployment URL** ("Each time you deploy, Vercel
 * generates a unique URL"). "Site" and "Build" were words this app invented,
 * and neither told you which one had your change on it.
 *
 * What is shown depends on where the deployment went, because that is what
 * decides which address is worth clicking:
 *
 * - A **production** deploy that is actually serving shows the production
 *   domain first — your change is live there — with the commit permalink under
 *   it for pinning this exact version.
 * - A production deploy that is *not* serving (failed, canceled, skipped, still
 *   building, or built-but-not-promoted) shows only its own permalink. The
 *   domain is still a real address, but what it serves is the previous
 *   deployment, so listing it under a failed build reads as "it shipped".
 * - A **preview** deploy shows only its own URL. The production domain does
 *   *not* contain this change, so offering it invites clicking the wrong one.
 *
 * There is deliberately no branch URL. Vercel documents the shape of one
 * (`<project>-git-<branch>-<scope>.vercel.app`) but does not return it on the
 * deployment, and the same docs note it is truncated past 63 characters and
 * mangled by anti-phishing rules — which is exactly why the previous
 * implementation's assembled preview links 404'd.
 */

import { MiddleTruncate } from '../primitives/MiddleTruncate';
import { ExternalLinkIcon } from '@/components/icons';
import type { Deployment } from '../../lib/hosting';

interface Row {
  label: string;
  url: string;
  /** Read out to screen readers, where the visual label isn't enough. */
  description: string;
}

/**
 * Whether this deployment is the one currently answering on the production
 * domain.
 *
 * The domain is a property of the *project*: the adapters read it from a
 * separate endpoint (Vercel's `/projects/{id}/domains`, Netlify's site record)
 * and attach it to whatever deployment the lookup returned, whatever state
 * that deployment is in. So a build that failed, was canceled, was skipped, or
 * is still running came back carrying the production domain — and this
 * component offered it under "Domain", directly beneath the word "Error".
 *
 * The domain itself is real. What was invented is the claim that *this* build
 * is what you get when you visit it. It isn't: a failed deploy leaves the
 * previous one serving, so clicking through showed a working site and read as
 * confirmation that the deploy had worked.
 *
 * `not_yet_promoted` is Vercel's own word for "built, but not serving traffic
 * yet", so it is excluded for exactly the same reason even though the build
 * succeeded.
 */
function isServingProduction(deployment: Deployment): boolean {
  if (deployment.phase.phase !== 'ready') return false;
  return deployment.detail?.detail !== 'not_yet_promoted';
}

export function rowsFor(deployment?: Deployment): Row[] {
  if (!deployment) return [];

  // Only a confirmed production deployment can be shown with the site's
  // domain. Preview and unknown environments may point at somebody else's
  // change, so offer only the immutable address for that build.
  if (deployment.environment !== 'production') {
    return deployment.urls.deployment
      ? [
          {
            label: 'Deployment',
            url: deployment.urls.deployment,
            description:
              deployment.environment === 'preview'
                ? 'Open this preview deployment'
                : 'Open this deployment',
          },
        ]
      : [];
  }

  const rows: Row[] = [];

  if (deployment.urls.site && isServingProduction(deployment)) {
    rows.push({
      label: 'Domain',
      url: deployment.urls.site,
      description: 'Open the production domain',
    });
  }

  // Only worth its own row when it isn't the address already listed above — a
  // project with no custom domain can have these coincide. Compared against
  // what was actually rendered, not against `urls.site`: when the domain row
  // was withheld there is nothing to duplicate, and suppressing this one too
  // would leave a deployment with no address at all.
  const domainShown = rows[0]?.url;
  if (deployment.urls.deployment && deployment.urls.deployment !== domainShown) {
    rows.push({
      label: 'Deployment',
      url: deployment.urls.deployment,
      description: 'Open this deployment',
    });
  }

  return rows;
}

/** Strip the scheme for display. The value opened is still the full URL. */
function displayHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

interface Props {
  deployment?: Deployment;
  notDeployed?: boolean;
  onOpen: (url: string) => void;
}

export function HostingUrls({ deployment, notDeployed = false, onOpen }: Props) {
  const rows = rowsFor(deployment);
  if (!deployment && notDeployed) {
    return (
      <div className="hosting-urls">
        {['Domain', 'Deployment'].map((label) => (
          <div className="hosting-url hosting-url--placeholder" key={label}>
            <span className="hosting-url-label">{label}</span>
            <span className="hosting-url-value">Not deployed yet</span>
          </div>
        ))}
      </div>
    );
  }
  if (rows.length === 0) return null;

  return (
    <div className="hosting-urls">
      {rows.map((row) => (
        /* The whole row is the control. An address that looks like a link
           should open when you click it, rather than sending you hunting for
           a small icon at the end of the line. */
        <button
          type="button"
          className="hosting-url"
          key={row.label}
          onClick={() => onOpen(row.url)}
          aria-label={`${row.description} — ${displayHost(row.url)}`}
        >
          <span className="hosting-url-label">{row.label}</span>
          {/* Middle-truncated, not end-truncated: a build permalink's tail
              carries the domain, so cutting the end leaves an address you
              can't identify at all. */}
          <MiddleTruncate className="hosting-url-value" text={displayHost(row.url)} />
          {/* Decorative: the row itself is the button, so this must not be a
              second tab stop announcing the same action twice. */}
          <span className="hosting-url-open" aria-hidden="true">
            <ExternalLinkIcon size={12} />
          </span>
        </button>
      ))}
    </div>
  );
}
