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

  it('keeps unsupported and complex values intact', () => {
    expect(splitValueFieldValue('clamp(10px, 5vw, 20rem)', [])).toEqual({
      text: 'clamp(10px, 5vw, 20rem)',
      unit: '',
    });
  });
});
