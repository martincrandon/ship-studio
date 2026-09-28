import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasCameraState } from '../../../lib/components/canvas-camera';
import { CanvasRulersOverlay } from './CanvasRulersOverlay';
import type { ComponentCanvasGuide } from '../../../lib/components/canvas';

const camera: CanvasCameraState = { x: 0, y: 0, zoom: 1 };

function mockCanvasRect() {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function dispatchPointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY: number; pointerId: number; button?: number }
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  element.dispatchEvent(event);
}

describe('CanvasRulersOverlay', () => {
  it('renders sparse coordinate ticks and selected range endpoint labels on both axes', () => {
    render(
      <CanvasRulersOverlay
        camera={{ x: 120, y: 80, zoom: 1 }}
        guides={[]}
        selectedGuideId={null}
        visible
        viewport={{ width: 640, height: 480 }}
        selectedBounds={{ x: -40, y: -20, width: 160, height: 100 }}
        onGuidesChange={vi.fn()}
        onSelectGuide={vi.fn()}
      />
    );

    expect(
      screen.getByTestId('component-canvas-ruler-boundary-horizontal-start')
    ).toHaveTextContent('-40');
    expect(screen.getByTestId('component-canvas-ruler-boundary-horizontal-end')).toHaveTextContent(
      '120'
    );
    expect(screen.getByTestId('component-canvas-ruler-boundary-vertical-start')).toHaveTextContent(
      '-20'
    );
    expect(screen.getByTestId('component-canvas-ruler-boundary-vertical-end')).toHaveTextContent(
      '80'
    );
    expect(document.querySelectorAll('.component-canvas-ruler-label').length).toBeGreaterThan(0);
    expect(
      document.querySelectorAll('.component-canvas-ruler-tick.is-major').length
    ).toBeGreaterThan(0);
    expect(
      document.querySelectorAll('.component-canvas-ruler-tick:not(.is-major)').length
    ).toBeGreaterThan(0);
    expect(document.querySelector('.component-canvas-ruler-selection--horizontal')).toBeTruthy();
    expect(document.querySelector('.component-canvas-ruler-selection--vertical')).toBeTruthy();
    expect(
      document.querySelectorAll('.component-canvas-ruler-tick.is-selected').length
    ).toBeGreaterThan(0);
  });

  it('marks active reposition ranges without changing the endpoint geometry', () => {
    const props = {
      camera,
      guides: [] as ComponentCanvasGuide[],
      selectedGuideId: null,
      visible: true,
      viewport: { width: 400, height: 300 },
      selectedBounds: { x: 40, y: 50, width: 100, height: 120 },
      onGuidesChange: vi.fn(),
      onSelectGuide: vi.fn(),
    };
    const { rerender } = render(<CanvasRulersOverlay {...props} />);
    expect(screen.getByTestId('component-canvas-rulers')).not.toHaveAttribute(
      'data-selection-active'
    );
    const startPosition = screen.getByTestId('component-canvas-ruler-boundary-horizontal-start')
      .style.left;
    rerender(<CanvasRulersOverlay {...props} selectionActive />);
    expect(screen.getByTestId('component-canvas-rulers')).toHaveAttribute(
      'data-selection-active',
      'true'
    );
    expect(screen.getByTestId('component-canvas-ruler-boundary-horizontal-start').style.left).toBe(
      startPosition
    );
  });

  it('creates a persisted horizontal guide after the drag threshold', () => {
    const onGuidesChange = vi.fn();
    const onSelectGuide = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={onSelectGuide}
      />
    );

    const ruler = screen.getByRole('button', { name: 'Create horizontal guide' });
    expect(ruler).toBeInTheDocument();
    act(() => {
      dispatchPointer(ruler, 'pointerdown', { pointerId: 1, clientX: 120, clientY: 20 });
      dispatchPointer(ruler, 'pointermove', { pointerId: 1, clientX: 120, clientY: 80 });
      dispatchPointer(ruler, 'pointerup', { pointerId: 1, clientX: 120, clientY: 80 });
    });

    expect(onSelectGuide).toHaveBeenCalled();
    expect(onGuidesChange).toHaveBeenCalledWith([
      expect.objectContaining({ orientation: 'horizontal', position: 80 }),
    ]);
    expect(onSelectGuide).toHaveBeenLastCalledWith(expect.any(String));
    rect.mockRestore();
  });

  it('renders an existing guide at its draft position while dragging', () => {
    const guide: ComponentCanvasGuide = {
      id: 'guide-1',
      orientation: 'vertical',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );

    const line = screen.getByRole('button', { name: /vertical guide at 40/i });
    act(() => {
      dispatchPointer(line, 'pointerdown', { pointerId: 2, clientX: 40, clientY: 120 });
      dispatchPointer(line, 'pointermove', { pointerId: 2, clientX: 100, clientY: 120 });
    });
    expect(line).toHaveStyle({ left: '100px' });
    act(() => {
      dispatchPointer(line, 'pointerup', { pointerId: 2, clientX: 100, clientY: 120 });
    });
    expect(onGuidesChange).toHaveBeenCalledWith([{ ...guide, position: 100 }]);
    rect.mockRestore();
  });

  it('deletes an existing guide when it is dragged back onto its home ruler', () => {
    const guide: ComponentCanvasGuide = {
      id: 'guide-1',
      orientation: 'vertical',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const onSelectGuide = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={onSelectGuide}
      />
    );

    const line = screen.getByRole('button', { name: /vertical guide at 40/i });
    act(() => {
      dispatchPointer(line, 'pointerdown', { pointerId: 3, clientX: 40, clientY: 120 });
      dispatchPointer(line, 'pointermove', { pointerId: 3, clientX: 100, clientY: 120 });
      dispatchPointer(line, 'pointermove', { pointerId: 3, clientX: 10, clientY: 120 });
      dispatchPointer(line, 'pointerup', { pointerId: 3, clientX: 10, clientY: 120 });
    });

    expect(onGuidesChange).toHaveBeenLastCalledWith([]);
    expect(onSelectGuide).toHaveBeenLastCalledWith(null);
    rect.mockRestore();
  });

  it('deletes an existing guide when it is dragged outside the canvas', () => {
    const guide: ComponentCanvasGuide = {
      id: 'guide-1',
      orientation: 'vertical',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const onSelectGuide = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={onSelectGuide}
      />
    );

    const line = screen.getByRole('button', { name: /vertical guide at 40/i });
    act(() => {
      dispatchPointer(line, 'pointerdown', { pointerId: 4, clientX: 40, clientY: 120 });
      dispatchPointer(line, 'pointermove', { pointerId: 4, clientX: 420, clientY: 120 });
      dispatchPointer(line, 'pointerup', { pointerId: 4, clientX: 420, clientY: 120 });
    });

    expect(onGuidesChange).toHaveBeenLastCalledWith([]);
    expect(onSelectGuide).toHaveBeenLastCalledWith(null);
    rect.mockRestore();
  });

  it('deletes the selected guide from the keyboard', () => {
    const guide: ComponentCanvasGuide = {
      id: 'guide-1',
      orientation: 'horizontal',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={guide.id}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );

    const line = screen.getByRole('button', { name: /horizontal guide at 40/i });
    fireEvent.keyDown(line, { key: 'Delete' });

    expect(onGuidesChange).toHaveBeenCalledWith([]);
    rect.mockRestore();
  });

  it('focuses a clicked guide so Backspace deletes the selected guide', () => {
    const guide: ComponentCanvasGuide = {
      id: 'guide-1',
      orientation: 'vertical',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );

    const line = screen.getByRole('button', { name: /vertical guide at 40/i });
    fireEvent.pointerDown(line, { pointerId: 5, clientX: 40, clientY: 120 });
    expect(line).toHaveFocus();

    fireEvent.keyDown(line, { key: 'Backspace' });

    expect(onGuidesChange).toHaveBeenCalledWith([]);
    rect.mockRestore();
  });

  it('does not start a guide drag from a secondary pointer button', () => {
    const guide: ComponentCanvasGuide = {
      id: 'guide-1',
      orientation: 'vertical',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );

    const line = screen.getByRole('button', { name: /vertical guide at 40/i });
    act(() => {
      dispatchPointer(line, 'pointerdown', {
        pointerId: 6,
        clientX: 40,
        clientY: 120,
        button: 2,
      });
      dispatchPointer(line, 'pointermove', { pointerId: 6, clientX: 100, clientY: 120 });
      dispatchPointer(line, 'pointerup', { pointerId: 6, clientX: 100, clientY: 120 });
    });

    expect(line).toHaveStyle({ left: '40px' });
    expect(onGuidesChange).not.toHaveBeenCalled();
    rect.mockRestore();
  });

  it('does not create a new guide when the drag returns to the ruler', () => {
    const onGuidesChange = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );

    const ruler = screen.getByRole('button', { name: 'Create horizontal guide' });
    act(() => {
      dispatchPointer(ruler, 'pointerdown', { pointerId: 4, clientX: 120, clientY: 20 });
      dispatchPointer(ruler, 'pointermove', { pointerId: 4, clientX: 120, clientY: 90 });
      dispatchPointer(ruler, 'pointermove', { pointerId: 4, clientX: 120, clientY: 10 });
      dispatchPointer(ruler, 'pointerup', { pointerId: 4, clientX: 120, clientY: 10 });
    });

    expect(onGuidesChange).not.toHaveBeenCalled();
    rect.mockRestore();
  });

  it('keeps the visible rulers full-size while ending guide hit areas before panel resize handles', () => {
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[]}
        selectedGuideId={null}
        visible
        onGuidesChange={vi.fn()}
        onSelectGuide={vi.fn()}
      />
    );

    expect(screen.getByTestId('component-canvas-ruler-surface-horizontal')).toBeInTheDocument();
    expect(screen.getByTestId('component-canvas-ruler-surface-vertical')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create horizontal guide' })).toHaveClass(
      'component-canvas-ruler-hit-area--horizontal'
    );
    expect(screen.getByRole('button', { name: 'Create vertical guide' })).toHaveClass(
      'component-canvas-ruler-hit-area--vertical'
    );
  });

  it('keeps locked guides immovable and blocks input while editing', () => {
    const guide: ComponentCanvasGuide = {
      id: 'locked-guide',
      orientation: 'horizontal',
      position: 40,
      locked: true,
    };
    const onGuidesChange = vi.fn();
    const rect = mockCanvasRect();
    const { rerender } = render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        interactionBlocked
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: /Create horizontal/i }));
    expect(onGuidesChange).not.toHaveBeenCalled();

    rerender(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        onGuidesChange={onGuidesChange}
        onSelectGuide={vi.fn()}
      />
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /Locked horizontal guide/i }), {
      key: 'Backspace',
    });
    expect(onGuidesChange).not.toHaveBeenCalled();
    rect.mockRestore();
  });

  it('blocks existing guide pointer input while interaction is blocked', () => {
    const guide: ComponentCanvasGuide = {
      id: 'blocked-guide',
      orientation: 'vertical',
      position: 40,
    };
    const onGuidesChange = vi.fn();
    const onSelectGuide = vi.fn();
    const rect = mockCanvasRect();
    render(
      <CanvasRulersOverlay
        camera={camera}
        guides={[guide]}
        selectedGuideId={null}
        visible
        interactionBlocked
        onGuidesChange={onGuidesChange}
        onSelectGuide={onSelectGuide}
      />
    );

    const line = screen.getByRole('button', { name: /vertical guide at 40/i });
    fireEvent.pointerDown(line, { pointerId: 4, clientX: 40, clientY: 120 });
    fireEvent.pointerMove(line, { pointerId: 4, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(line, { pointerId: 4, clientX: 120, clientY: 120 });

    expect(onGuidesChange).not.toHaveBeenCalled();
    expect(onSelectGuide).not.toHaveBeenCalled();
    expect(screen.getByTestId('component-canvas-rulers')).toHaveAttribute('aria-disabled', 'true');
    rect.mockRestore();
  });
});
