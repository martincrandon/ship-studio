/**
 * One thing a teammate did.
 *
 * The row leads with the sentence, because that is what someone came here to
 * read. "Rebuilt the pricing tiers as a CSS grid" is a thing you can hold in
 * your head; "pushed 3 commits" is not, and a column of those is a git log
 * with faces on it.
 *
 * Under the headline: why it happened, what specifically changed, and what it
 * wants from you. The commits and files are real and they matter, but they are
 * *evidence* — collapsed behind one line, there for when you doubt the claim
 * or want to go look. Leading with them buries the only part most people need.
 *
 * An `app`-written row is drawn deliberately thinner. Ship Studio saw a push
 * and no agent left a summary, so all it can honestly say is that a push
 * happened — and the visible difference between that and the rich rows is the
 * argument for the skill, made in the UI instead of in a doc.
 *
 * @module components/team/TeamUpdateCard
 */

import { useLayoutEffect, useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ChevronIcon,
  ClaudeIcon,
  CodexIcon,
  ErrorIcon,
  EyeIcon,
  FileIcon,
  GenericAgentIcon,
  GitBranchHorizontalIcon,
  GitCommitIcon,
  GitHubIcon,
  GitMergeIcon,
  PullRequestIcon,
} from '@/components/icons';
import { TeamAvatar } from './TeamAvatar';
import { TeamActorName } from './TeamActorName';
import { ExpandableTeamText } from './ExpandableTeamText';
import { Button } from '../primitives/Button';
import { formatAgo } from '../../lib/workflows';
import { fileTotals, TEAM_STATUS_LABEL, type TeamUpdate } from '../../lib/team';

function AgentMark({ name }: { name: string }) {
  if (name.toLowerCase().includes('claude')) return <ClaudeIcon size={12} />;
  if (name.toLowerCase().includes('codex')) return <CodexIcon size={12} />;
  return <GenericAgentIcon size={12} />;
}

interface TeamUpdateCardProps {
  update: TeamUpdate;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  /** Marks the row as arrived since the user last looked. */
  isNew: boolean;
  now: number;
}

export function TeamUpdateCard({
  update,
  expanded,
  onToggleExpanded,
  isNew,
  now,
}: TeamUpdateCardProps) {
  const thin = update.writtenBy === 'app';
  const totals = fileTotals(update.files);
  const githubUrl = update.githubUrl;
  const commitUrl = update.commitUrl;
  const footRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const foot = footRef.current;
    const where = foot?.querySelector<HTMLElement>('.team-update-foot-where');
    const actions = foot?.querySelector<HTMLElement>('.team-update-foot-actions');
    if (!foot || !where || !actions) return;

    let lastRect = foot.getBoundingClientRect();
    const updateWrapMode = () => {
      // Measure the natural flex layout first. The full-width style is applied
      // only after the actions have actually moved to a second line.
      foot.removeAttribute('data-wrapped');

      const whereRect = where.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const whereCenter = whereRect.top + whereRect.height / 2;
      const actionsCenter = actionsRect.top + actionsRect.height / 2;

      if (Math.abs(whereCenter - actionsCenter) > 1) {
        foot.dataset.wrapped = 'true';
      }

      lastRect = foot.getBoundingClientRect();
    };

    updateWrapMode();

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            if (entries.length === 0) return;
            const nextRect = foot.getBoundingClientRect();
            if (
              Math.abs(nextRect.width - lastRect.width) <= 0.5 &&
              Math.abs(nextRect.height - lastRect.height) <= 0.5
            ) {
              return;
            }
            updateWrapMode();
          });

    resizeObserver?.observe(foot);
    resizeObserver?.observe(where);
    resizeObserver?.observe(actions);
    window.addEventListener('resize', updateWrapMode);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateWrapMode);
      foot.removeAttribute('data-wrapped');
    };
  }, [
    githubUrl,
    totals.added,
    totals.removed,
    update.branch,
    update.commits.length,
    update.files.length,
    update.prNumber,
  ]);

  return (
    <article
      className={`team-update${thin ? ' is-thin' : ''}${isNew ? ' is-new' : ''}`}
      data-status={update.status}
    >
      <header className="team-update-head">
        <span className="team-update-figure">
          <TeamAvatar actor={update.actor} size="md" />
        </span>
        <div className="team-update-who">
          <TeamActorName actor={update.actor} className="team-update-name" />
          {commitUrl ? (
            <a
              className="team-update-when team-external-link"
              href={commitUrl}
              target="_blank"
              rel="noreferrer"
              title="Open newest commit in GitHub"
              aria-label={`Open the newest commit for ${update.headline} on GitHub`}
              onClick={(event) => {
                event.preventDefault();
                void openUrl(commitUrl);
              }}
            >
              {formatAgo(update.at, now)}
            </a>
          ) : (
            <span className="team-update-when">{formatAgo(update.at, now)}</span>
          )}
          {isNew && (
            <span
              className="team-update-new-dot"
              role="img"
              aria-label="New since you last looked"
            />
          )}
          {update.writtenBy === 'agent' && update.agentName && (
            <span
              className="team-update-agent"
              title={`Summarised by ${update.agentName}, which did the work`}
              role="img"
              aria-label={`Summarised by ${update.agentName}, which did the work`}
            >
              <AgentMark name={update.agentName} />
            </span>
          )}
        </div>
        <span className="team-status" data-status={update.status}>
          {update.status === 'merged' && <GitMergeIcon size={12} />}
          {TEAM_STATUS_LABEL[update.status]}
        </span>
      </header>

      <h4 className="team-update-headline">{update.headline}</h4>

      {/* The commit body, as written. Paragraph breaks are preserved because
          the author put them there — a body is prose, and collapsing it into
          one block is a different document from the one they wrote. */}
      {update.why && <ExpandableTeamText text={update.why} textClassName="team-update-why" />}

      {update.changes.length > 0 && (
        <ul className="team-update-changes">
          {update.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}

      {/* A row with no written summary behind it. One line saying where to go
          for the rest, and nothing else: it was briefly a sentence naming the
          person and explaining what their push was missing, which read as a
          complaint about a teammate for using a different tool. Half the team
          will always be on a different tool.

          It also used to say "not pushed from Ship Studio", which is a claim
          about *how* someone pushed — and it was wrong for the common case of
          pushing from an agent terminal inside Ship Studio. What this row
          actually knows is narrower: no summary was written, so the commit
          subject is all there is. */}
      {thin && (
        <p className="team-update-source-note">
          <GitHubIcon size={11} />
          <span>No summary was written for this one. The full diff is on GitHub.</span>
        </p>
      )}

      {update.buildError && (
        <p className="team-update-error">
          <ErrorIcon size={11} />
          <code>{update.buildError}</code>
        </p>
      )}

      {/* The one thing on the card addressed to the reader — a request, not a
          status. Drawn as a quoted aside so it reads like a colleague asking
          rather than like something that has gone wrong. */}
      {update.asks && (
        <div className="team-update-ask">
          <span className="team-update-ask-icon" aria-hidden>
            <EyeIcon size={12} />
          </span>
          <span className="team-update-ask-label">
            <TeamActorName actor={update.actor}>{update.actor.name.split(' ')[0]}</TeamActorName>{' '}
            wants a second pair of eyes
          </span>
          <p className="team-update-ask-text">{update.asks}</p>
          {githubUrl && (
            <Button
              className="team-update-ask-action"
              variant="success"
              size="compact"
              leftIcon={<GitHubIcon size={12} />}
              onClick={() => void openUrl(githubUrl)}
              title="Open these changes on GitHub to review them"
              aria-label={`Review ${update.actor.name}'s changes on GitHub`}
            >
              Review changes
            </Button>
          )}
        </div>
      )}

      {/* Two groups, not seven loose items. Where it lives (left) and what you
          can do with it (right) — so a narrow panel wraps one whole group
          under the other instead of stranding "Open in GitHub" on its own. */}
      <footer ref={footRef} className="team-update-foot">
        <span className="team-update-foot-where">
          <span className="team-branch-chip">
            <GitBranchHorizontalIcon size={12} />
            {update.branch}
          </span>
          {update.prNumber !== null && (
            <span className="team-pr-chip">
              <PullRequestIcon size={12} />#{update.prNumber}
            </span>
          )}
        </span>

        <span className="team-update-foot-actions">
          {(update.commits.length > 0 || update.files.length > 0) && (
            <button
              type="button"
              className="team-evidence-toggle"
              onClick={() => onToggleExpanded(update.id)}
              aria-expanded={expanded}
            >
              <span className="team-evidence-summary">
                <span className="team-evidence-label">
                  <span className="team-evidence-count team-evidence-count--commits">
                    <GitCommitIcon className="team-evidence-summary-icon" size={16} />
                    {update.commits.length} {update.commits.length === 1 ? 'commit' : 'commits'}
                  </span>
                  <span className="team-evidence-count">
                    <FileIcon
                      className="team-evidence-summary-icon team-evidence-summary-icon--file"
                      size={16}
                    />
                    {update.files.length} {update.files.length === 1 ? 'file' : 'files'}
                  </span>
                </span>
                {expanded ? (
                  <ChevronIcon className="team-evidence-chevron--expanded" size={12} />
                ) : (
                  <ChevronIcon size={12} />
                )}
              </span>
              <span className="team-evidence-totals">
                {totals.added > 0 && <span className="team-diff-add">+{totals.added}</span>}
                {totals.removed > 0 && <span className="team-diff-del">−{totals.removed}</span>}
              </span>
            </button>
          )}

          {/* On every row, not only the thin ones. GitHub is the one place the
              whole team can already see, whether or not they use this app. */}
          {githubUrl && !update.asks && (
            <button
              type="button"
              className="team-github-link"
              onClick={() => void openUrl(githubUrl)}
              title="Open in GitHub"
              aria-label="Open in GitHub"
            >
              <GitHubIcon size={12} />
            </button>
          )}
        </span>
      </footer>

      {expanded && (
        <div className="team-evidence">
          {update.commits.length > 0 && (
            <section className="team-evidence-section" aria-label="Commits">
              <h5 className="team-evidence-heading">Commits</h5>
              <ul className="team-evidence-list team-evidence-list--commits">
                {update.commits.map((commit) => (
                  <li key={commit.sha} className="team-evidence-row">
                    <GitCommitIcon className="team-evidence-icon" size={16} />
                    <code className="team-sha">{commit.sha}</code>
                    <span className="team-evidence-text">{commit.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {update.files.length > 0 && (
            <section className="team-evidence-section" aria-label="Files">
              <h5 className="team-evidence-heading">Files</h5>
              <ul className="team-evidence-list team-evidence-list--files">
                {update.files.map((file) => (
                  <li key={file.path} className="team-evidence-row">
                    <FileIcon className="team-evidence-icon" size={16} />
                    <code className="team-evidence-path">{file.path}</code>
                    <span className="team-diff-add">+{file.added}</span>
                    <span className="team-diff-del">−{file.removed}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}
