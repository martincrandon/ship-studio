import type { ComponentsNavigation } from '../components/workspace/workspaceViewState';
import type { Command } from './types';

export function buildComponentsWorkspaceCommands(
  openComponents: (navigation: ComponentsNavigation) => void
): Command[] {
  return [
    {
      id: 'components.open',
      title: 'Open Components workspace',
      category: 'navigation',
      when: 'project',
      run: () => openComponents({ scope: 'all' }),
    },
  ];
}
