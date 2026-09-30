import { openUrl } from '@tauri-apps/plugin-opener';
import type { ReactNode } from 'react';
import type { TeamActor } from '../../lib/team';

interface TeamActorNameProps {
  actor: TeamActor;
  className?: string;
  children?: ReactNode;
}

/** A GitHub profile link only when the API supplied a confirmed profile URL. */
export function TeamActorName({ actor, className, children }: TeamActorNameProps) {
  const label = children ?? actor.name;
  const profileUrl = actor.profileUrl;

  if (!profileUrl) {
    return <span className={className}>{label}</span>;
  }

  return (
    <a
      className={`team-external-link${className ? ` ${className}` : ''}`}
      href={profileUrl}
      target="_blank"
      rel="noreferrer"
      title="Open in GitHub"
      aria-label={`Open ${actor.name}'s GitHub profile`}
      onClick={(event) => {
        event.preventDefault();
        void openUrl(profileUrl);
      }}
    >
      {label}
    </a>
  );
}
