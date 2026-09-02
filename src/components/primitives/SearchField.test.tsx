import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SearchField } from './SearchField';

describe('SearchField', () => {
  it('renders a labelled native text field inside the shared search shell', () => {
    render(<SearchField aria-label="Search files" placeholder="Search files..." />);

    const input = screen.getByRole('textbox', { name: 'Search files' });
    expect(input).toHaveClass('ss-text-field', 'ss-search-field__input');
    expect(input.closest('.ss-search-field')).toBeInTheDocument();
  });
});
