import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockablePanel } from './DockablePanel';

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('DockablePanel', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 520,
      bottom: 680,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    });
    localStorage.clear();
  });

  it('keeps its child mounted while moving between the dock and a floating surface', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const clicked = vi.fn();

    function StatefulChild() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return (
        <div data-dockable-drag-handle>
          Live terminal
          <button type="button" onClick={clicked}>
            Pin
          </button>
        </div>
      );
    }

    const props = {
      ariaLabel: 'Test panel',
      positionKey: 'testPanelPosition',
      sizeKey: 'testPanelSize',
      floatingSize: { width: 360, height: 520 },
      initialPosition: () => ({ left: 40, top: 60 }),
    };
    const { container, rerender, unmount } = render(
      <DockablePanel {...props} docked>
        <StatefulChild />
      </DockablePanel>
    );

    const surface = screen.getByLabelText('Test panel');
    const placeholder = container.querySelector('.dockable-panel__placeholder');
    expect(surface).toHaveClass('dockable-panel__surface--docked');
    expect(placeholder).toHaveClass('dockable-panel__placeholder--docked');
    expect(surface).toHaveStyle({ left: '120px', top: '80px', width: '400px', height: '600px' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Pin' }), { pointerId: 2 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Pin' }), { pointerId: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(clicked).toHaveBeenCalledTimes(1);

    rerender(
      <DockablePanel {...props} docked={false}>
        <StatefulChild />
      </DockablePanel>
    );

    expect(screen.getByLabelText('Test panel')).toBe(surface);
    expect(surface).toHaveClass('dockable-panel__surface--floating');
    expect(placeholder).toHaveClass('dockable-panel__placeholder--floating');
    expect(surface).toHaveStyle({ width: '400px', height: '600px' });
    expect(localStorage.getItem('testPanelSize')).toBe('{"width":400,"height":600}');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Pin' }), { pointerId: 3 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Pin' }), { pointerId: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(clicked).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Test panel width' }), {
      key: 'ArrowRight',
    });
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Test panel height' }), {
      key: 'ArrowUp',
    });
    expect(surface).toHaveStyle({ width: '410px', height: '590px' });
    expect(localStorage.getItem('testPanelSize')).toBe('{"width":410,"height":590}');

    const heightHandle = screen.getByRole('separator', { name: 'Resize Test panel height' });
    fireEvent.pointerDown(heightHandle, { pointerId: 7, clientY: 650 });
    fireEvent.pointerMove(heightHandle, { pointerId: 7, clientY: 620 });
    fireEvent.pointerUp(heightHandle, { pointerId: 7, clientY: 620 });
    expect(surface).toHaveStyle({ height: '560px' });

    // A completed drag must not leave a move listener behind.
    fireEvent.pointerMove(heightHandle, { pointerId: 7, clientY: 500 });
    expect(surface).toHaveStyle({ height: '560px' });
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    const widthHandle = screen.getByRole('separator', { name: 'Resize Test panel width' });
    fireEvent.pointerDown(widthHandle, { pointerId: 8, clientX: 450 });
    fireEvent.pointerMove(widthHandle, { pointerId: 8, clientX: 500 });
    fireEvent.pointerUp(widthHandle, { pointerId: 8, clientX: 500 });
    expect(surface).toHaveStyle({ width: '460px' });

    fireEvent.pointerMove(widthHandle, { pointerId: 8, clientX: 600 });
    expect(surface).toHaveStyle({ width: '460px' });

    const cornerHandle = screen.getByRole('button', {
      name: 'Resize Test panel width and height',
    });
    fireEvent.pointerDown(cornerHandle, { pointerId: 9, clientX: 500, clientY: 620 });
    expect(document.body.style.cursor).toBe('nwse-resize');
    fireEvent.pointerMove(cornerHandle, { pointerId: 9, clientX: 540, clientY: 650 });
    fireEvent.pointerUp(cornerHandle, { pointerId: 9, clientX: 540, clientY: 650 });
    expect(surface).toHaveStyle({ width: '500px', height: '590px' });

    fireEvent.pointerMove(cornerHandle, { pointerId: 9, clientX: 700, clientY: 700 });
    expect(surface).toHaveStyle({ width: '500px', height: '590px' });
    expect(document.body.style.cursor).toBe('');

    fireEvent.pointerDown(screen.getByText('Live terminal'), {
      pointerId: 1,
      clientX: 130,
      clientY: 90,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 150, clientY: 170 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 170 });
    expect(localStorage.getItem('testPanelPosition')).toBe('{"left":140,"top":160}');

    rerender(
      <DockablePanel {...props} docked>
        <StatefulChild />
      </DockablePanel>
    );
    expect(screen.getByLabelText('Test panel')).toBe(surface);
    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(
      <DockablePanel {...props} docked={false} visible={false}>
        <StatefulChild />
      </DockablePanel>
    );
    expect(surface).toHaveClass('is-hidden');
    expect(surface).toHaveAttribute('aria-hidden', 'true');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    unmount();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it('supports every independent docked/floating combination', () => {
    const mounted = [vi.fn(), vi.fn(), vi.fn()];
    const labels = ['Agent', 'Elements', 'CSS'];

    function PanelChild({ index }: { index: number }) {
      useEffect(() => {
        mounted[index]();
      }, [index]);
      return <div>{labels[index]}</div>;
    }

    function Panels({ mask }: { mask: number }) {
      return labels.map((label, index) => (
        <DockablePanel
          key={label}
          docked={(mask & (1 << index)) !== 0}
          ariaLabel={`${label} panel`}
          positionKey={`${label}Position`}
          sizeKey={`${label}Size`}
          floatingSize={{ width: 300, height: 400 }}
          initialPosition={() => ({ left: 40 + index * 20, top: 60 + index * 20 })}
        >
          <PanelChild index={index} />
        </DockablePanel>
      ));
    }

    const { rerender } = render(<Panels mask={0} />);
    for (let mask = 0; mask < 8; mask += 1) {
      rerender(<Panels mask={mask} />);
      labels.forEach((label, index) => {
        expect(screen.getByLabelText(`${label} panel`)).toHaveClass(
          (mask & (1 << index)) !== 0
            ? 'dockable-panel__surface--docked'
            : 'dockable-panel__surface--floating'
        );
      });
    }

    mounted.forEach((onMount) => expect(onMount).toHaveBeenCalledTimes(1));
  });
});
