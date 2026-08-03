/**
 * File and code operation icons.
 *
 * Code, terminal, edit, file, folder, trash, upload, download, copy, reset, and image icons.
 */

import { NewDesignIcon } from './new-design';
import { getIconData, ICON_STROKE_WIDTH, resolveIconSize } from './provenance';

interface IconProps {
  size?: number;
  className?: string;
}

export function CodeIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="CodeIcon" source="CodeBlock" size={size} className={className} />;
}

export function TerminalIcon({ size = 16 }: IconProps) {
  const renderedSize = resolveIconSize(size);

  return (
    <svg
      {...getIconData('TerminalIcon')}
      width={renderedSize}
      height={renderedSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function EditIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="EditIcon" source="EditMode" size={size} />;
}

export function FileIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="FileIcon" source="File" size={size} />;
}

export function FileTextIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon iconName="FileTextIcon" source="FileText" size={size} className={className} />
  );
}

export function FolderIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="FolderIcon" source="Folder" size={size} />;
}

export function FolderOpenIcon({ size = 16, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="FolderOpenIcon"
      source="FolderOpen"
      size={size}
      className={className}
    />
  );
}

export function FolderPlusIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="FolderPlusIcon" source="NewFolder" size={size} />;
}

export function TrashIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="TrashIcon" source="Trash" size={size} className={className} />;
}

export function UploadIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="UploadIcon" source="Up" size={size} />;
}

export function DownloadIcon({ size = 16 }: IconProps) {
  return <NewDesignIcon iconName="DownloadIcon" source="Down" size={size} />;
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon iconName="CopyIcon" source="Copy" compact size={size} className={className} />
  );
}

export function DuplicateIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon
      iconName="DuplicateIcon"
      source="Duplicate"
      compact
      size={size}
      className={className}
    />
  );
}

export function ResetIcon({ size = 14, className }: IconProps) {
  return (
    <NewDesignIcon iconName="ResetIcon" source="Reload" compact size={size} className={className} />
  );
}

export function ImageIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="ImageIcon" source="Image" size={size} className={className} />;
}

export function SaveIcon({ size = 16, className }: IconProps) {
  return <NewDesignIcon iconName="SaveIcon" source="Save" size={size} className={className} />;
}
