/**
 * Navigation and UI chrome icons.
 *
 * Chevrons, check marks, warnings, close, info, search, arrows, and layout toggles.
 */

import { NewDesignIcon } from './new-design';
import { getIconData, ICON_STROKE_WIDTH, resolveIconSize } from './provenance';

interface IconProps {
  size?: number;
  className?: string;
}

export function ChevronIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="ChevronIcon"
      source="ChevronDown"
      compact
      size={size}
      className={className}
    />
  );
}

export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="ChevronRightIcon"
      source="ChevronRight"
      size={size}
      className={className}
    />
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="CheckIcon" source="Tick" size={size} className={className} />;
}

export function WarningIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="WarningIcon" source="WarningAlert" size={size} className={className} />
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="CloseIcon" source="Cancel" size={size} className={className} />;
}

export function InfoIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('InfoIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="SearchIcon" source="Search" size={size} className={className} />;
}

export function ArrowLeftIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="ArrowLeftIcon" source="Left" size={size} className={className} />;
}

export function ArrowRightIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="ArrowRightIcon" source="Right" size={size} className={className} />
  );
}

/** Icon representing card/grid layout. */
export function GridIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="GridIcon" source="Grid" size={size} />;
}

/** Icon representing row/list layout. */
export function ListIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="ListIcon" source="List" size={size} />;
}
