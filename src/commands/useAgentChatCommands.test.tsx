import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../lib/agentChatStore', () => ({
  discardAgentChatThread: vi.fn(async () => undefined),
  getAgentChatSnapshot: vi.fn(() => ({ threads: [], selectedThreadId: null })),
  interruptSelectedAgentChatThread: vi.fn(),
  selectAgentChatDraft: vi.fn(),
}));

import { useAgentChatCommands } from './useAgentChatCommands';
import { _reset, getSnapshot } from './registry';
import { discardAgentChatThread } from '../lib/agentChatStore';
import { matchesContext } from './types';

describe('useAgentChatCommands', () => {
  afterEach(() => {
    _reset();
    vi.clearAllMocks();
  });

  it('scopes reset and settings actions and requires confirmation before discarding', async () => {
    const openNotifications = vi.fn();
    const toggleApproval = vi.fn();
    function Harness({ canToggleApprovalMode }: { canToggleApprovalMode: boolean }): ReactNode {
      return useAgentChatCommands({
        projectPath: '/project',
        setProjectView: () => true,
        setAgentPanelHidden: vi.fn(),
        setPreviewHidden: vi.fn(),
        showToast: vi.fn(),
        selectedThreadId: 'thread-1',
        canToggleApprovalMode,
        onOpenNotificationSettings: openNotifications,
        onToggleApprovalMode: toggleApproval,
      });
    }

    const user = userEvent.setup();
    const { rerender } = render(<Harness canToggleApprovalMode />);
    const project = { kind: 'project' as const, currentProjectName: 'Project' };
    const home = { kind: 'home' as const, currentProjectName: null };
    const commands = getSnapshot();
    const reset = commands.find((command) => command.id === 'agentChat.resetConversation');
    const notifications = commands.find(
      (command) => command.id === 'agentChat.settings.notifications'
    );
    const approval = commands.find((command) => command.id === 'agentChat.settings.approvalMode');

    expect(reset).toBeDefined();
    expect(matchesContext(reset?.when, project)).toBe(true);
    expect(matchesContext(reset?.when, home)).toBe(false);
    expect(matchesContext(notifications?.when, project)).toBe(true);
    expect(matchesContext(notifications?.when, home)).toBe(false);
    expect(matchesContext(approval?.when, project)).toBe(true);

    rerender(<Harness canToggleApprovalMode={false} />);
    const unsupportedApproval = getSnapshot().find(
      (command) => command.id === 'agentChat.settings.approvalMode'
    );
    expect(matchesContext(unsupportedApproval?.when, project)).toBe(false);
    const currentCommands = getSnapshot();
    const currentNotifications = currentCommands.find(
      (command) => command.id === 'agentChat.settings.notifications'
    );
    const currentReset = currentCommands.find(
      (command) => command.id === 'agentChat.resetConversation'
    );

    act(() => {
      currentNotifications?.run();
      currentReset?.run();
    });
    expect(openNotifications).toHaveBeenCalledOnce();
    expect(toggleApproval).not.toHaveBeenCalled();
    expect(discardAgentChatThread).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Delete this saved conversation?' })).toBeVisible();
    expect(
      screen.getByText(
        /permanently deletes the saved Ship Studio conversation, its draft, and attachments/
      )
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() =>
      expect(discardAgentChatThread).toHaveBeenCalledWith('/project', 'thread-1')
    );
  });
});
