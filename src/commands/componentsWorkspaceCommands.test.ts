import { describe, expect, it, vi } from 'vitest';
import { buildComponentsWorkspaceCommands } from './componentsWorkspaceCommands';

describe('Components workspace global commands', () => {
  it('exposes one globally reachable open command without owning panel toggling', () => {
    const openComponents = vi.fn();
    const commands = buildComponentsWorkspaceCommands(openComponents);

    expect(commands.map((command) => command.id)).toEqual(['components.open']);
    void commands[0].run();
    expect(openComponents).toHaveBeenCalledWith({ scope: 'all' });
  });
});
