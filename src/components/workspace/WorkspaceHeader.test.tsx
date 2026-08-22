import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceHeader, type WorkspaceHeaderProps } from './WorkspaceHeader';
import { openInFinder } from '../../lib/ide';

vi.mock('../../lib/ide', () => ({
  openInFinder: vi.fn(),
}));

const projectPath = '/Users/martin/ShipStudio/projects/a-very-long-project-name';

function headerProps(): WorkspaceHeaderProps {
  return {
    projectPath,
    projectName: 'A very long project name',
    onGoHome: vi.fn(),
    isSidebarHidden: false,
    onToggleSidebar: vi.fn(),
    onOpenAssetsPanel: vi.fn(),
    assetsPanelVisible: false,
    elementTreeVisible: false,
    elementTreeAvailable: true,
    onToggleElementTree: vi.fn(),
    agentPanelVisible: false,
    onToggleAgentPanel: vi.fn(),
    integrations: {} as WorkspaceHeaderProps['integrations'],
    onGitHubStatusChange: vi.fn(),
    onGitHubConnect: vi.fn(),
    focusActiveTerminal: vi.fn(),
    currentBranch: null,
    branches: [],
    openPRs: [],
    hasUncommittedChanges: false,
    changedFiles: [],
    isPulling: false,
    isBranchSwitching: false,
    isRepositoryViewActive: false,
    onPullLatest: vi.fn(),
    onBranchSwitch: vi.fn(),
    onViewBranches: vi.fn(),
    onCreateBranch: vi.fn(),
    onViewPRs: vi.fn(),
    onDiscardChanges: vi.fn(),
    isPublishing: false,
    setIsPublishing: vi.fn(),
    onPublishError: vi.fn(),
    onPublishStatusChange: vi.fn(),
    onCreatePR: vi.fn(),
    forcePublishOpen: false,
    onForcePublishOpenHandled: vi.fn(),
    forceBranchesOpen: false,
    onForceBranchesOpenHandled: vi.fn(),
    getSlotPlugins: () => [],
    pluginProject: null,
    pluginActions: {
      showToast: vi.fn(),
      refreshGitStatus: vi.fn(),
      refreshBranches: vi.fn(),
      focusTerminal: vi.fn(),
      openUrl: vi.fn(),
      openTerminal: vi.fn(),
    },
    pluginTheme: {} as WorkspaceHeaderProps['pluginTheme'],
  };
}

function TitlebarHarness() {
  const { titlebar } = WorkspaceHeader(headerProps());
  return titlebar;
}

describe('WorkspaceHeader title bar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('places sidebar navigation controls in the titlebar', () => {
    const { container } = render(<TitlebarHarness />);

    expect(container.querySelector('.workspace-titlebar-navigation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
  });

  it('keeps the whole path action labelled with the full path', () => {
    render(<TitlebarHarness />);

    const actionLabel = `Open ${projectPath} in Finder`;
    const title = screen.getByRole('heading', { name: 'A very long project name' });
    const pathButton = screen.getByRole('button', { name: actionLabel });

    expect(title.parentElement).toHaveClass('workspace-title-group');
    expect(pathButton.parentElement).toHaveClass('project-path-container');
    expect(pathButton).toHaveAttribute('title', 'Open in Finder');
    expect(pathButton.querySelector('svg')).toBeInTheDocument();

    fireEvent.click(pathButton);
    expect(openInFinder).toHaveBeenCalledWith(projectPath);
  });

  it('expands to the measured full path while hovered', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('project-path-expansion-measure')) {
        return {
          width: 420,
          height: 20,
          top: 0,
          left: 0,
          right: 420,
          bottom: 20,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        width: 240,
        height: 20,
        top: 0,
        left: 0,
        right: 240,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    render(<TitlebarHarness />);
    const pathButton = screen.getByRole('button', {
      name: `Open ${projectPath} in Finder`,
    });
    const container = pathButton.parentElement;

    expect(container).toHaveClass('project-path-container');
    fireEvent.mouseEnter(container!);
    expect(container).toHaveStyle({ width: '420px' });

    fireEvent.mouseLeave(container!);
    expect(container).not.toHaveStyle({ width: '420px' });
  });
});
