/**
 * Miscellaneous action icons.
 *
 * Plus, branch, pull request, settings, globe, zap, help, and layer icons.
 */

import { NewDesignIcon } from './new-design';
import { getIconData, ICON_STROKE_WIDTH, resolveIconSize } from './provenance';

interface IconProps {
  size?: number;
  className?: string;
}

export function LoginIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="LoginIcon" source="Login" size={size} className={className} />;
}

export function AddIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="AddIcon" source="Add" size={size} className={className} />;
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="PlusIcon" source="Plus" size={size} className={className} />;
}

/** Arrow down to a line (lucide arrow-down-to-line) — the git-pull metaphor:
 *  bring the remote's commits down into your working copy. */
export function PullIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon iconName="PullIcon" source="Pull" compact size={size} className={className} />
  );
}

/** Git push action: send local commits to the remote repository. */
export function PushIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon iconName="PushIcon" source="Push" compact size={size} className={className} />
  );
}

export function BranchIcon({ size = 14 }: IconProps) {
  return <NewDesignIcon iconName="BranchIcon" source="GitBranch" compact size={size} />;
}

export function PullRequestIcon({ size = 14 }: IconProps) {
  const renderedSize = resolveIconSize(size, true);

  return (
    <svg
      {...getIconData('PullRequestIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

export function SettingsIcon({ size = 18, className }: IconProps) {
  return (
    <NewDesignIcon iconName="SettingsIcon" source="Settings" size={size} className={className} />
  );
}

export function GlobeIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('GlobeIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function ZapIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="ZapIcon" source="AI" size={size} />;
}

export function AgentsIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="AgentsIcon" source="AI" size={size} />;
}

export function HelpIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('HelpIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function UndoIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="UndoIcon" source="Undo" size={size} className={className} />;
}

export function RedoIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="RedoIcon" source="Redo" size={size} className={className} />;
}

export function LayersIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('LayersIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
