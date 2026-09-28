import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_LAYERS_DROP_THRESHOLD_PX,
  CanvasLayersPanel,
  canvasLayerDropPosition,
  visibleCanvasLayers,
  type CanvasLayerItem,
} from './CanvasLayersPanel';

const layers: CanvasLayerItem[] = [
  { id: 'parent', name: 'Parent', expanded: true },
  { id: 'child', name: 'Child', parentId: 'parent' },
  { id: 'top', name: 'Top layer' },
];

describe('CanvasLayersPanel', () => {
  it('renders reversed visual order with accessible tree semantics and range selection', () => {
    const onSelectionChange = vi.fn();
    render(
      <CanvasLayersPanel layers={layers} selectedIds={[]} onSelectionChange={onSelectionChange} />
    );

    expect(visibleCanvasLayers(layers).map((layer) => layer.id)).toEqual([
      'top',
      'parent',
      'child',
    ]);
    expect(screen.getByRole('tree', { name: 'Components' })).toHaveAttribute(
      'aria-multiselectable',
      'true'
    );
    expect(document.querySelectorAll('[data-icon-name="ComponentsIcon"]')).toHaveLength(3);
    expect(
      document.querySelector('.canvas-layers-panel__header [data-icon-name="ComponentsIcon"]')
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('treeitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Top layer'),
      expect.stringContaining('Parent'),
      expect.stringContaining('Child'),
    ]);
    expect(screen.getByText('Top layer').closest('[role="treeitem"]')).toHaveAttribute(
      'aria-posinset',
      '1'
    );
    expect(screen.getByText('Top layer').closest('[role="treeitem"]')).toHaveAttribute(
      'aria-setsize',
      '2'
    );
    expect(screen.getByText('Child').closest('[role="treeitem"]')).toHaveAttribute(
      'aria-setsize',
      '1'
    );

    fireEvent.click(screen.getByText('Top layer'));
    fireEvent.click(screen.getByText('Child'), { shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['top', 'parent', 'child']);
  });

  it('keeps disconnected parent cycles visible as fallback roots', () => {
    const cyclicLayers: CanvasLayerItem[] = [
      { id: 'header', name: 'Header' },
      { id: 'nav', name: 'Navigation', parentId: 'link' },
      { id: 'link', name: 'Link', parentId: 'nav' },
    ];

    expect(visibleCanvasLayers(cyclicLayers).map((layer) => layer.id)).toEqual([
      'header',
      'link',
      'nav',
    ]);
  });

  it('renders every flat canvas layer', () => {
    const flatLayers = Array.from({ length: 8 }, (_, index) => ({
      id: `layer-${index}`,
      name: `Component ${index + 1}`,
    }));

    render(<CanvasLayersPanel layers={flatLayers} selectedIds={[]} onSelectionChange={vi.fn()} />);

    expect(screen.getAllByRole('treeitem')).toHaveLength(8);
  });

  it('supports modifier toggles, expansion, rename, and visibility intents', () => {
    const onSelectionChange = vi.fn();
    const onToggleExpanded = vi.fn();
    const onRename = vi.fn();
    const onToggleVisibility = vi.fn();
    const onToggleLock = vi.fn();
    render(
      <CanvasLayersPanel
        layers={layers}
        selectedIds={['top']}
        onSelectionChange={onSelectionChange}
        onToggleExpanded={onToggleExpanded}
        onRename={onRename}
        onToggleVisibility={onToggleVisibility}
        onToggleLock={onToggleLock}
      />
    );

    fireEvent.click(screen.getByText('Parent'), { ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['top', 'parent']);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Parent' }));
    expect(onToggleExpanded).toHaveBeenCalledWith('parent', false);
    expect(screen.queryByText('Child')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('Top layer'));
    const rename = screen.getByRole('textbox', { name: 'Rename Top layer' });
    fireEvent.change(rename, { target: { value: 'Renamed layer' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('top', 'Renamed layer');

    fireEvent.click(screen.getByRole('button', { name: 'Hide Top layer' }));
    expect(onToggleVisibility).toHaveBeenCalledWith('top', false);
    fireEvent.click(screen.getByRole('button', { name: 'Lock Top layer' }));
    expect(onToggleLock).toHaveBeenCalledWith('top', true);
  });

  it('uses the same pressed-state styling contract for visibility and lock controls', () => {
    render(
      <CanvasLayersPanel
        layers={[
          { id: 'visible', name: 'Visible' },
          { id: 'hidden', name: 'Hidden', visible: false },
        ]}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Hide Visible' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Show Hidden' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Lock Visible' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Lock Hidden' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('keeps keyboard navigation and drop intent geometry deterministic', () => {
    const onSelectionChange = vi.fn();
    const onDropIntent = vi.fn();
    render(
      <CanvasLayersPanel
        layers={layers}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
        onDropIntent={onDropIntent}
      />
    );

    const top = screen.getByText('Top layer').closest('[role="treeitem"]') as HTMLElement;
    fireEvent.focus(top);
    fireEvent.keyDown(top, { key: 'ArrowDown' });
    const focusedRow = document.activeElement;
    expect(focusedRow).toHaveAttribute('data-canvas-layer-id', 'parent');
    if (!(focusedRow instanceof HTMLElement)) {
      throw new Error('Expected keyboard focus to move to the parent layer row');
    }

    fireEvent.keyDown(focusedRow, { key: 'ArrowDown', shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['parent', 'child']);

    expect(canvasLayerDropPosition(0, 32, true)).toBe('before');
    expect(canvasLayerDropPosition(CANVAS_LAYERS_DROP_THRESHOLD_PX, 32, true)).toBe('before');
    expect(canvasLayerDropPosition(16, 32, true)).toBe('into');
    expect(canvasLayerDropPosition(32, 32, true)).toBe('after');

    expect(onDropIntent).not.toHaveBeenCalled();
  });

  it('emits before, after, and into drop intents without owning hierarchy validation', () => {
    const onDropIntent = vi.fn();
    render(
      <CanvasLayersPanel
        layers={layers}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
        onDropIntent={onDropIntent}
      />
    );

    const source = screen.getByText('Top layer').closest('[role="treeitem"]') as HTMLElement;
    const target = screen.getByText('Parent').closest('[role="treeitem"]') as HTMLElement;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 132,
      height: 32,
      left: 0,
      right: 320,
      width: 320,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => 'top'),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 116 });
    fireEvent.drop(target, { dataTransfer, clientY: 131 });

    expect(onDropIntent).toHaveBeenCalledWith({
      draggedId: 'top',
      targetId: 'parent',
      position: 'after',
    });
  });
});
