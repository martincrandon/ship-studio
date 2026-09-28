import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CanvasToolbar } from './CanvasToolbar';

describe('CanvasToolbar', () => {
  it('uses icon-only controls for canvas actions', () => {
    render(
      <CanvasToolbar
        zoom={1.22}
        onZoomOut={vi.fn()}
        onZoomIn={vi.fn()}
        onZoomChange={vi.fn()}
        onFit={vi.fn()}
        onFitSelection={vi.fn()}
        rulersControl={<button type="button">Rulers</button>}
      />
    );

    expect(screen.getByText('122%')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Zoom controls' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Fit controls' })).toContainElement(
      screen.getByRole('button', { name: 'Rulers' })
    );
    for (const label of ['Zoom out', 'Zoom in', 'Fit scene', 'Fit selection']) {
      expect(screen.getByRole('button', { name: label })).toHaveClass(
        'button--icon-only',
        'button--size-default'
      );
    }
    expect(screen.getByRole('button', { name: 'Zoom out' }).querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/zoom-out.svg'
    );
    expect(screen.getByRole('button', { name: 'Zoom in' }).querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/zoom-in.svg'
    );
  });

  it('turns the zoom readout into a percentage field and commits the typed value', async () => {
    const onZoomChange = vi.fn();
    const user = userEvent.setup();

    render(
      <CanvasToolbar
        zoom={1.22}
        onZoomOut={vi.fn()}
        onZoomIn={vi.fn()}
        onZoomChange={onZoomChange}
        onFit={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Zoom 122%' }));
    const input = screen.getByRole('textbox', { name: 'Zoom percentage' });

    expect(input).toHaveValue('122');

    await user.clear(input);
    await user.type(input, '150%');
    await user.keyboard('{Enter}');

    expect(onZoomChange).toHaveBeenCalledWith(1.5);
  });
});
