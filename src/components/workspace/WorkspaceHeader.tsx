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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BranchIndicator } from '../branches/BranchIndicator';
import { BranchesMenu } from '../branches/BranchesMenu';
import { openInFinder } from '../../lib/ide';
import { PublishBranchDropdown } from '../branches/PublishBranchDropdown';
import { PluginSlot } from '../plugins/PluginSlot';
import { FolderOpenIcon, ImageIcon, PanelLeftIcon, TerminalIcon } from '../icons';
import { Button } from '../primitives/Button';
import { MiddleTruncate } from '../primitives/MiddleTruncate';
import { ToggleButton } from '../primitives/ToggleButton';
import type { IntegrationState } from '../../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { PluginThemeData } from '../../contexts/PluginContext';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';
import type { ChangedFile } from '../../lib/git';

export const HOSTING_PLUGIN_IDS = ['vercel', 'cloudflare', 'netlify'];
export const PUSH_HOSTING_PLUGIN_IDS = ['vercel', 'cloudflare'];

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

  // Primary workspace modes (Preview/Focus/Code), rendered in their own center
  // cluster between the workspace tools and repository/publishing actions.
  // Pre-composed in WorkspaceView since they drive the right-pane state.
  modes?: ReactNode;

  // GitHub
  integrations: IntegrationState;
  onGitHubStatusChange: () => void;
  onGitHubConnect: () => void;
  focusActiveTerminal: () => void;

  // Publish
  currentBranch: string | null;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  hasUncommittedChanges: boolean;
  changedFiles: ChangedFile[];
  isPulling: boolean;
  isBranchSwitching: boolean;
  isRepositoryViewActive: boolean;
  onPullLatest: () => void;
  onBranchSwitch: (branch: string) => void;
  onViewBranches: () => void;
  onCreateBranch: () => void;
  onViewPRs: () => void;
  onDiscardChanges: () => void;
  isPublishing: boolean;
  setIsPublishing: (v: boolean) => void;
  onPublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  onPublishStatusChange: () => void;
  onCreatePR: (branch?: string) => void;
  forcePublishOpen: boolean;
  onForcePublishOpenHandled: () => void;
  forceBranchesOpen: boolean;
  onForceBranchesOpenHandled: () => void;

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
  modes,
  integrations,
  onGitHubStatusChange,
  onGitHubConnect,
  focusActiveTerminal,
  currentBranch,
  branches,
  openPRs,
  hasUncommittedChanges,
  changedFiles,
  isPulling,
  isBranchSwitching,
  isRepositoryViewActive,
  onPullLatest,
  onBranchSwitch,
  onViewBranches,
  onCreateBranch,
  onViewPRs,
  onDiscardChanges,
  isPublishing,
  setIsPublishing,
  onPublishError,
  onPublishStatusChange,
  onCreatePR,
  forcePublishOpen,
  onForcePublishOpenHandled,
  forceBranchesOpen,
  onForceBranchesOpenHandled,
  getSlotPlugins,
  pluginProject,
  pluginActions,
  pluginTheme,
}: WorkspaceHeaderProps) {
  const [openSourceMenu, setOpenSourceMenu] = useState<'branches' | 'push' | null>(null);
  const currentBranchIsLive =
    currentBranch !== null &&
    (branches.find((branch) => branch.name === currentBranch)?.isDefault ?? false);
  const projectPathContainerRef = useRef<HTMLDivElement>(null);
  const [expandedProjectPathWidth, setExpandedProjectPathWidth] = useState<number | null>(null);
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

  const expandProjectPath = useCallback(() => {
    const measure = projectPathContainerRef.current?.querySelector<HTMLElement>(
      '.project-path-expansion-measure'
    );
    if (!measure) return;
    const rect = measure.getBoundingClientRect();
    const width = rect.width || measure.scrollWidth;
    if (width > 0) setExpandedProjectPathWidth(width);
  }, []);

  const collapseProjectPath = useCallback(() => {
    const container = projectPathContainerRef.current;
    if (container?.contains(document.activeElement)) return;
    setExpandedProjectPathWidth(null);
  }, []);

  const handleProjectPathBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setExpandedProjectPathWidth(null);
  }, []);

  // Split toolbar plugins: hosting plugins (vercel, etc.) go on the right side
  const toolbarPlugins = useMemo(() => {
    const all = getSlotPlugins('toolbar');
    return {
      regular: all.filter((p) => !HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
      hosting: all.filter((p) => HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
    };
  }, [getSlotPlugins]);
  const pushHostingPlugins = useMemo(
    () =>
      toolbarPlugins.hosting.filter((plugin) =>
        PUSH_HOSTING_PLUGIN_IDS.includes(plugin.info.manifest.id)
      ),
    [toolbarPlugins.hosting]
  );
  const headerHostingPlugins = useMemo(
    () =>
      toolbarPlugins.hosting.filter(
        (plugin) => !PUSH_HOSTING_PLUGIN_IDS.includes(plugin.info.manifest.id)
      ),
    [toolbarPlugins.hosting]
  );

  useEffect(() => {
    if (!forceBranchesOpen) return;
    setOpenSourceMenu('branches');
    onForceBranchesOpenHandled();
  }, [forceBranchesOpen, onForceBranchesOpenHandled]);

  // IDE launch, env editor, backups, plugin manager, and learn-mode toggle
  // now live in the Cmd+K palette. See src/commands/useAppCommands.tsx.

  const titlebar = (
    <div className="workspace-titlebar" onMouseDown={handleDrag} onDoubleClick={handleDoubleClick}>
      <div className="workspace-title-group">
        <h1>{projectName}</h1>
        <div
          ref={projectPathContainerRef}
          className="project-path-container"
          style={
            expandedProjectPathWidth !== null
              ? { width: `${expandedProjectPathWidth}px` }
              : undefined
          }
          onMouseEnter={expandProjectPath}
          onMouseLeave={collapseProjectPath}
          onFocus={expandProjectPath}
          onBlur={handleProjectPathBlur}
        >
          <span className="project-path-expansion-measure" aria-hidden="true">
            <FolderOpenIcon size={14} />
            {projectPath}
          </span>
          <button
            className="project-path"
            onClick={() => projectPath && void openInFinder(projectPath)}
            title="Open in Finder"
            aria-label={`Open ${projectPath} in Finder`}
          >
            <FolderOpenIcon size={14} />
            <MiddleTruncate text={projectPath} />
          </button>
        </div>
      </div>
    </div>
  );

  const toolbar = (
    <header className="workspace-header">
      {/* Left side — Elements and Assets. Learn mode, env vars, backups,
          plugin manager, and IDE launch are reachable via ⌘K. */}
      <div className="workspace-header-left">
        <ToggleButton
          variant={elementTreeVisible ? 'secondary' : 'default'}
          className="workspace-panel-toggle"
          pressed={elementTreeVisible}
          onClick={onToggleElementTree}
          disabled={!elementTreeAvailable}
          title={
            !elementTreeAvailable
              ? 'Elements are available in Preview'
              : elementTreeVisible
                ? 'Hide element tree'
                : 'Show element tree'
          }
          leftIcon={<PanelLeftIcon size={16} />}
        >
          <span className="toolbar-btn-label">Elements</span>
        </ToggleButton>
        <ToggleButton
          variant={agentPanelVisible ? 'secondary' : 'default'}
          className="workspace-panel-toggle"
          pressed={agentPanelVisible}
          onClick={onToggleAgentPanel}
          title={agentPanelVisible ? 'Hide Agent panel' : 'Show Agent panel'}
          leftIcon={<TerminalIcon size={16} />}
        >
          <span className="toolbar-btn-label">Agent</span>
        </ToggleButton>
        <Button
          onClick={onOpenAssetsPanel}
          title="Assets"
          aria-pressed={assetsPanelVisible}
          data-education-id="assets-button"
          leftIcon={<ImageIcon size={16} />}
        >
          <span className="toolbar-btn-label">Assets</span>
        </Button>
        {headerExtras}
      </div>

      {/* Center — the primary workspace mode switcher is deliberately isolated
          from both local workspace tools and publishing/hosting actions. */}
      <div className="workspace-header-center">{modes}</div>

      {/* Right side — hosting, repository workflow, and publishing */}
      <div className="workspace-header-right">
        <PluginSlot
          name="publish"
          plugins={getSlotPlugins('publish')}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
        <PluginSlot
          name="toolbar"
          plugins={headerHostingPlugins}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
        <div className="source-control-actions">
          <BranchesMenu
            githubState={integrations.github}
            projectStatus={integrations.projectGithub}
            projectPath={projectPath}
            projectName={projectName}
            currentBranch={currentBranch}
            branches={branches}
            openPRs={openPRs}
            isPulling={isPulling}
            isBranchSwitching={isBranchSwitching}
            isRepositoryViewActive={isRepositoryViewActive}
            isOpen={openSourceMenu === 'branches'}
            onOpenChange={(open) => setOpenSourceMenu(open ? 'branches' : null)}
            onPullLatest={onPullLatest}
            onBranchSwitch={onBranchSwitch}
            onViewBranches={onViewBranches}
            onCreateBranch={onCreateBranch}
            onViewPRs={onViewPRs}
            onStartPR={(branch) => onCreatePR(branch)}
            onGitHubConnect={onGitHubConnect}
            onGitHubStatusChange={onGitHubStatusChange}
            onModalClose={focusActiveTerminal}
          />
          <div
            className={`source-control-push${hasUncommittedChanges ? ' has-unsaved-changes' : ''}`}
            onClick={(event) => {
              if (!hasUncommittedChanges) return;
              if ((event.target as HTMLElement).closest('button')) return;
              setOpenSourceMenu(openSourceMenu === 'push' ? null : 'push');
            }}
          >
            {hasUncommittedChanges && currentBranch && (
              <BranchIndicator
                currentBranch={currentBranch}
                hasUncommittedChanges={hasUncommittedChanges}
                changedFiles={changedFiles}
                projectPath={projectPath}
                onDiscard={onDiscardChanges}
                isOpen={openSourceMenu === 'push'}
                onOpenChange={(open) => setOpenSourceMenu(open ? 'push' : null)}
                opensPushMenu
                isLive={currentBranchIsLive}
              />
            )}
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
              open={openSourceMenu === 'push'}
              onOpenChange={(open) => setOpenSourceMenu(open ? 'push' : null)}
              grouped={hasUncommittedChanges}
              changedFiles={changedFiles}
              onDiscardChanges={onDiscardChanges}
              excludeClickOutsideSelector=".source-control-push"
              hostingControls={
                pushHostingPlugins.length > 0 ? (
                  <PluginSlot
                    name="toolbar"
                    plugins={pushHostingPlugins}
                    project={pluginProject}
                    actions={pluginActions}
                    theme={pluginTheme}
                  />
                ) : undefined
              }
            />
          </div>
        </div>
      </div>
    </header>
  );

  return { titlebar, toolbar };
}
