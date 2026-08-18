import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ValueField, splitValueFieldValue } from './ValueField';

describe('ValueField', () => {
  it('keeps the format menu open when activated from the focused input', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Width" variant="length" value="12px" onCommit={onCommit} />);

    const input = screen.getByRole('textbox', { name: 'Width' });
    const trigger = screen.getByRole('button', { name: 'Width format' });
    await user.click(input);
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Width formats' })).toBeVisible();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('splits a typed unit from the editable magnitude on Enter', () => {
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Width" variant="length" value="auto" onCommit={onCommit} />);

    const input = screen.getByRole('textbox', { name: 'Width' });
    fireEvent.change(input, { target: { value: '12px' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('12px');
    expect(input).toHaveValue('12');
    expect(screen.getByRole('button', { name: 'Width format' })).toHaveTextContent('PX');
  });

  it('changes the format without changing the magnitude', () => {
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Height" variant="length" value="24px" onCommit={onCommit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Height format' }));
    fireEvent.click(screen.getByRole('option', { name: '%' }));

    expect(onCommit).toHaveBeenCalledWith('24%');
    expect(screen.getByRole('textbox', { name: 'Height' })).toHaveValue('24');
    expect(screen.getByRole('button', { name: 'Height format' })).toHaveTextContent('%');
  });

  it('focuses the selected option and supports listbox keyboard selection', () => {
    const onCommit = vi.fn(() => true);
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={onCommit} />);

    const trigger = screen.getByRole('button', { name: 'Width format' });
    fireEvent.click(trigger);

    const selected = screen.getByRole('option', { name: 'PX' });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected).toHaveFocus();

    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    const percent = screen.getByRole('option', { name: '%' });
    expect(percent).toHaveFocus();

    fireEvent.keyDown(percent, { key: 'End' });
    const last = screen.getByRole('option', { name: 'SVH' });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Home' });
    const empty = screen.getByRole('option', { name: '-' });
    expect(empty).toHaveFocus();

    fireEvent.keyDown(empty, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('option', { name: 'PX' }), { key: 'ArrowDown' });
    fireEvent.keyDown(percent, { key: ' ' });
    expect(onCommit).toHaveBeenCalledWith('24%');
    expect(screen.getByRole('textbox', { name: 'Width' })).toHaveFocus();
  });

  it('opens from the trigger keyboard and restores trigger focus on Escape', () => {
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Width format' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const selected = screen.getByRole('option', { name: 'PX' });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('dismisses the portaled listbox on an outside pointer event', async () => {
    render(<ValueField aria-label="Width" variant="length" value="24px" onCommit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Width format' }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps unsupported and complex values intact', () => {
    expect(splitValueFieldValue('clamp(10px, 5vw, 20rem)', [])).toEqual({
      text: 'clamp(10px, 5vw, 20rem)',
      unit: '',
    });
  });
});
