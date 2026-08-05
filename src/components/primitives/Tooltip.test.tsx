import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip, TooltipProvider } from './Tooltip';

describe('Tooltip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('promotes native title text to the shared tooltip surface', () => {
    render(
      <TooltipProvider>
        <button title="A shared tooltip">Hover me</button>
      </TooltipProvider>
    );

    const trigger = screen.getByRole('button', { name: 'Hover me' });
    fireEvent.pointerOver(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    void act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    void act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent('A shared tooltip');
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('data-tooltip-content', 'A shared tooltip');
  });

  it('removes a native title when shared content is already present', async () => {
    render(
      <TooltipProvider>
        <button data-tooltip-content="Shared content" title="Native content">
          Hover me
        </button>
      </TooltipProvider>
    );

    const trigger = screen.getByRole('button', { name: 'Hover me' });
    expect(trigger).not.toHaveAttribute('title');

    await act(async () => {
      trigger.setAttribute('title', 'Native content restored by React');
      await Promise.resolve();
    });

    expect(trigger).not.toHaveAttribute('title');
  });

  it('supports explicit content without changing the trigger element', () => {
    render(
      <TooltipProvider>
        <Tooltip content="Explicit content">
          <button>Trigger</button>
        </Tooltip>
      </TooltipProvider>
    );

    const trigger = screen.getByRole('button', { name: 'Trigger' });
    fireEvent.pointerOver(trigger);
    void act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent('Explicit content');
    expect(trigger.tagName).toBe('BUTTON');
  });

  it('supports a faster delay override for high-density tooltip grids', () => {
    render(
      <TooltipProvider>
        <Tooltip content="Fast content" delayMs={150}>
          <button>Trigger</button>
        </Tooltip>
      </TooltipProvider>
    );

    fireEvent.pointerOver(screen.getByRole('button', { name: 'Trigger' }));
    void act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    void act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent('Fast content');
  });

  it('suppresses the custom tooltip for the embedded preview iframe', () => {
    render(
      <TooltipProvider>
        <iframe title="Preview" data-testid="live-preview" data-tooltip-disabled />
      </TooltipProvider>
    );

    fireEvent.pointerOver(screen.getByTestId('live-preview'));
    void act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-preview')).not.toHaveAttribute('title');
  });
});
