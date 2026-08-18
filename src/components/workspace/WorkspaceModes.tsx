import { CodeIcon, EyeIcon, EyeOffIcon } from '@/components/icons';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { workspaceModeValue, type WorkspaceTab } from './workspaceViewState';

export interface WorkspaceModesProps {
  hasPreview: boolean;
  isPreviewHidden: boolean;
  workspaceTab: WorkspaceTab;
  setIsPreviewHidden: (hidden: boolean) => void;
  setIsAgentPanelHidden: (hidden: boolean) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
}

export function WorkspaceModes({
  hasPreview,
  isPreviewHidden,
  workspaceTab,
  setIsPreviewHidden,
  setIsAgentPanelHidden,
  setWorkspaceTab,
}: WorkspaceModesProps) {
  return (
    <Tabs
      value={workspaceModeValue(isPreviewHidden, workspaceTab)}
      mode="navigation"
      className="workspace-tabs"
      onValueChange={(next) => {
        if (next === 'focus') {
          setIsAgentPanelHidden(false);
          setIsPreviewHidden(true);
          return;
        }
        setIsPreviewHidden(false);
        setWorkspaceTab(next as WorkspaceTab);
      }}
    >
      <TabsList
        className="workspace-tabs-list"
        variant="stretch"
        appearance="underline"
        aria-label="Workspace mode"
      >
        {hasPreview && (
          <TabsTab
            value="preview"
            className="workspace-tab"
            leftIcon={<EyeIcon size={14} />}
            data-tooltip-disabled
          >
            <span>Preview</span>
          </TabsTab>
        )}
        <TabsTab
          value="focus"
          className="workspace-tab"
          leftIcon={<EyeOffIcon size={14} />}
          title={isPreviewHidden ? 'Exit focus mode' : 'Hide preview — agent only'}
        >
          <span>Focus</span>
        </TabsTab>
        <TabsTab
          value="code"
          className="workspace-tab"
          leftIcon={<CodeIcon size={14} />}
          title="Code"
        >
          <span>Code</span>
        </TabsTab>
      </TabsList>
    </Tabs>
  );
}
