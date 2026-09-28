/**
 * Preview/code/branch surface for the full workspace layout.
 *
 * The parent owns tab state and domain data; this component owns the right
 * pane's view composition, including floating preview controls and branch tabs.
 */

import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import type {
  PluginAppActions,
  PluginProjectData,
  PluginThemeData,
} from '../../contexts/PluginContext';
import type { DevServerUnexpectedExit } from '../../hooks/useDevServer';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { Project } from '../../lib/project';
import type { ProjectType } from '../../lib/static-server';
import { BranchPRTabContainer, type BranchPRTabContainerProps } from './BranchPRTabContainer';
import { CodeTab } from '../code/CodeTab';
import type { HealthTabPanelRef } from '../code/HealthTabPanel';
import { PluginSlot } from '../plugins/PluginSlot';
import {
  Preview,
  type InspectTab,
  type PreviewHandle,
  type PreviewPanelInsets,
} from '../preview/Preview';
import { DeviceMirror } from '../preview/DeviceMirror';
import { ShopifySetup } from '../shopify/ShopifySetup';
import { ComponentsWorkspace, type ComponentEditPanelRenderer } from './ComponentsWorkspace';
import type { TreeStructureActions } from '../edit/ElementTreePanel';
import type { ComponentsNavigation, WorkspaceTab } from './workspaceViewState';
import {
  selectElementsPanelModel,
  WorkspaceElementsPanel,
  type ElementsPanelCanvasLayers,
  type ElementsPanelModel,
} from './components-inspector/ElementsPanel';
import { useElementTree, type ElementTreeSelection } from '../../hooks/useElementTree';
import type { EditableSurfaceTarget } from '../../lib/components/editable-surface';
import { isSameEditableSurface } from '../../lib/components/editable-surface';
import type { DockablePanelSurfaceRect } from '../primitives/DockablePanel';

/** Props for the web preview, mobile mirror, and code-side workspace pane. */
export interface WorkspacePreviewPaneProps {
  currentProject: Project;
  previewRef: RefObject<PreviewHandle | null>;
  workspaceTab: WorkspaceTab;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  componentsNavigation: ComponentsNavigation;
  onNavigateToComponents: (navigation: ComponentsNavigation) => void;
  hasPreview: boolean;
  projectTypeResolved: boolean;
  previewConnectionEnabled: boolean;
  projectType: ProjectType;
  isWebProject: boolean;
  mobilePreviewAvailable: boolean;
  setCurrentPreviewPage: (page: string) => void;
  devServerPort: number;
  handlePreviewReady: () => void;
  isCropMode: boolean;
  handleCropStart: () => void;
  handleCropComplete: (filePath: string | null) => void;
  handleCropCancel: () => void;
  isBranchSwitching: boolean;
  isRestartingDevServer: boolean;
  sendToClaude: (text: string) => unknown;
  showPreviewLogs: boolean;
  togglePreviewLogs: () => void;
  devServerOutput: string;
  devServerOutputVersion: number;
  onDevServerInput: (data: string) => void;
  onDevServerResize: (cols: number, rows: number) => void;
  inspectTab: InspectTab;
  setInspectTab: (tab: InspectTab) => void;
  healthPanelRef: RefObject<HealthTabPanelRef | null>;
  handleHealthOutput: (data: string) => void;
  needsInstall: { packageManager: string } | null;
  devServerUnexpectedExit: DevServerUnexpectedExit | null;
  handleRestartDevServer: () => Promise<void>;
  onRunInstall: () => void;
  openInCode: (file: string, line: number) => void;
  codeTarget: { file: string; line: number } | null;
  canUndo: boolean;
  canRedo: boolean;
  undoTitle: string;
  redoTitle: string;
  undoSnapshot: () => void | Promise<void>;
  redoSnapshot: () => void | Promise<void>;
  elementTreeVisible: boolean;
  elementTreePinned: boolean;
  toggleElementTreePinned: () => void;
  closeElementTree: () => void;
  setElementTreePreviewAvailable: (available: boolean) => void;
  variablesPanelVisible: boolean;
  variablesPanelPinned: boolean;
  toggleVariablesPanelPinned: () => void;
  closeVariablesPanel: () => void;
  componentsPanelVisible: boolean;
  componentsPanelPinned: boolean;
  toggleComponentsPanelPinned: () => void;
  closeComponentsPanel: () => void;
  componentsEditMainId: string | null;
  setComponentsEditMainId: (componentId: string | null) => void;
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
  getSlotPlugins: (slot: string) => LoadedPlugin[];
  shopify: {
    showGate: boolean;
    markReady: () => void;
    connect: () => void;
  };
  branchTabs: Omit<
    BranchPRTabContainerProps,
    | 'workspaceTab'
    | 'setWorkspaceTab'
    | 'hasPreview'
    | 'projectTypeResolved'
    | 'projectPath'
    | 'onSendToAgent'
  >;
}

/** Renders the active preview-side surface for the current project and workspace mode. */
export function WorkspacePreviewPane(props: WorkspacePreviewPaneProps) {
  const {
    currentProject,
    previewRef,
    workspaceTab,
    setWorkspaceTab,
    componentsNavigation,
    onNavigateToComponents,
    hasPreview,
    projectTypeResolved,
    previewConnectionEnabled,
    projectType,
    isWebProject,
    mobilePreviewAvailable,
    setCurrentPreviewPage,
    devServerPort,
    handlePreviewReady,
    isCropMode,
    handleCropStart,
    handleCropComplete,
    handleCropCancel,
    isBranchSwitching,
    isRestartingDevServer,
    sendToClaude,
    showPreviewLogs,
    togglePreviewLogs,
    devServerOutput,
    devServerOutputVersion,
    onDevServerInput,
    onDevServerResize,
    inspectTab,
    setInspectTab,
    healthPanelRef,
    handleHealthOutput,
    needsInstall,
    devServerUnexpectedExit,
    handleRestartDevServer,
    onRunInstall,
    openInCode,
    codeTarget,
    canUndo,
    canRedo,
    undoTitle,
    redoTitle,
    undoSnapshot,
    redoSnapshot,
    elementTreeVisible,
    elementTreePinned,
    toggleElementTreePinned,
    closeElementTree,
    setElementTreePreviewAvailable,
    variablesPanelVisible,
    variablesPanelPinned,
    toggleVariablesPanelPinned,
    closeVariablesPanel,
    componentsPanelVisible,
    componentsPanelPinned,
    toggleComponentsPanelPinned,
    closeComponentsPanel,
    componentsEditMainId,
    setComponentsEditMainId,
    pluginProject,
    pluginActions,
    pluginTheme,
    getSlotPlugins,
    shopify,
    branchTabs,
  } = props;
  const handleComponentsOpenSource = useCallback(
    (source: { file: string; line: number }) => openInCode(source.file, source.line),
    [openInCode]
  );
  const [previewPanelInsets, setPreviewPanelInsets] = useState<PreviewPanelInsets>({
    left: 0,
    right: 0,
  });
  const [visualEditorState, setVisualEditorState] = useState(() => ({
    projectPath: currentProject.path,
    active: true,
  }));
  const visualEditorActive =
    visualEditorState.projectPath === currentProject.path && visualEditorState.active;
  const handleVisualEditorActiveChange = useCallback(
    (active: boolean) => {
      setVisualEditorState({ projectPath: currentProject.path, active });
    },
    [currentProject.path]
  );
  const [elementsPanelRect, setElementsPanelRect] = useState<DockablePanelSurfaceRect | null>(null);
  const [previewElementsModel, setPreviewElementsModel] = useState<ElementsPanelModel | null>(null);
  const componentFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [componentSurfaceTarget, setComponentSurfaceTarget] =
    useState<EditableSurfaceTarget | null>(null);
  const [componentElementTreeSelection, setComponentElementTreeSelection] =
    useState<ElementTreeSelection | null>(null);
  const [componentCanvasLayers, setComponentCanvasLayers] =
    useState<ElementsPanelCanvasLayers | null>(null);
  const [componentStructureActions, setComponentStructureActions] =
    useState<TreeStructureActions | null>(null);
  const [componentEditPanel, setComponentEditPanel] =
    useState<ComponentEditPanelRenderer | null>(null);
  const handleComponentEditPanelChange = useCallback(
    (panel: ComponentEditPanelRenderer | null) => {
      // A renderer is itself a function, so wrap it before giving it to the
      // state setter; otherwise React treats it as a state updater.
      setComponentEditPanel(() => panel);
    },
    []
  );
  const closeComponentEditPanel = useCallback(() => {
    // Closing the shared dock exits the renderer's edit mode. Components mode
    // then republishes its base Component tab, while the toolbar's Edit toggle
    // remains the explicit path back into Tailwind/CSS editing.
    handleVisualEditorActiveChange(false);
  }, [handleVisualEditorActiveChange]);
  const handleComponentStructureActionsChange = useCallback(
    (actions: TreeStructureActions | null) => {
      setComponentStructureActions((current) => (current === actions ? current : actions));
    },
    []
  );
  const handleRendererTargetChange = useCallback((target: EditableSurfaceTarget | null) => {
    setComponentSurfaceTarget((current) => {
      if (!target) return null;
      return current && isSameEditableSurface(current, target) ? current : target;
    });
    if (!target) setComponentElementTreeSelection(null);
  }, []);
  const handleRendererFrameElementChange = useCallback((element: HTMLIFrameElement | null) => {
    componentFrameRef.current = element;
  }, []);
  const componentElementTree = useElementTree({
    iframeRef: componentFrameRef,
    surfaceTarget: workspaceTab === 'components' ? componentSurfaceTarget : null,
    enabled: workspaceTab === 'components' && componentSurfaceTarget !== null,
    onSelectionChange: setComponentElementTreeSelection,
  });
  const {
    tree: componentTree,
    componentTree: componentTreeProjection,
    truncated: componentTreeTruncated,
    inspectionReady: componentInspectionReady,
    selectedId: componentSelectedId,
    hoveredId: componentHoveredId,
    affectedIds: componentAffectedIds,
    selectedComponent,
    selectNode: selectComponentNode,
    hoverNode: hoverComponentNode,
    selectComponent,
    hoverComponent,
  } = componentElementTree;
  const componentElementsModel = useMemo<ElementsPanelModel>(
    () => ({
      tree: componentTree,
      componentTree: componentTreeProjection,
      truncated: componentTreeTruncated,
      selectedId: componentSelectedId,
      hoveredId: componentHoveredId,
      affectedIds: componentAffectedIds,
      selectedComponentKey: selectedComponent?.key ?? null,
      canvasLayers: componentCanvasLayers ?? undefined,
      onSelect: selectComponentNode,
      onHover: hoverComponentNode,
      onComponentSelect: selectComponent,
      onComponentHover: hoverComponent,
      structure: componentStructureActions ?? undefined,
      selectedSignature: componentElementTreeSelection?.signature ?? null,
      emptyMessage: 'Select a component frame to view its elements',
    }),
    [
      componentAffectedIds,
      componentCanvasLayers,
      componentElementTreeSelection?.signature,
      componentHoveredId,
      componentSelectedId,
      componentTree,
      componentTreeProjection,
      componentTreeTruncated,
      componentStructureActions,
      hoverComponent,
      hoverComponentNode,
      selectComponent,
      selectComponentNode,
      selectedComponent?.key,
    ]
  );
  const elementsPanelInsets = useMemo<PreviewPanelInsets>(() => {
    if (!elementsPanelRect || !elementTreePinned) return { left: 0, right: 0 };
    return { left: Math.ceil(elementsPanelRect.width), right: 0 };
  }, [elementTreePinned, elementsPanelRect]);
  const activeWorkspacePanelInsets = useMemo<PreviewPanelInsets>(
    () => ({
      left: Math.max(
        previewPanelInsets.left,
        workspaceTab === 'components' ? elementsPanelInsets.left : 0
      ),
      right: Math.max(
        previewPanelInsets.right,
        workspaceTab === 'components' ? elementsPanelInsets.right : 0
      ),
    }),
    [elementsPanelInsets, previewPanelInsets, workspaceTab]
  );
  const activeElementsModel = selectElementsPanelModel(
    workspaceTab,
    previewElementsModel,
    componentElementsModel
  );
  const elementsPanelVisible =
    elementTreeVisible && (workspaceTab === 'preview' || workspaceTab === 'components');
  const handlePreviewPanelInsetsChange = useCallback((next: PreviewPanelInsets) => {
    setPreviewPanelInsets((current) =>
      current.left === next.left && current.right === next.right ? current : next
    );
  }, []);
  const {
    integrations,
    branches,
    openPRs,
    currentBranch,
    handleBranchSwitch,
    handleRestartDevServer: handleBranchRestartDevServer,
    setShowSubmitReview,
    fetchBranchInfo,
    handleResolveConflicts,
    handleGitHubConnect,
    createBranchRequest,
    ...worktreeProps
  } = branchTabs;
  const previewSlotPlugins = getSlotPlugins('preview');
  const previewSurfaceVisible = isWebProject || !projectTypeResolved;

  return (
    <div className="preview-pane">
      {/* The .preview-tabs-bar that used to live here was
    lifted up to the workspace-main level so it spans
    the full workspace width. Tab switching behavior
    is unchanged — the content below still swaps
    based on `workspaceTab`. */}

      {/* Tab content */}
      {workspaceTab === 'preview' && previewSurfaceVisible && isWebProject && shopify.showGate && (
        <ShopifySetup
          key={currentProject.path}
          projectPath={currentProject.path}
          onSendToAgent={sendToClaude}
          onReady={shopify.markReady}
          onConnected={shopify.connect}
        />
      )}
      {previewSurfaceVisible && isWebProject && !shopify.showGate && (
        <div
          className={`workspace-preview-pane__preview-surface${
            workspaceTab === 'preview' ? '' : ' workspace-preview-pane__preview-surface--persistent'
          }`}
          aria-hidden={workspaceTab !== 'preview'}
        >
          <Preview
            key={`${currentProject.path}-${devServerPort}`}
            ref={previewRef}
            port={devServerPort}
            projectPath={currentProject.path}
            isStaticProject={projectType === 'statichtml'}
            previewConnectionEnabled={previewConnectionEnabled}
            projectType={projectType}
            onServerReady={handlePreviewReady}
            onPageChange={setCurrentPreviewPage}
            isCropMode={isCropMode}
            onCropStart={handleCropStart}
            onCropComplete={handleCropComplete}
            onCropCancel={handleCropCancel}
            isBranchSwitching={isBranchSwitching}
            isDevServerRestarting={isRestartingDevServer}
            onSendToClaude={sendToClaude}
            showLogs={showPreviewLogs}
            onToggleLogs={togglePreviewLogs}
            devServerOutput={devServerOutput}
            devServerOutputVersion={devServerOutputVersion}
            onDevServerInput={onDevServerInput}
            onDevServerResize={onDevServerResize}
            inspectTab={inspectTab}
            onInspectTabChange={setInspectTab}
            healthPanelRef={healthPanelRef}
            onHealthOutput={handleHealthOutput}
            needsInstall={needsInstall}
            devServerUnexpectedExit={devServerUnexpectedExit}
            onRestartDevServer={() => void handleRestartDevServer()}
            onRunInstall={onRunInstall}
            onOpenInCode={openInCode}
            onOpenComponents={onNavigateToComponents}
            onWorkspacePanelInsetsChange={handlePreviewPanelInsetsChange}
            onElementsPanelModelChange={setPreviewElementsModel}
            componentsEditPanel={workspaceTab === 'components' ? componentEditPanel : null}
            onComponentsEditPanelClose={closeComponentEditPanel}
            // Keep Preview's body-portaled pinned panels after the workspace-level
            // Elements panel in Components mode as well. Without this inset the
            // two surfaces both anchor to the pane's left edge and overlap.
            workspacePanelInsets={elementsPanelVisible ? elementsPanelInsets : undefined}
            canUndo={canUndo}
            canRedo={canRedo}
            undoTitle={undoTitle}
            redoTitle={redoTitle}
            onUndo={() => void undoSnapshot()}
            onRedo={() => void redoSnapshot()}
            elementTreeVisible={elementTreeVisible}
            onElementTreeAvailabilityChange={setElementTreePreviewAvailable}
            variablesPanelVisible={variablesPanelVisible}
            variablesPanelPinned={variablesPanelPinned}
            onToggleVariablesPanelPin={toggleVariablesPanelPinned}
            onCloseVariablesPanel={closeVariablesPanel}
            componentsPanelVisible={componentsPanelVisible}
            componentsPanelPinned={componentsPanelPinned}
            onToggleComponentsPanelPin={toggleComponentsPanelPinned}
            onCloseComponentsPanel={closeComponentsPanel}
            componentsEditMainId={componentsEditMainId}
            onComponentsEditMainChange={setComponentsEditMainId}
            componentsCanvasView={workspaceTab === 'components'}
            visualEditorActive={visualEditorActive}
            onVisualEditorActiveChange={handleVisualEditorActiveChange}
            previewPlugins={
              previewSlotPlugins.length > 0 ? (
                <PluginSlot
                  name="preview"
                  plugins={previewSlotPlugins}
                  project={pluginProject}
                  actions={pluginActions}
                  theme={pluginTheme}
                />
              ) : null
            }
          />
        </div>
      )}
      {workspaceTab === 'preview' && mobilePreviewAvailable && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <DeviceMirror
            key={currentProject.path}
            projectName={currentProject.name}
            projectPath={currentProject.path}
            onSendToAgent={sendToClaude}
          />
        </div>
      )}
      {workspaceTab === 'code' && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          <CodeTab
            projectPath={currentProject.path}
            onSendToAgent={sendToClaude}
            revealTarget={codeTarget}
          />
        </div>
      )}
      {workspaceTab === 'components' && (
        <ComponentsWorkspace
          projectPath={currentProject.path}
          projectType={projectType}
          devServerPort={devServerPort}
          navigation={componentsNavigation}
          onNavigate={onNavigateToComponents}
          onOpenSource={handleComponentsOpenSource}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undoSnapshot}
          onRedo={redoSnapshot}
          panelInsets={activeWorkspacePanelInsets}
          onRendererTargetChange={handleRendererTargetChange}
          onRendererFrameElementChange={handleRendererFrameElementChange}
          visualEditorActive={visualEditorActive}
          onVisualEditorActiveChange={handleVisualEditorActiveChange}
          elementTreeSelection={componentElementTreeSelection}
          componentInspectionReady={componentInspectionReady}
          onTreeStructureActionsChange={handleComponentStructureActionsChange}
          onCanvasLayersChange={setComponentCanvasLayers}
          onEditPanelChange={handleComponentEditPanelChange}
        />
      )}
      <WorkspaceElementsPanel
        model={activeElementsModel ?? undefined}
        projectPath={currentProject.path}
        visible={elementsPanelVisible}
        pinned={elementTreePinned}
        onTogglePin={toggleElementTreePinned}
        onClose={closeElementTree}
        onSurfaceRectChange={setElementsPanelRect}
      />
      <BranchPRTabContainer
        workspaceTab={workspaceTab}
        setWorkspaceTab={setWorkspaceTab}
        hasPreview={hasPreview}
        projectTypeResolved={projectTypeResolved}
        integrations={integrations}
        branches={branches}
        openPRs={openPRs}
        currentBranch={currentBranch}
        projectPath={currentProject.path}
        handleBranchSwitch={handleBranchSwitch}
        handleRestartDevServer={handleBranchRestartDevServer}
        setShowSubmitReview={setShowSubmitReview}
        fetchBranchInfo={fetchBranchInfo}
        handleResolveConflicts={handleResolveConflicts}
        handleGitHubConnect={handleGitHubConnect}
        onSendToAgent={sendToClaude}
        createBranchRequest={createBranchRequest}
        {...worktreeProps}
      />
    </div>
  );
}
