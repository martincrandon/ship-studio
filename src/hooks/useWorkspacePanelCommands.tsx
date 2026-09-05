import { VariablesIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';

interface Params {
  isAgentPanelHidden: boolean;
  toggleAgentPanel: () => void;
  agentPanelPinned: boolean;
  toggleAgentPanelPinned: () => void;
  elementTreePinned: boolean;
  toggleElementTreePinned: () => void;
  variablesPanelPinned: boolean;
  toggleVariablesPanelPinned: () => void;
  isWebProject: boolean;
  variablesPanelOpen: boolean;
  toggleVariablesPanel: () => void;
  showPreviewLogs: boolean;
  togglePreviewLogs: () => void;
}

/** Registers the workspace panel actions exposed by the Cmd+K palette. */
export function useWorkspacePanelCommands({
  isAgentPanelHidden,
  toggleAgentPanel,
  agentPanelPinned,
  toggleAgentPanelPinned,
  elementTreePinned,
  toggleElementTreePinned,
  variablesPanelPinned,
  toggleVariablesPanelPinned,
  isWebProject,
  variablesPanelOpen,
  toggleVariablesPanel,
  showPreviewLogs,
  togglePreviewLogs,
}: Params): void {
  useCommands(
    () => [
      {
        id: 'workspace.toggleAgentPanel',
        title: isAgentPanelHidden ? 'Show Agent panel' : 'Hide Agent panel',
        category: 'action',
        when: 'project',
        keywords: ['terminal', 'pane', 'sidebar'],
        run: toggleAgentPanel,
      },
      {
        id: 'workspace.toggleAgentPanelPin',
        title: agentPanelPinned ? 'Float Agent panel' : 'Dock Agent panel',
        category: 'action',
        when: 'project',
        keywords: ['terminal', 'pane', 'pin', 'float', 'dock'],
        run: toggleAgentPanelPinned,
      },
      {
        id: 'workspace.toggleElementTreePin',
        title: elementTreePinned ? 'Float Elements panel' : 'Dock Elements panel',
        category: 'action',
        when: 'project',
        keywords: ['elements', 'tree', 'navigator', 'pin', 'float', 'dock'],
        run: toggleElementTreePinned,
      },
      {
        id: 'workspace.toggleVariablesPanelPin',
        title: variablesPanelPinned ? 'Float Variables panel' : 'Dock Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['variables', 'css', 'token', 'pin', 'float', 'dock'],
        run: toggleVariablesPanelPinned,
      },
      {
        id: 'css.variables',
        title: variablesPanelOpen ? 'Hide Variables panel' : 'Show Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['css', 'variable', 'custom property', 'token', 'theme', '--'],
        run: toggleVariablesPanel,
      },
      {
        id: 'workspace.toggleInspector',
        title: showPreviewLogs ? 'Hide Inspector' : 'Show Inspector',
        category: 'action',
        when: 'project',
        keywords: ['preview', 'browser tools', 'logs', 'console', 'network'],
        run: togglePreviewLogs,
      },
    ],
    [
      isAgentPanelHidden,
      toggleAgentPanel,
      agentPanelPinned,
      toggleAgentPanelPinned,
      elementTreePinned,
      toggleElementTreePinned,
      variablesPanelPinned,
      toggleVariablesPanelPinned,
      isWebProject,
      variablesPanelOpen,
      toggleVariablesPanel,
      showPreviewLogs,
      togglePreviewLogs,
    ]
  );
}
