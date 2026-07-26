/**
 * Workspace header bar component.
 *
 * Renders the top header of the workspace view including:
 * - Back button to return to projects
 * - Project name and path
 * - Toolbar action buttons (education, plugins, assets, IDE, env, backups)
 * - GitHub button and publish dropdown
 * - Plugin toolbar/publish slots
 *
 * IDE dropdown state (showIdeDropdown, openingIde, ideAvailability) is managed
 * internally since it is only used within this component.
 *
 * @module components/WorkspaceHeader
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { GitHubButton } from '../branches/GitHubButton';
import { openInFinder } from '../../lib/ide';
import { fileManagerName } from '../../lib/setup';
import { PublishBranchDropdown } from '../branches/PublishBranchDropdown';
import { PluginSlot } from '../plugins/PluginSlot';
import { ImageIcon, PanelLeftIcon, TerminalIcon } from '../icons';
import { Button } from '../primitives/Button';
import type { IntegrationState } from '../../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { PluginThemeData } from '../../contexts/PluginContext';

export const HOSTING_PLUGIN_IDS = ['vercel', 'cloudflare', 'netlify'];

export interface WorkspaceHeaderProps {
  // Project
  projectPath: string;
  projectName: string;

  // Workspace tools that remain directly accessible from the toolbar.
  // Env editor, backups, plugin manager, learn mode, and IDE launch moved
  // to the Cmd+K palette.
  onOpenAssetsPanel: () => void;
  assetsPanelVisible: boolean;
  elementTreeVisible: boolean;
  elementTreeAvailable: boolean;
  onToggleElementTree: () => void;
  agentPanelVisible: boolean;
  onToggleAgentPanel: () => void;

  // Extra dropdown node rendered after Assets in the left cluster. Currently
  // used for the Plugins dropdown. Provided as a
  // pre-composed node because it needs plugin slot data that lives in
  // WorkspaceView. Omit to hide.
  headerExtras?: ReactNode;

  // Branch chip rendered at the very end of the left cluster (after
  // headerExtras). Pre-composed in WorkspaceView since it needs git/branch
  // state. Omit to hide.
  branchIndicator?: ReactNode;

  // Primary workspace modes (Preview/Focus/Code), rendered in their own center
  // cluster between the workspace tools and repository/publishing actions.
  // Pre-composed in WorkspaceView since they drive the right-pane state.
  modes?: ReactNode;

  // Repository views (Branches/PRs), rendered at the start of the right cluster
  // with the other GitHub-related actions. Omit when GitHub is not connected.
  repositoryTabs?: ReactNode;

  // GitHub
  integrations: IntegrationState;
  onGitHubStatusChange: () => void;
  onGitHubConnect: () => void;
  focusActiveTerminal: () => void;

  // Publish
  currentBranch: string | null;
  hasUncommittedChanges: boolean;
  isPublishing: boolean;
  setIsPublishing: (v: boolean) => void;
  onPublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  onPublishStatusChange: () => void;
  onCreatePR: () => void;
  forcePublishOpen: boolean;
  onForcePublishOpenHandled: () => void;

  // Plugin slots
  getSlotPlugins: (slot: string) => LoadedPlugin[];
  pluginProject: {
    name: string;
    path: string;
    currentBranch: string;
    hasUncommittedChanges: boolean;
    devServerUrl: string;
  } | null;
  pluginActions: {
    showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    refreshGitStatus: () => void;
    refreshBranches: () => void;
    focusTerminal: () => void;
    openUrl: (url: string) => void;
    openTerminal: (
      command: string,
      args: string[],
      options?: { title?: string }
    ) => Promise<number | null>;
  };
  pluginTheme: PluginThemeData;
}

export function WorkspaceHeader({
  projectPath,
  projectName,
  onOpenAssetsPanel,
  assetsPanelVisible,
  elementTreeVisible,
  elementTreeAvailable,
  onToggleElementTree,
  agentPanelVisible,
  onToggleAgentPanel,
  headerExtras,
  branchIndicator,
  modes,
  repositoryTabs,
  integrations,
  onGitHubStatusChange,
  onGitHubConnect,
  focusActiveTerminal,
  currentBranch,
  hasUncommittedChanges,
  isPublishing,
  setIsPublishing,
  onPublishError,
  onPublishStatusChange,
  onCreatePR,
  forcePublishOpen,
  onForcePublishOpenHandled,
  getSlotPlugins,
  pluginProject,
  pluginActions,
  pluginTheme,
}: WorkspaceHeaderProps) {
  // Window dragging — only from the title bar (not the toolbar with plugins)
  const handleDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  // Split toolbar plugins: hosting plugins (vercel, etc.) go on the right side
  const toolbarPlugins = useMemo(() => {
    const all = getSlotPlugins('toolbar');
    return {
      regular: all.filter((p) => !HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
      hosting: all.filter((p) => HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
    };
  }, [getSlotPlugins]);

  // IDE launch, env editor, backups, plugin manager, and learn-mode toggle
  // now live in the Cmd+K palette. See src/commands/useAppCommands.tsx.

  const titlebar = (
    <div className="workspace-titlebar" onMouseDown={handleDrag} onDoubleClick={handleDoubleClick}>
      <h1>{projectName}</h1>
      <button
        className="project-path"
        onClick={() => projectPath && void openInFinder(projectPath)}
        title={`Open in ${fileManagerName()}`}
      >
        {projectPath}
      </button>
    </div>
  );

  const toolbar = (
    <header className="workspace-header">
      {/* Left side — Elements and Assets. Learn mode, env vars, backups,
          plugin manager, and IDE launch are reachable via ⌘K. */}
      <div className="workspace-header-left">
        <Button
          onClick={onToggleElementTree}
          disabled={!elementTreeAvailable}
          title={
            !elementTreeAvailable
              ? 'Elements are available in Preview while visual editing is active'
              : elementTreeVisible
                ? 'Hide element tree'
                : 'Show element tree'
          }
          aria-pressed={elementTreeVisible}
        >
          <PanelLeftIcon size={12} />
          <span className="toolbar-btn-label">Elements</span>
        </Button>
        <Button
          onClick={onToggleAgentPanel}
          title={agentPanelVisible ? 'Hide Agent panel' : 'Show Agent panel'}
          aria-pressed={agentPanelVisible}
        >
          <TerminalIcon size={12} />
          <span className="toolbar-btn-label">Agent</span>
        </Button>
        <Button
          onClick={onOpenAssetsPanel}
          title="Assets"
          aria-pressed={assetsPanelVisible}
          data-education-id="assets-button"
        >
          <ImageIcon size={12} />
          <span className="toolbar-btn-label">Assets</span>
        </Button>
        {headerExtras}
        {branchIndicator}
      </div>

      {/* Center — the primary workspace mode switcher is deliberately isolated
          from both local workspace tools and publishing/hosting actions. */}
      <div className="workspace-header-center">{modes}</div>

      {/* Right side — repository views, GitHub, hosting, and publishing */}
      <div className="workspace-header-right">
        {repositoryTabs}
        <span data-education-id="github-button">
          <GitHubButton
            githubState={integrations.github}
            projectStatus={integrations.projectGithub}
            projectPath={projectPath}
            projectName={projectName}
            onStatusChange={onGitHubStatusChange}
            onGitHubConnect={onGitHubConnect}
            onModalClose={focusActiveTerminal}
          />
        </span>
        <PluginSlot
          name="publish"
          plugins={getSlotPlugins('publish')}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
        <PluginSlot
          name="toolbar"
          plugins={toolbarPlugins.hosting}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
        <PublishBranchDropdown
          currentBranch={currentBranch || 'main'}
          projectGithubStatus={integrations.projectGithub}
          projectPath={projectPath}
          hasChangesToSync={hasUncommittedChanges}
          onStatusChange={onPublishStatusChange}
          onModalClose={focusActiveTerminal}
          isPublishing={isPublishing}
          setIsPublishing={setIsPublishing}
          onPublishError={onPublishError}
          onCreatePR={onCreatePR}
          forceOpen={forcePublishOpen}
          onForceOpenHandled={onForcePublishOpenHandled}
        />
      </div>
    </header>
  );

  return { titlebar, toolbar };
}
