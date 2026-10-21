import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchField } from './SearchField';

describe('SearchField', () => {
  it('forwards the input ref, reports controlled changes, and clears accessibly', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const { rerender } = render(
      <SearchField
        ref={ref}
        value=""
        onChange={onChange}
        aria-label="Search project files"
        placeholder="Search files..."
      />
    );

    const input = screen.getByRole('searchbox', { name: 'Search project files' });
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute('placeholder', 'Search files...');
    fireEvent.change(input, { target: { value: 'tokens.css' } });
    expect(onChange).toHaveBeenCalledWith('tokens.css');

    rerender(
      <SearchField
        ref={ref}
        value="tokens.css"
        onChange={onChange}
        aria-label="Search project files"
        placeholder="Search files..."
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenLastCalledWith('');

    rerender(
      <SearchField
        ref={ref}
        value="tokens.css"
        onChange={onChange}
        aria-label="Search project files"
        placeholder="Search files..."
        disabled
      />
    );
    const disabledClearButton = screen.getByRole('button', { name: 'Clear search' });
    expect(disabledClearButton).toBeDisabled();
    fireEvent.click(disabledClearButton);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
