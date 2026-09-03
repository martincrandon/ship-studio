import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModalProvider } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import { sessionRegistry } from '../../lib/sessionRegistry';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import { mockInvokeResponse } from '../../test/setup';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const PROJECT_PATH = '/tmp/sidebar-project';
const EXPANDED_PROJECTS_KEY = 'ship-studio:workspace-sidebar:expanded-projects';

function row(): PinnedProjectRow {
  return {
    projectPath: PROJECT_PATH,
    fallbackName: 'sidebar-project',
    status: 'active',
    agentStatus: 'thinking',
    unreadCount: 0,
    memoryBytes: 0,
    isCurrent: true,
  };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ModalProvider>
      <PaletteContextProvider>{children}</PaletteContextProvider>
    </ModalProvider>
  );
}

function sidebarProps(): ComponentProps<typeof WorkspaceSidebar> {
  return {
    isHomeActive: false,
    onGoHome: vi.fn(),
    onOpenProjectPicker: vi.fn(),
    projects: [row()],
    currentProjectPath: PROJECT_PATH,
    currentProjectName: 'sidebar-project',
    onSelectProject: vi.fn(),
    terminalTabs: [
      {
        id: 1,
        agentId: 'claude-code',
        sessionId: 'session-1',
      },
    ],
    activeTerminalTab: 1,
    tabTitles: new Map(),
    attentionTabs: new Set(),
    maxTabs: 5,
    onSelectTab: vi.fn(),
    onAddTab: vi.fn(),
    onCloseTab: vi.fn(),
    hasDevServer: false,
    isRestartingDevServer: false,
    devServerRunning: false,
  };
}

describe('WorkspaceSidebar project activity indicator', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvokeResponse('list_accounts', []);
    mockInvokeResponse('get_project_account_id', null);
    mockInvokeResponse('get_active_account_id', 'default');
    sessionRegistry._resetForTests();
    sessionRegistry.setTerminalTabs(
      PROJECT_PATH,
      [
        {
          id: 1,
          agentId: 'claude-code',
          sessionId: 'session-1',
          status: 'thinking',
        },
      ],
      0
    );
  });

  afterEach(() => {
    localStorage.clear();
    sessionRegistry._resetForTests();
  });

  it('uses the same icon-only ghost treatment for Home as the project titlebar', async () => {
    render(<WorkspaceSidebar {...sidebarProps()} />, { wrapper: Providers });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Home' })).toHaveClass(
        'button--ghost',
        'button--icon-only'
      );
    });
  });

  it('disables Home while the Homepage is active', async () => {
    render(<WorkspaceSidebar {...sidebarProps()} isHomeActive />, { wrapper: Providers });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Home' })).toBeDisabled();
    });
  });

  it('shows the PixelLoader in a collapsed project row when a tab is thinking', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ [PROJECT_PATH]: false }));

    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, {
      wrapper: Providers,
    });

    await waitFor(() => {
      expect(
        container.querySelector('.sidebar-project-status .ss-pixel-loader')
      ).toBeInTheDocument();
      expect(
        container.querySelector('.sidebar-project-status .sidebar-row-dot')
      ).not.toBeInTheDocument();
    });
  });

  it('keeps the project dot while expanded and shows the PixelLoader on the tab row', async () => {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify({ [PROJECT_PATH]: true }));

    const { container } = render(<WorkspaceSidebar {...sidebarProps()} />, {
      wrapper: Providers,
    });

    await waitFor(() => {
      expect(
        container.querySelector('.sidebar-project-status .sidebar-row-dot')
      ).toBeInTheDocument();
      expect(container.querySelector('.sidebar-project-body .ss-pixel-loader')).toBeInTheDocument();
    });
  });

  it('opens the ghost workspace switcher and switches accounts from its upward menu', async () => {
    const defaultWorkspace = {
      id: 'default',
      name: 'Default',
      color: '#6b7280',
      isDefault: true,
      createdAt: 1,
    };
    const clientWorkspace = {
      id: 'client',
      name: 'Client',
      color: '#3b82f6',
      isDefault: false,
      createdAt: 2,
    };
    const onGoHome = vi.fn();
    const setActive = vi.fn();
    mockInvokeResponse('list_accounts', [defaultWorkspace, clientWorkspace]);
    mockInvokeResponse('set_active_account_id', (args: unknown) => {
      setActive(args);
    });

    const user = userEvent.setup();
    render(<WorkspaceSidebar {...sidebarProps()} onGoHome={onGoHome} onSwitchAccount={vi.fn()} />, {
      wrapper: Providers,
    });

    const trigger = await screen.findByRole('button', {
      name: 'Switch workspace, currently Default',
    });
    expect(trigger).toHaveClass('button--ghost');
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.closest('.workspace-sidebar-footer-actions')).toHaveClass(
      'has-workspace-switcher'
    );

    const openProjectButton = screen.getByRole('button', { name: 'Open project' });
    expect(openProjectButton).toHaveClass('button--ghost');
    expect(openProjectButton.closest('.workspace-sidebar-active-actions')).toBeInTheDocument();
    expect(openProjectButton.closest('.workspace-sidebar-scroll')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support' })).toHaveClass(
      'button--ghost',
      'button--icon-only'
    );
    expect(screen.getByRole('button', { name: 'App settings' })).toHaveClass(
      'button--ghost',
      'button--icon-only'
    );

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.queryByRole('button', { name: 'Default, current workspace' })
    ).not.toBeInTheDocument();
    const manageButton = screen.getByRole('button', { name: 'Manage workspaces' });
    const clientButton = screen.getByRole('button', { name: 'Switch to Client' });
    expect(manageButton).toBeVisible();
    expect(clientButton).toBeVisible();
    expect(manageButton.querySelector('.button__icon')).toBeInTheDocument();
    expect(clientButton.querySelector('.workspace-switcher-option-dot')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Switch to Client' }));

    await waitFor(() => {
      expect(setActive).toHaveBeenCalledWith({ id: 'client' });
      expect(onGoHome).toHaveBeenCalledOnce();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
