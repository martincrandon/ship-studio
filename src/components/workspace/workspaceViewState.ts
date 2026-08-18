import { isMobileProjectType, type ProjectType } from '../../lib/static-server';

export type WorkspaceTab = 'preview' | 'code' | 'branches' | 'prs';

export function workspaceModeValue(
  isPreviewHidden: boolean,
  workspaceTab: WorkspaceTab
): WorkspaceTab | 'focus' {
  return isPreviewHidden ? 'focus' : workspaceTab;
}

export function workspacePreviewCapabilities(
  projectType: ProjectType,
  supportsMobilePreview: boolean
): {
  isMobileProject: boolean;
  mobilePreviewAvailable: boolean;
  isWebProject: boolean;
  hasPreview: boolean;
} {
  const isMobileProject = isMobileProjectType(projectType);
  const mobilePreviewAvailable = isMobileProject && supportsMobilePreview;
  const isWebProject = projectType !== 'generic' && projectType !== 'unknown' && !isMobileProject;
  return {
    isMobileProject,
    mobilePreviewAvailable,
    isWebProject,
    hasPreview: isWebProject || mobilePreviewAvailable,
  };
}

export function defaultWorkspaceTab(hasPreview: boolean): 'preview' | 'code' {
  return hasPreview ? 'preview' : 'code';
}
