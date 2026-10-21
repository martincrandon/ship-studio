/**
 * Agent/terminal dock for the full workspace layout.
 *
 * The parent owns terminal state and workspace orchestration; this component
 * owns the terminal pane's layout, split-pane rendering, and footer actions.
 */

import { useEffect, type CSSProperties, type MutableRefObject } from 'react';
import { getAgentById, type AgentConfig } from '../../lib/agent';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import {
  type PluginAppActions,
  type PluginProjectData,
  type PluginThemeData,
} from '../../contexts/PluginContext';
import { sessionRegistry } from '../../lib/sessionRegistry';
import {
  createAgentChatDraft,
  getAgentChatSnapshot,
  setAgentChatPanelVisible,
} from '../../lib/agentChatStore';
import { kbd } from '../../lib/shortcuts';
import type { Project } from '../../lib/project';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import type { AgentChatWorkspaceProps } from '../../hooks/useAgentChatWorkspace';
import type { AgentWorkspaceView } from '../../lib/agentChatPreferences';
import type { AgentPromptHandoffResult } from '../../lib/agentPromptHandoff';
import { Terminal } from '../terminal/Terminal';
import type { AgentStatus, TerminalHandle } from '../terminal/Terminal';
import { StaleEnvBanner } from '../terminal/StaleEnvBanner';
import { DevServerLogs } from '../terminal/DevServerLogs';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { DockablePanel } from '../primitives/DockablePanel';
import { usePanelDockBinding } from '../../contexts/PanelDockContext';
import { Spinner } from '../primitives/Spinner';
import {
  CameraIcon,
  CommentIcon,
  CloseIcon,
  CropIcon,
  PinIcon,
  PlusIcon,
  RedoIcon,
  SplitViewIcon,
  TerminalIcon,
  UndoIcon,
} from '@/components/icons';
import { ToolbarDropdown } from './ToolbarDropdown';
import { TerminalSplitDividers } from './TerminalSplitDividers';
import { TerminalSplitHeaders } from './TerminalSplitHeaders';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { AgentChatPanel } from '../agent-chat/AgentChatPanel';

interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
}

/** Props for the agent terminal dock, tabs, splits, and session controls. */
export interface WorkspaceTerminalPaneProps {
  currentProject: Project;
  allSessions: TerminalSessionView[];
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  setActiveTerminalTab: (id: number) => void;
  terminalRefsMap: MutableRefObject<Map<string, TerminalHandle | null>>;
  tabTitles: Map<number, string>;
  autoAcceptMode: boolean;
  getActiveTabAgent: () => AgentConfig;
  handleTerminalExit: (code: number | null) => void;
  createTabStatusHandler: (
    projectPath: string,
    tabId: number
  ) => (status: AgentStatus, title: string) => void;
  handleTabTitleChange: (projectPath: string, tabId: number) => (title: string) => void;
  restartTerminalTab: (tabId: number, projectPath?: string) => void;
  /** Forget a tab's opening prompt once its agent has spawned with it. */
  clearInitialPrompt: (tabId: number, projectPath?: string) => void;
  showHealthLogs: boolean;
  healthOutput: string;
  healthOutputVersion: number;
  sendToClaude: (text: string) => AgentPromptHandoffResult;
  isPreviewHidden: boolean;
  isAgentPanelHidden: boolean;
  agentPanelPinned: boolean;
  toggleAgentPanelPinned: () => void;
  toggleAgentPanel: () => void;
  splitPaneTabIds: number[] | null;
  splitPaneSizes: number[] | null;
  isSplitActive: boolean;
  canSplit: boolean;
  enableSplitView: () => void;
  disableSplitView: () => void;
  setSplitPaneTab: (paneIndex: number, tabId: number) => void;
  addSplitPane: (tabId?: number) => void;
  removeSplitPane: (paneIndex: number) => void;
  setSplitPaneSizes: (sizes: number[]) => void;
  canUndo: boolean;
  canRedo: boolean;
  undoSnapshot: () => void | Promise<void>;
  redoSnapshot: () => void | Promise<void>;
  undoTitle: string;
  redoTitle: string;
  isWebProject: boolean;
  /**
   * Whether there is actually a web preview on screen to capture — the
   * Preview tab is selected and the preview pane isn't collapsed. Gates the
   * screenshot/crop buttons so they can't silently no-op.
   */
  isPreviewCaptureAvailable: boolean;
  isCapturing: boolean;
  isFullPageCapturing: boolean;
  isCropMode: boolean;
  isCropCapturing: boolean;
  setIsCropMode: (mode: boolean) => void;
  handleCaptureScreenshot: () => Promise<void>;
  handleCaptureFullPage: () => Promise<void>;
  agentChat: AgentChatWorkspaceProps;
  onNotificationSettings: () => void;
  onSkills: () => void;
  onMcp: () => void;
  onAutoAcceptToggle: () => void;
  onHelp: () => void;
  terminalPlugins: LoadedPlugin[];
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
}

const AGENT_PANEL_FLOATING_SIZE = { width: 560, height: 680 };

/** Renders and coordinates the workspace agent terminal pane. */
export function WorkspaceTerminalPane(props: WorkspaceTerminalPaneProps) {
  const {
    currentProject,
    allSessions,
    terminalTabs,
    activeTerminalTab,
    setActiveTerminalTab,
    terminalRefsMap,
    tabTitles,
    autoAcceptMode,
    getActiveTabAgent,
    handleTerminalExit,
    createTabStatusHandler,
    handleTabTitleChange,
    restartTerminalTab,
    clearInitialPrompt,
    showHealthLogs,
    healthOutput,
    healthOutputVersion,
    sendToClaude,
    isPreviewHidden,
    isAgentPanelHidden,
    agentPanelPinned,
    toggleAgentPanelPinned,
    toggleAgentPanel,
    splitPaneTabIds,
    splitPaneSizes,
    isSplitActive,
    canSplit,
    enableSplitView,
    disableSplitView,
    setSplitPaneTab,
    addSplitPane,
    removeSplitPane,
    setSplitPaneSizes,
    canUndo,
    canRedo,
    undoSnapshot,
    redoSnapshot,
    undoTitle,
    redoTitle,
    isWebProject,
    isPreviewCaptureAvailable,
    isCapturing,
    isCropMode,
    isCropCapturing,
    setIsCropMode,
    handleCaptureScreenshot,
    agentChat,
    onNotificationSettings,
    onSkills,
    onMcp,
    onAutoAcceptToggle,
    onHelp,
    terminalPlugins,
    pluginProject,
    pluginActions,
    pluginTheme,
  } = props;

  // The rail: which slot this panel's placeholder belongs in, and where to
  // report a drag of the header below.
  const dock = usePanelDockBinding('agent');
  const isChatView = agentChat.view === 'chat';
  const isTerminalView = !isChatView;
  const chatPanelVisible = isChatView && !isAgentPanelHidden;
  useEffect(() => {
    setAgentChatPanelVisible(currentProject.path, chatPanelVisible);
    return () => setAgentChatPanelVisible(currentProject.path, false);
  }, [chatPanelVisible, currentProject.path]);
  const canCapturePreview =
    isPreviewCaptureAvailable && (!isChatView || agentChat.captureAvailable);
  const captureUnavailableTitle = !isPreviewCaptureAvailable
    ? 'Open the Preview tab to capture a screenshot'
    : (agentChat.captureUnavailableReason ?? 'Select a Chat conversation to attach a screenshot');
  const toolbarAgent = isChatView ? getAgentById('codex') : getActiveTabAgent();

  return (
    <DockablePanel
      dock={dock}
      docked={agentPanelPinned || isPreviewHidden}
      visible={!isAgentPanelHidden}
      ariaLabel="Agent panel"
      positionKey="agentPanelFloatingPosition"
      sizeKey="agentPanelFloatingSize"
      floatingSize={AGENT_PANEL_FLOATING_SIZE}
      initialPosition={() => ({
        left: Math.max(24, Math.round(window.innerWidth * 0.08)),
        top: 96,
      })}
      surfaceClassName="dockable-panel__surface--agent"
    >
      <div className={`terminal-pane${isChatView ? ' terminal-pane--chat' : ''}`}>
        <div className="workspace-terminal-view">
          <div className="terminal-agent-header panel-heading-pair" data-dockable-drag-handle>
            <span className="terminal-agent-header__identity">
              <span className="panel-heading-pair-title workspace-panel-title">Agent</span>
              <span className="panel-heading-pair-meta">
                {isChatView ? 'Codex' : getActiveTabAgent().displayName}
              </span>
            </span>
            {!isPreviewHidden && (
              <span className="terminal-agent-header__actions">
                <ToggleButton
                  variant="ghost"
                  size="compact"
                  className="button--icon-only panel-pin-toggle"
                  onClick={toggleAgentPanelPinned}
                  title={
                    agentPanelPinned ? 'Unpin — float over the workspace' : 'Pin to the window'
                  }
                  aria-label={
                    agentPanelPinned ? 'Unpin Agent panel' : 'Pin Agent panel to the window'
                  }
                  pressed={agentPanelPinned}
                  leftIcon={<PinIcon size={13} />}
                />
                <IconButton
                  variant="ghost"
                  size="compact"
                  onClick={toggleAgentPanel}
                  title="Close Agent panel"
                  aria-label="Close Agent panel"
                  icon={<CloseIcon size={14} />}
                />
              </span>
            )}
          </div>
          <div className="agent-panel-modebar">
            <div className="agent-panel-view-control">
              <Tabs
                value={agentChat.view}
                size="compact"
                mode="navigation"
                onValueChange={(value) => agentChat.onViewChange(value as AgentWorkspaceView)}
              >
                <TabsList aria-label="Agent panel view" className="agent-panel-view-switch">
                  <TabsTab
                    value="terminal"
                    className="button--icon-only"
                    aria-label="Terminal"
                    title="Terminal"
                  >
                    <TerminalIcon size={16} />
                  </TabsTab>
                  <TabsTab
                    value="chat"
                    className="button--icon-only"
                    aria-label="Chat"
                    title="Chat"
                  >
                    <CommentIcon size={16} />
                  </TabsTab>
                </TabsList>
              </Tabs>
            </div>
            {isChatView && (
              <Button
                size="compact"
                variant="ghost"
                className="agent-panel-new-conversation"
                leftIcon={<PlusIcon size={14} />}
                aria-label="New conversation"
                title="New conversation"
                onClick={() => {
                  const checkoutPath = getAgentChatSnapshot(
                    currentProject.path
                  ).selectedCheckoutPath;
                  createAgentChatDraft(currentProject.path, checkoutPath);
                }}
              >
                <span className="agent-panel-new-conversation-label">New conversation</span>
              </Button>
            )}
          </div>
          <StaleEnvBanner projectPath={currentProject.path} />
          <div
            className={`terminal-content${isSplitActive && isTerminalView ? ' split' : ''}`}
            data-education-id="claude-terminal"
          >
            {isTerminalView &&
              isSplitActive &&
              currentProject &&
              splitPaneTabIds &&
              splitPaneSizes && (
                <>
                  <TerminalSplitHeaders
                    panes={splitPaneTabIds}
                    sizes={splitPaneSizes}
                    tabs={terminalTabs}
                    tabTitles={tabTitles}
                    onSelectTab={setSplitPaneTab}
                    onRemovePane={removeSplitPane}
                    onAddPane={() => addSplitPane()}
                    canAddPane={splitPaneTabIds.length < terminalTabs.length}
                  />
                  <TerminalSplitDividers sizes={splitPaneSizes} onResize={setSplitPaneSizes} />
                </>
              )}
            {allSessions.flatMap((session) =>
              session.tabs.map((tab) => {
                const isCurrentProject = session.projectPath === currentProject.path;
                const paneIdx =
                  isSplitActive && isCurrentProject && splitPaneTabIds
                    ? splitPaneTabIds.indexOf(tab.id)
                    : -1;
                const inSplitPane = paneIdx >= 0;
                const isVisible =
                  isCurrentProject &&
                  isTerminalView &&
                  !showHealthLogs &&
                  (isSplitActive ? inSplitPane : activeTerminalTab === tab.id);
                const refKey = `${session.projectPath}::${tab.id}`;
                // Anchor both edges to percentages computed from
                // splitPaneSizes — guarantees the last pane's
                // right edge hits exactly 100% (no rounding
                // drift). Reserve 4px next to each drag handle
                // so the 8px handle sits in clean space. Then
                // add a 12px content gutter on every edge so
                // xterm has the same breathing room from the
                // pane chrome that single-pane mode gives it
                // from the sidebar. Opencode is full-bleed by
                // design (its TUI fills the viewport) — skip
                // the content gutter for it.
                let paneStyle: CSSProperties | undefined;
                if (inSplitPane && splitPaneSizes) {
                  const leftPct = splitPaneSizes.slice(0, paneIdx).reduce((a, b) => a + b, 0);
                  const rightPct = splitPaneSizes.slice(paneIdx + 1).reduce((a, b) => a + b, 0);
                  const leftAbutsHandle = paneIdx > 0;
                  const rightAbutsHandle = paneIdx < splitPaneSizes.length - 1;
                  const gutter = tab.agentId === 'opencode' ? 0 : 12;
                  const leftOffset = (leftAbutsHandle ? 4 : 0) + gutter;
                  const rightOffset = (rightAbutsHandle ? 4 : 0) + gutter;
                  paneStyle = {
                    left: `calc(${leftPct}% + ${leftOffset}px)`,
                    right: `calc(${rightPct}% + ${rightOffset}px)`,
                    top: 'var(--split-pane-header-height)',
                  };
                }
                // Background projects use the same `.terminal-tab-content`
                // visibility-based hide (position: absolute + visibility: hidden).
                // `display: none` would zero out xterm's container dims and leave
                // the renderer desynced when the tab became visible again.
                return (
                  <div
                    key={`session-${session.sessionEpoch}-${refKey}`}
                    className={`terminal-tab-content ${isVisible ? 'active' : ''}${
                      inSplitPane ? ' in-pane' : ''
                    }`}
                    data-agent-id={tab.agentId}
                    data-pane-idx={inSplitPane ? paneIdx : undefined}
                    style={paneStyle}
                    onMouseDownCapture={
                      inSplitPane && tab.id !== activeTerminalTab
                        ? () => setActiveTerminalTab(tab.id)
                        : undefined
                    }
                  >
                    <Terminal
                      ref={(ref) => {
                        if (ref) {
                          terminalRefsMap.current.set(refKey, ref);
                        } else {
                          terminalRefsMap.current.delete(refKey);
                        }
                      }}
                      agent={getAgentById(tab.agentId)}
                      projectPath={session.projectPath}
                      onSpawn={(pid) => {
                        sessionRegistry.patchTerminalTab(session.projectPath, tab.id, {
                          status: 'running',
                          pid,
                          exitCode: null,
                        });
                        // The opening prompt is in the agent's argv by now. Forget it,
                        // or restarting this tab later would ask the same thing again.
                        clearInitialPrompt(tab.id, session.projectPath);
                      }}
                      onExit={(code) => {
                        handleTerminalExit(code);
                        sessionRegistry.patchTerminalTab(session.projectPath, tab.id, {
                          status: code === 0 || code === null ? 'exited' : 'crashed',
                          pid: null,
                          exitCode: code,
                        });
                      }}
                      autoAcceptMode={autoAcceptMode}
                      onStatusChange={createTabStatusHandler(session.projectPath, tab.id)}
                      onTitleChange={handleTabTitleChange(session.projectPath, tab.id)}
                      sessionName={tab.sessionId}
                      isActive={isVisible}
                      shouldResume={tab.shouldResume}
                      initialPrompt={tab.initialPrompt}
                      onRequestRestart={() => restartTerminalTab(tab.id, session.projectPath)}
                    />
                  </div>
                );
              })
            )}
            {showHealthLogs && (
              <div className="terminal-tab-content active">
                <DevServerLogs
                  output={healthOutput}
                  outputVersion={healthOutputVersion}
                  onSendToAgent={sendToClaude}
                />
              </div>
            )}
            <div
              className={`agent-chat-host${isChatView ? '' : ' agent-chat-host--hidden'}`}
              aria-hidden={!isChatView}
            >
              <AgentChatPanel
                projectPath={currentProject.path}
                isActive={chatPanelVisible}
                autoAcceptMode={agentChat.approvalMode}
                worktrees={agentChat.worktrees}
                onCreateWorktree={agentChat.onCreateWorktree}
              />
            </div>
          </div>
        </div>

        <div
          className={`terminal-pane-footer${isPreviewHidden ? ' terminal-pane-footer--focus' : ''}`}
        >
          <div className="terminal-pane-footer-left">
            <IconButton
              variant="ghost"
              icon={<UndoIcon size={12} />}
              onClick={() => void undoSnapshot()}
              disabled={!canUndo}
              title={undoTitle}
              aria-label="Undo"
            />
            <IconButton
              variant="ghost"
              icon={<RedoIcon size={12} />}
              onClick={() => void redoSnapshot()}
              disabled={!canRedo}
              title={redoTitle}
              aria-label="Redo"
            />
          </div>

          <div className="terminal-pane-footer-center">
            {/* Screenshot actions only make sense when the Preview
        tab has a web preview to capture. The project being a web project
        isn't enough — with Code/Branches/PRs showing (or the preview pane
        collapsed) there is no iframe to grab, so capture would no-op
        silently and crop mode would latch on with nothing to crop. */}
            {isWebProject && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => void handleCaptureScreenshot()}
                  disabled={isCapturing || isCropMode || !canCapturePreview}
                  title={
                    canCapturePreview
                      ? `Screenshot preview for ${isChatView ? 'Chat' : 'the terminal'} (${kbd('mod', 'shift', 'S')})`
                      : captureUnavailableTitle
                  }
                  data-education-id="screenshot-button"
                >
                  {isCapturing ? (
                    <Spinner size="sm" style={{ color: 'var(--accent-active)' }} />
                  ) : (
                    <CameraIcon size={14} />
                  )}
                  <span className="capture-label-full">Full Screenshot</span>
                  <span className="capture-shortcut">{kbd('mod', 'shift', 'S')}</span>
                </Button>
                <ToggleButton
                  variant="ghost"
                  pressed={isCropMode}
                  onClick={() => setIsCropMode(!isCropMode)}
                  // Still clickable while crop mode is already on, so a mode
                  // latched before the tab changed can always be switched off.
                  disabled={isCapturing || isCropCapturing || (!canCapturePreview && !isCropMode)}
                  title={
                    canCapturePreview || isCropMode
                      ? `Crop screenshot for ${isChatView ? 'Chat' : 'the terminal'} (${kbd('mod', 'shift', 'C')})`
                      : captureUnavailableTitle
                  }
                  data-education-id="crop-button"
                >
                  {isCropCapturing ? (
                    <Spinner size="sm" style={{ color: 'var(--accent-active)' }} />
                  ) : (
                    <CropIcon size={14} />
                  )}
                  <span className="capture-label-full">Crop Screenshot</span>
                  <span className="capture-shortcut">{kbd('mod', 'shift', 'C')}</span>
                </ToggleButton>
              </>
            )}
          </div>

          <div className="terminal-pane-footer-right">
            {canSplit && isTerminalView && (
              <ToggleButton
                variant="ghost"
                type="button"
                pressed={isSplitActive}
                onClick={() => (isSplitActive ? disableSplitView() : enableSplitView())}
                title={isSplitActive ? 'Exit side-by-side view' : 'View agents side by side'}
                aria-label="Toggle side-by-side view"
              >
                <SplitViewIcon aria-hidden="true" />
                <span>Split</span>
                <span
                  className={`toggle-pill-switch ${isSplitActive ? 'is-on' : ''}`}
                  aria-hidden
                />
              </ToggleButton>
            )}
            <ToolbarDropdown
              agent={toolbarAgent}
              autoAcceptMode={isChatView ? agentChat.approvalMode : autoAcceptMode}
              onNotificationSettings={onNotificationSettings}
              onSkills={onSkills}
              onMcp={onMcp}
              onAutoAcceptToggle={isChatView ? agentChat.onToggleApprovalMode : onAutoAcceptToggle}
              onHelp={onHelp}
              terminalPlugins={terminalPlugins}
              pluginProject={pluginProject}
              pluginActions={pluginActions}
              pluginTheme={pluginTheme}
            />
          </div>
        </div>
      </div>
    </DockablePanel>
  );
}
