/**
 * State and notification icons.
 *
 * Success, error, bell, activity, history, shield check, puzzle, plug, and graduation cap icons.
 */

import { NewDesignIcon } from './new-design';
import { getIconData, ICON_STROKE_WIDTH, resolveIconSize } from './provenance';

interface IconProps {
  size?: number;
  className?: string;
}

export function SuccessIcon({ size = 20 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('SuccessIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function ErrorIcon({ size = 20 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('ErrorIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function BellIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('BellIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function ActivityIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="ActivityIcon" source="Active" size={size} className={className} />
  );
}

export function HistoryIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('HistoryIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function ShieldCheckIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('ShieldCheckIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function PuzzleIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="PuzzleIcon" source="Plugin" size={size} className={className} />;
}

export function PlugIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('PlugIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

export function GraduationCapIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('GraduationCapIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5" />
    </svg>
  );
}
