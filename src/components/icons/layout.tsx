/**
 * View and display icons.
 *
 * Eye, panel, expand/compact, pin, camera, crop, and external link icons.
 */

import { NewDesignIcon } from './new-design';
import { getIconData, ICON_STROKE_WIDTH, resolveIconSize } from './provenance';

interface IconProps {
  size?: number;
  className?: string;
}

export function EyeIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="EyeIcon" source="Eye" size={size} className={className} />;
}

export function EyeOffIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="EyeOffIcon" source="ClosedEye" size={size} className={className} />
  );
}

export function PanelLeftIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('PanelLeftIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

export function ExpandIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="ExpandIcon" source="Expand" size={size} className={className} />;
}

export function CompactIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="CompactIcon" source="Contract" size={size} className={className} />
  );
}

export function PinIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="PinIcon" source="Pin" size={size} />;
}

export function CameraIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="CameraIcon" source="Screenshot" size={size} className={className} />
  );
}

export function CropIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="CropIcon" source="ScreenshotCrop" size={size} className={className} />
  );
}

export function ExternalLinkIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="ExternalLinkIcon"
      source="External"
      compact
      size={size}
      className={className}
    />
  );
}

export function HomeIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="HomeIcon" source="Home" size={size} className={className} />;
}

export function NewWorkspaceIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="NewWorkspaceIcon"
      source="NewWorkspace"
      size={size}
      className={className}
    />
  );
}

export function SwitchWorkspaceIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="SwitchWorkspaceIcon"
      source="SwitchWorkspace"
      size={size}
      className={className}
    />
  );
}

export function MoveToWorkspaceIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="MoveToWorkspaceIcon"
      source="MoveToWorkspace"
      size={size}
      className={className}
    />
  );
}

export function SharedLibraryIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="SharedLibraryIcon"
      source="SharedLibrary"
      size={size}
      className={className}
    />
  );
}

export function SidebarIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="SidebarIcon" source="Sidebar" size={size} className={className} />
  );
}

export function FullBreakpointIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="FullBreakpointIcon"
      source="BreakpointFull"
      size={size}
      className={className}
    />
  );
}

export function DesktopIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="DesktopIcon" source="Desktop" size={size} className={className} />
  );
}

export function LaptopIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="LaptopIcon" source="Tablet" size={size} className={className} />;
}

export function TabletIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="TabletIcon"
      source="MobileHorizontal"
      size={size}
      className={className}
    />
  );
}

export function MobileIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="MobileIcon" source="Mobile" size={size} className={className} />;
}
