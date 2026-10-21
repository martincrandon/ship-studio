import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeToolbar } from './CascadeToolbar';

describe('CascadeToolbar', () => {
  it('keeps search, order, and collapse controls together and reports search state', () => {
    const onSearchOpen = vi.fn();
    const onSearchToggle = vi.fn();
    const onOrderChange = vi.fn();
    const onCollapseAll = vi.fn();
    const onExpandAll = vi.fn();

    const props = {
      searchOpen: false,
      searchButtonRef: createRef<HTMLButtonElement>(),
      searchFieldId: 'css-cascade-search',
      onSearchOpen,
      onSearchToggle,
      order: 'newest-top' as const,
      onOrderChange,
      allCollapsed: false,
      onCollapseAll,
      onExpandAll,
    };
    const { rerender } = render(<CascadeToolbar {...props} />);

    const searchTrigger = screen.getByRole('button', { name: 'Search CSS rules' });
    expect(searchTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(searchTrigger).not.toHaveAttribute('aria-controls');
    expect(searchTrigger.querySelector('svg')).toHaveAttribute('data-icon-name', 'SearchIcon');
    expect(searchTrigger.querySelector('svg')).toHaveAttribute('width', '11');
    expect(searchTrigger.querySelector('svg')).toHaveAttribute('height', '11');
    fireEvent.click(searchTrigger);
    expect(onSearchToggle).toHaveBeenCalledOnce();

    rerender(<CascadeToolbar {...props} searchOpen />);
    const closeSearch = screen.getByRole('button', { name: 'Close CSS search' });
    expect(closeSearch).toHaveAttribute('aria-expanded', 'true');
    expect(closeSearch).toHaveAttribute('aria-controls', 'css-cascade-search');
    fireEvent.click(closeSearch);
    expect(onSearchToggle).toHaveBeenCalledTimes(2);

    const orderButton = screen.getByRole('button', {
      name: 'CSS rule order: newest at top. Change to newest at bottom',
    });
    expect(orderButton.querySelector('svg')).toHaveAttribute(
      'data-icon-name',
      'SortVerticalUpIcon'
    );
    expect(orderButton.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/sort-vertical-up.svg'
    );
    fireEvent.click(orderButton);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));

    expect(onOrderChange).toHaveBeenCalledWith('newest-bottom');
    expect(onCollapseAll).toHaveBeenCalledOnce();
    expect(screen.getByRole('group', { name: 'CSS cascade controls' })).toBeInTheDocument();
    expect(orderButton).toHaveAttribute(
      'title',
      'Newest rules at top — change to newest at bottom'
    );
  });

  it('exposes Expand all when every selector card is collapsed', () => {
    const onExpandAll = vi.fn();

    render(
      <CascadeToolbar
        searchOpen
        searchButtonRef={createRef<HTMLButtonElement>()}
        searchFieldId="css-cascade-search"
        onSearchOpen={vi.fn()}
        onSearchToggle={vi.fn()}
        order="newest-bottom"
        onOrderChange={vi.fn()}
        allCollapsed
        onCollapseAll={vi.fn()}
        onExpandAll={onExpandAll}
      />
    );

    const orderButton = screen.getByRole('button', {
      name: 'CSS rule order: newest at bottom. Change to newest at top',
    });
    expect(orderButton.querySelector('svg')).toHaveAttribute(
      'data-icon-name',
      'SortVerticalDownIcon'
    );
    expect(orderButton.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/sort-vertical-down.svg'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand all CSS selector cards' }));
    expect(onExpandAll).toHaveBeenCalledOnce();
  });
});
