import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasSelectionOverlay } from './CanvasSelectionOverlay';

describe('CanvasSelectionOverlay visual affordances', () => {
  it('owns one crisp screen-space title per artboard and projects it independently of zoom', () => {
    const titleNodes = [{ id: 'node', name: 'Card', x: 20, y: 30, width: 320, height: 480 }];
    const { rerender } = render(
      <CanvasSelectionOverlay
        nodes={titleNodes}
        titleNodes={titleNodes}
        selectedIds={['node']}
        camera={{ x: 10, y: 15, zoom: 1 }}
      />
    );

    const title = screen.getByTestId('component-canvas-node-title-node');
    expect(screen.getAllByText('Card')).toHaveLength(1);
    expect(title).toHaveStyle({ left: '30px', top: '45px', maxWidth: '320px' });
    expect(title).toHaveClass('component-canvas-node-title', 'is-selected');

    rerender(
      <CanvasSelectionOverlay
        nodes={titleNodes}
        titleNodes={titleNodes}
        selectedIds={['node']}
        camera={{ x: 10, y: 15, zoom: 2 }}
      />
    );
    expect(screen.getByTestId('component-canvas-node-title-node')).toHaveStyle({
      left: '50px',
      top: '75px',
      maxWidth: '640px',
    });
  });

  it('keeps one title per visible artboard even when the selection is empty', () => {
    const titleNodes = [
      { id: 'one', name: 'One', x: 0, y: 0, width: 100, height: 100 },
      { id: 'two', name: 'Two', x: 200, y: 0, width: 100, height: 100 },
    ];
    render(<CanvasSelectionOverlay nodes={[]} titleNodes={titleNodes} selectedIds={[]} />);
    expect(screen.getAllByRole('button', { name: /Rename/ })).toHaveLength(2);
    expect(screen.queryByTestId('component-canvas-selection-overlay')).not.toBeInTheDocument();
  });

  it('shows a non-interactive snapshot status beside the component name', () => {
    const titleNodes = [
      { id: 'node', name: 'Card', x: 20, y: 30, width: 320, height: 480, snapshot: true },
    ];
    render(<CanvasSelectionOverlay nodes={titleNodes} titleNodes={titleNodes} selectedIds={[]} />);

    const title = screen.getByTestId('component-canvas-node-title-node');
    const status = screen.getByTestId('component-canvas-node-title-snapshot-node');
    expect(status).toHaveTextContent('Snapshot');
    expect(status).toHaveAttribute('aria-hidden', 'true');
    expect(status).toHaveClass('component-canvas-node-title__snapshot');
    expect(title).toHaveAccessibleName('Rename Card, snapshot');
  });

  it('starts moving from the component name label', () => {
    const onTitlePointerDown = vi.fn();
    const titleNodes = [{ id: 'node', name: 'Card', x: 20, y: 30, width: 320, height: 480 }];
    render(
      <CanvasSelectionOverlay
        nodes={titleNodes}
        titleNodes={titleNodes}
        selectedIds={[]}
        onTitlePointerDown={onTitlePointerDown}
      />
    );

    fireEvent.pointerDown(screen.getByTestId('component-canvas-node-title-node'));
    expect(onTitlePointerDown).toHaveBeenCalledWith(expect.anything(), 'node');
  });

  it('renames on an unmodified double click, commits on Enter, and cancels on Escape', () => {
    const onTitleRename = vi.fn();
    const titleNodes = [{ id: 'node', name: 'Card', x: 20, y: 30, width: 320, height: 480 }];
    render(
      <CanvasSelectionOverlay
        nodes={titleNodes}
        titleNodes={titleNodes}
        selectedIds={['node']}
        onTitleRename={onTitleRename}
      />
    );

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename Card' }));
    const title = screen.getByTestId('component-canvas-node-title-node');
    const input = screen.getByRole('textbox', { name: 'Rename Card' });
    expect(title).toHaveClass('is-editing');
    expect(input).toHaveValue('Card');
    expect(input).toHaveAttribute('size', '1');
    expect(title).toHaveAttribute('data-editing-value', 'Card');
    fireEvent.change(input, { target: { value: 'Feature card' } });
    expect(title).toHaveAttribute('data-editing-value', 'Feature card');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onTitleRename).toHaveBeenCalledWith('node', 'Feature card');

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename Card' }));
    const cancelInput = screen.getByRole('textbox', { name: 'Rename Card' });
    fireEvent.change(cancelInput, { target: { value: 'Cancelled name' } });
    fireEvent.keyDown(cancelInput, { key: 'Escape' });
    expect(onTitleRename).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename Card' }));
    const blurInput = screen.getByRole('textbox', { name: 'Rename Card' });
    fireEvent.change(blurInput, { target: { value: 'Saved on blur' } });
    fireEvent.pointerDown(document.body);
    expect(onTitleRename).toHaveBeenCalledWith('node', 'Saved on blur');
  });

  it('does not enter rename while a selection modifier is held', () => {
    const titleNodes = [{ id: 'node', name: 'Card', x: 0, y: 0, width: 320, height: 480 }];
    render(
      <CanvasSelectionOverlay nodes={titleNodes} titleNodes={titleNodes} selectedIds={['node']} />
    );
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename Card' }), { shiftKey: true });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps all resize hit zones accessible while marking only corners visible', () => {
    render(
      <CanvasSelectionOverlay
        nodes={[{ id: 'node', x: 32, y: 32, width: 320, height: 480 }]}
        selectedIds={['node']}
        onResizeStart={vi.fn()}
      />
    );

    const handles = screen.getAllByRole('button', { name: /Resize selection/ });
    expect(handles).toHaveLength(8);
    expect(
      handles.filter((handle) => handle.dataset.canvasHandleVisibility === 'visible')
    ).toHaveLength(4);
    expect(
      handles.filter((handle) => handle.dataset.canvasHandleVisibility === 'hit-zone')
    ).toHaveLength(4);
  });

  it('places invisible rotation hit zones around each corner instead of visible controls', () => {
    const onResizeStart = vi.fn();
    render(
      <CanvasSelectionOverlay
        nodes={[{ id: 'node', x: 32, y: 32, width: 320, height: 480 }]}
        selectedIds={['node']}
        onResizeStart={onResizeStart}
      />
    );

    const rotateHandles = screen.getAllByRole('button', { name: /Rotate selection from/ });
    expect(rotateHandles).toHaveLength(4);
    expect(rotateHandles.every((handle) => handle.dataset.canvasHandleKind === 'rotate')).toBe(
      true
    );
    expect(
      rotateHandles.every((handle) => handle.dataset.canvasHandleVisibility === 'hit-zone')
    ).toBe(true);
    expect(rotateHandles.every((handle) => handle.childElementCount === 0)).toBe(true);
    expect(rotateHandles.every((handle) => handle.className.includes('--rotate-'))).toBe(true);
    fireEvent.pointerDown(rotateHandles[0]);
    expect(onResizeStart).toHaveBeenCalledWith(expect.anything(), 'rotate');
  });
});
