import { ComponentsIcon, VariablesIcon } from '@/components/icons';
import { useCommands } from './useCommands';

interface WorkspacePanelCommandOptions {
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
  componentsPanelOpen: boolean;
  componentsPanelAvailable: boolean;
  toggleComponentsPanel: () => void;
  componentsPanelPinned: boolean;
  toggleComponentsPanelPinned: () => void;
}

/** Registers the workspace-level panel actions without growing WorkspaceView. */
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
  componentsPanelOpen,
  componentsPanelAvailable,
  toggleComponentsPanel,
  componentsPanelPinned,
  toggleComponentsPanelPinned,
}: WorkspacePanelCommandOptions) {
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
        id: 'components.togglePin',
        title: componentsPanelPinned ? 'Float Components panel' : 'Dock Components panel',
        icon: <ComponentsIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && componentsPanelAvailable,
        keywords: ['component', 'catalog', 'pin', 'float', 'dock'],
        run: toggleComponentsPanelPinned,
      },
      {
        id: 'components.open',
        title: componentsPanelOpen ? 'Hide Components panel' : 'Show Components panel',
        icon: <ComponentsIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && componentsPanelAvailable,
        keywords: ['component', 'catalog', 'library', 'react', 'reuse'],
        run: toggleComponentsPanel,
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
      componentsPanelOpen,
      componentsPanelAvailable,
      toggleComponentsPanel,
      componentsPanelPinned,
      toggleComponentsPanelPinned,
    ]
  );
}
