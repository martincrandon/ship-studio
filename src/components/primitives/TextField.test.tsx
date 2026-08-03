import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextField } from './TextField';

describe('TextField', () => {
  it('forwards input behavior and supports the compact suffix slot', () => {
    render(<TextField aria-label="Width" defaultValue="auto" suffix="px" />);

    const field = screen.getByRole('textbox', { name: 'Width' });
    expect(field).toHaveValue('auto');
    expect(screen.getByText('px')).toBeInTheDocument();

    fireEvent.change(field, { target: { value: '480' } });
    expect(field).toHaveValue('480');
  });

  it('exposes invalid state through a stable class', () => {
    render(<TextField aria-label="Value" invalid />);

    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveClass('ss-text-field--invalid');
  });
});
