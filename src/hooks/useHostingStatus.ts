/**
 * Keeps the hosting section's answer current, without burning requests.
 *
 * Three rules shape the cadence:
 *
 * 1. **Only poll what someone is looking at.** The section it replaces ran a
 *    `vercel ls` every 15s and two `git` spawns every 3s for every open
 *    project, forever, whether or not the popover was open or the window even
 *    focused. This does one warm-up lookup for the active project while the
 *    menu is closed, then polls only while it is open and the window is visible
 *    and focused.
 * 2. **Match the cadence to the state.** A build in flight is worth a few
 *    seconds; a finished deployment does not change.
 * 3. **Back off on failure rather than hammering.** Transport errors are thrown
 *    so `usePolling`'s exponential backoff engages; auth and no-link states are
 *    returned as data and simply stop the poll, because nothing will change
 *    until the user acts.
 *
 * @module hooks/useHostingStatus
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from './usePolling';
import { getHostingStatus, deriveSectionState, isActive, shouldPoll } from '../lib/hosting';
import type { HostingStatus, SectionState } from '../lib/hosting';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';

/** While something is moving. */
const ACTIVE_INTERVAL_MS = 4000;
/** Once it has settled, but the popover is still open. */
const SETTLED_INTERVAL_MS = 30000;

interface Options {
  projectPath: string;
  /** Only true while the popover is actually on screen. */
  open: boolean;
  /** When the user's push completed, so "not found" can be given a grace period. */
  pushedAt?: number;
  /** Pin this query to the exact commit accepted by a Git push. */
  commitSha?: string;
  branch?: string;
}

interface Result {
  status: HostingStatus | null;
  state: SectionState;
  /** Force an immediate refetch — the Retry action. */
  refresh: () => void;
}

/** True when the window is both visible and focused. */
function useWindowActive(): boolean {
  const [active, setActive] = useState(() => typeof document === 'undefined' || !document.hidden);

  useEffect(() => {
    const update = () => setActive(!document.hidden && document.hasFocus());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return active;
}

export function useHostingStatus({
  projectPath,
  open,
  pushedAt,
  commitSha,
  branch,
}: Options): Result {
  const queryKey = `${projectPath}\u0000${commitSha ?? ''}\u0000${branch ?? ''}`;
  // The answer is stored with the project it describes. Clearing it in an
  // effect on `projectPath` would leave one render showing the previous
  // project's deployment under the new project's name.
  const [entry, setEntry] = useState<{ key: string; status: HostingStatus } | null>(null);
  const status = entry?.key === queryKey ? entry.status : null;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const preloadKeyRef = useRef<string | null>(null);
  const inFlightRef = useRef<{ key: string; promise: Promise<HostingStatus> } | null>(null);
  const requestVersionRef = useRef(0);

  /**
   * Why the command rejected, when it has never succeeded for this project.
   *
   * `get_hosting_status` does not only fail transiently: it rejects outright
   * for a folder that isn't a git repo, a repo with no commits yet, and a
   * detached HEAD — all of which a user reaches normally, the last one by
   * restoring a snapshot. Without this the status stayed `null`, the reducer
   * kept answering `checking`, and the row showed a spinner forever, retrying
   * a call that was never going to succeed.
   *
   * Stored with its project for the same reason the status is: one project's
   * failure must not caption another's row.
   */
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const error = failure?.key === queryKey ? failure.message : undefined;

  const windowActive = useWindowActive();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchOnce = useCallback(
    async (force = false) => {
      const inFlight = inFlightRef.current;
      if (!force && inFlight?.key === queryKey) return inFlight.promise;
      const requestVersion = ++requestVersionRef.current;

      const request = (async (): Promise<HostingStatus> => {
        let next: HostingStatus;
        try {
          next = await getHostingStatus(projectPath, commitSha, branch);
        } catch (err) {
          // Recorded before rethrowing, so the poller still backs off (a rejection
          // can be transient) while the row stops claiming to be loading.
          if (
            mounted.current &&
            queryKeyRef.current === queryKey &&
            requestVersionRef.current === requestVersion
          ) {
            setFailure({ key: queryKey, message: formatCommandError(asCommandError(err)) });
          }
          throw err;
        }

        // Defensive: a malformed or absent payload must back the poller off, not
        // throw a TypeError out of a render-adjacent callback. The command always
        // returns a status or rejects, so reaching here means something upstream
        // is wrong and retrying at full rate would not help.
        if (!next || !Array.isArray(next.providers)) {
          throw new Error('hosting status came back in an unexpected shape');
        }

        if (
          !mounted.current ||
          queryKeyRef.current !== queryKey ||
          requestVersionRef.current !== requestVersion
        )
          return next;
        setEntry({ key: queryKey, status: next });
        setFailure(null);

        // A transport failure is reported inside the payload rather than thrown,
        // so re-throw it here to engage the poller's backoff instead of retrying
        // an unreachable provider at full rate.
        const failing = next.providers.find((p) => p.transport_error);
        if (failing) {
          throw new Error(failing.transport_error ?? 'hosting provider unreachable');
        }
        return next;
      })();
      inFlightRef.current = { key: queryKey, promise: request };
      try {
        return await request;
      } finally {
        if (inFlightRef.current?.promise === request) inFlightRef.current = null;
      }
    },
    [projectPath, commitSha, branch, queryKey]
  );

  // The dropdown stays mounted while closed so the current project's provider
  // lookup can warm in the background. This is one request per project/ref or
  // push event while closed; recurring polling remains limited to an open,
  // visible window. A changed pushedAt intentionally retries even when Git
  // reports the same SHA, since the provider may have just started its build.
  useEffect(() => {
    if (!projectPath || open) return;
    const preloadKey = `${queryKey}\u0000${pushedAt ?? ''}`;
    if (preloadKeyRef.current === preloadKey) return;
    preloadKeyRef.current = preloadKey;
    void fetchOnce().catch((err) => {
      logger.debug('hosting: background preload failed', { error: String(err) });
    });
  }, [projectPath, queryKey, pushedAt, open, fetchOnce]);

  // Measured against the settled cadence, not the active one: a finished
  // deployment is polled every 30s by design, so judging it against the 4s
  // build interval marked it stale between every ordinary tick.
  const state = deriveSectionState(status, {
    pushedAt,
    stalenessMs: SETTLED_INTERVAL_MS * 2,
    error,
  });

  const enabled = open && windowActive && Boolean(projectPath) && shouldPoll(state.kind);
  const intervalMs = isActive(state.kind) ? ACTIVE_INTERVAL_MS : SETTLED_INTERVAL_MS;

  // No separate "fetch on open" effect: the poller fires its first tick
  // immediately on start, and `enabled` flipping true starts it. Opening the
  // popover therefore fetches at once rather than after a full interval.
  // Include target identity so a changed pushed SHA restarts the poller and
  // performs one immediate query, even if the previous result had settled.
  usePolling(fetchOnce, { intervalMs, enabled, name: `hosting-status:${queryKey}` });

  const refresh = useCallback(() => {
    void fetchOnce(true).catch((err) => {
      logger.debug('hosting: manual refresh failed', { error: String(err) });
    });
  }, [fetchOnce]);

  return { status, state, refresh };
}
