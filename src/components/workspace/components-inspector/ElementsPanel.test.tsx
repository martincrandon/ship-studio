import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  selectElementsPanelModel,
  WorkspaceElementsPanel,
  type ElementsPanelModel,
} from './ElementsPanel';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

function model(tag: string | null, emptyMessage?: string): ElementsPanelModel {
  return {
    tree: tag ? { id: 1, tag, cls: '', text: '', children: [] } : null,
    componentTree: null,
    truncated: false,
    selectedId: tag ? 1 : null,
    hoveredId: null,
    affectedIds: [],
    selectedComponentKey: null,
    onSelect: vi.fn(),
    onHover: vi.fn(),
    emptyMessage,
  };
}

const panelProps = {
  projectPath: '/tmp/project',
  visible: true,
  pinned: true,
  onTogglePin: vi.fn(),
  onClose: vi.fn(),
};

describe('WorkspaceElementsPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an empty Components model before a renderer frame is selected', () => {
    render(
      <WorkspaceElementsPanel
        {...panelProps}
        model={model(null, 'Select a component frame to view its elements')}
      />
    );

    expect(screen.getByText('Select a component frame to view its elements')).toBeInTheDocument();
  });

  it('routes the singleton surface between Preview and Components models', () => {
    const preview = model('main');
    const components = model('article');
    const { rerender } = render(<WorkspaceElementsPanel {...panelProps} model={preview} />);

    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getAllByTestId('element-tree-panel')).toHaveLength(1);

    rerender(<WorkspaceElementsPanel {...panelProps} model={components} />);

    expect(screen.queryByText('main')).not.toBeInTheDocument();
    expect(screen.getByText('article')).toBeInTheDocument();
    expect(screen.getAllByTestId('element-tree-panel')).toHaveLength(1);
    expect(selectElementsPanelModel('code', preview, components)).toBeNull();
  });

  it('places component canvas layers inside the Elements panel above its tree', () => {
    const onSelectionChange = vi.fn();
    const onToggleVisibility = vi.fn();
    const onToggleLock = vi.fn();
    const onToggleExpanded = vi.fn();
    const componentModel = {
      ...model('section'),
      canvasLayers: {
        layers: [
          { id: 'card', name: 'Card', expanded: true },
          { id: 'button', name: 'Button', parentId: 'card' },
        ],
        selectedIds: ['card'],
        onSelectionChange,
        onToggleExpanded,
        onToggleVisibility,
        onToggleLock,
      },
    };
    render(<WorkspaceElementsPanel {...panelProps} model={componentModel} />);

    const layersTree = screen.getByRole('tree', { name: 'Components' });
    const elementsTree = screen.getByTestId('element-tree-panel');
    expect(elementsTree).toContainElement(layersTree);
    expect(layersTree.compareDocumentPosition(elementsTree) & Node.DOCUMENT_POSITION_CONTAINS).toBe(
      Node.DOCUMENT_POSITION_CONTAINS
    );
    expect(screen.queryByRole('tree', { name: 'Layers' })).not.toBeInTheDocument();
    expect(elementsTree.querySelectorAll('[data-icon-name="ComponentsIcon"]')).toHaveLength(2);
    const sectionResize = screen.getByRole('separator', { name: 'Resize Components section' });
    expect(sectionResize).toHaveAttribute('aria-orientation', 'horizontal');
    expect(sectionResize).toHaveAttribute('aria-valuenow', '35');

    fireEvent.click(screen.getByText('Card'));
    expect(onSelectionChange).toHaveBeenCalledWith(['card']);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Card' }));
    expect(onToggleExpanded).toHaveBeenCalledWith('card', false);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Card' }));
    expect(onToggleVisibility).toHaveBeenCalledWith('card', false);
    fireEvent.click(screen.getByRole('button', { name: 'Lock Card' }));
    expect(onToggleLock).toHaveBeenCalledWith('card', true);

    fireEvent.keyDown(sectionResize, { key: 'ArrowDown' });
    expect(sectionResize).toHaveAttribute('aria-valuenow', '45');
  });

  it('keeps pin controls and docked width across the singleton lifetime', async () => {
    const onTogglePin = vi.fn();
    const { unmount } = render(
      <WorkspaceElementsPanel {...panelProps} onTogglePin={onTogglePin} model={model('main')} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unpin Elements panel' }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    const resize = screen.getByRole('separator', { name: 'Resize Elements panel' });
    await act(() => fireEvent.keyDown(resize, { key: 'ArrowRight' }));
    expect(resize).toHaveAttribute('aria-valuenow', '250');
    expect(localStorage.getItem('elementTreeDockedWidth')).toBe('250');

    unmount();
    render(<WorkspaceElementsPanel {...panelProps} model={model('main')} />);
    expect(screen.getByRole('separator', { name: 'Resize Elements panel' })).toHaveAttribute(
      'aria-valuenow',
      '250'
    );
  });

  it('hides the docked resize handle when the panel is closed', () => {
    const { rerender } = render(<WorkspaceElementsPanel {...panelProps} model={model('main')} />);

    expect(screen.getByRole('separator', { name: 'Resize Elements panel' })).toBeInTheDocument();

    rerender(<WorkspaceElementsPanel {...panelProps} visible={false} model={model('main')} />);

    expect(
      screen.queryByRole('separator', { name: 'Resize Elements panel' })
    ).not.toBeInTheDocument();
  });
});
