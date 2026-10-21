import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CascadeRuleCard } from './CascadeRuleCard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CascadeRuleCard', () => {
  it('renders the draft message in the properties body', () => {
    render(
      <CascadeRuleCard
        editable
        draft
        selector=".button"
        body={{ items: [] }}
        overridden={new Map()}
        onChange={vi.fn()}
      />
    );

    const message = screen.getByText('No rules applied');
    const card = screen.getByTestId('cascade-card');

    expect(message.closest('.ss-cascade-card__body')).toBe(
      card.querySelector('.ss-cascade-card__body')
    );
    expect(message.parentElement).toHaveClass('ss-cascade-card__draft-row');
    expect(card.querySelector('.ss-cascade-card__head')).not.toContainElement(message);
    expect(
      screen.getByRole('button', { name: 'Add a property, nested rule, or condition' })
    ).toHaveTextContent('Add property');
  });

  it('shows candidate source filenames for an ambiguous rule', () => {
    render(
      <CascadeRuleCard
        editable={false}
        selector=".button"
        sourceFiles={['src/a.css', 'src/b.css']}
        decls={[]}
        overridden={new Map()}
        readonlyReason="this selector is defined in multiple files"
      />
    );

    expect(screen.getByText('a.css, b.css')).toBeInTheDocument();
    expect(document.querySelector('.ss-cascade-card__src-chip')).toHaveAttribute(
      'title',
      'src/a.css\nsrc/b.css'
    );
  });

  it('summarizes the declaration count while collapsed', () => {
    render(
      <CascadeRuleCard
        editable={false}
        collapsed
        onToggleCollapse={vi.fn()}
        selector=".button"
        decls={[
          { prop: 'display', value: 'grid', important: false },
          { prop: 'gap', value: '1rem', important: false },
        ]}
        overridden={new Map()}
      />
    );

    expect(screen.getByText('2 properties')).toBeInTheDocument();
    expect(document.querySelector('.ss-cascade-card__body')).not.toBeInTheDocument();
  });

  it('does not apply the selected element contrast context to nested declarations', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('PointerEvent', MouseEvent);
    render(
      <CascadeRuleCard
        editable
        selector=".button"
        body={{
          items: [
            {
              kind: 'rule',
              selector: '& .icon',
              body: {
                items: [{ kind: 'decl', prop: 'color', value: '#000000', important: false }],
              },
            },
          ],
        }}
        overridden={new Map()}
        colorContrast={{
          text: { backgroundColor: '#ffffff', category: 'normal-text' },
          graphics: { backgroundColor: '#ffffff', category: 'graphics' },
        }}
        onChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open color picker for color' }));
    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));

    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      'Contrast check unavailable. Background color is unavailable for this selection.'
    );
  });

  it('filters to matching properties and dims nonmatches when Show all is selected', () => {
    const body = {
      items: [
        { kind: 'decl' as const, prop: 'display', value: 'grid', important: false },
        { kind: 'decl' as const, prop: 'font-family', value: 'Inter', important: false },
        {
          kind: 'rule' as const,
          selector: '&:hover',
          body: {
            items: [{ kind: 'decl' as const, prop: 'color', value: 'red', important: false }],
          },
        },
      ],
    };

    render(
      <CascadeRuleCard
        editable
        selector=".hero-title"
        body={body}
        overridden={new Map()}
        onChange={vi.fn()}
        searchTerm="FONT-FAMILY"
      />
    );

    const card = screen.getByTestId('cascade-card');
    expect(card.querySelectorAll('.ss-decl:not(.ss-decl--ghost)')).toHaveLength(1);
    expect(within(card).getByText('font-family')).toBeInTheDocument();
    expect(within(card).queryByText('display')).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('combobox', { name: 'Nested selector' })
    ).not.toBeInTheDocument();
    const matchingProperty = card.querySelector('.ss-decl');
    const showAllAction = within(card).getByRole('button', { name: 'Show all properties' });
    expect(matchingProperty).not.toBeNull();
    expect(
      matchingProperty!.compareDocumentPosition(showAllAction) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show all properties' }));

    expect(within(card).getByText('display')).toBeInTheDocument();
    expect(within(card).getByRole('combobox', { name: 'Nested selector' })).toHaveValue('&:hover');
    expect(card.querySelector('.ss-cascade-filtered.is-dimmed')).toBeInTheDocument();
  });

  it('edits a filtered declaration at its original body index and preserves hidden items', () => {
    const body = {
      items: [
        { kind: 'decl' as const, prop: 'display', value: 'grid', important: false },
        { kind: 'decl' as const, prop: 'font-family', value: 'Inter', important: false },
        {
          kind: 'rule' as const,
          selector: '&:hover',
          body: {
            items: [{ kind: 'decl' as const, prop: 'color', value: 'red', important: false }],
          },
        },
      ],
    };
    const onChange = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    render(
      <CascadeRuleCard
        editable
        selector=".hero-title"
        body={body}
        overridden={new Map()}
        onChange={onChange}
        searchTerm="font-family"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove property' }));

    expect(onChange).toHaveBeenCalledWith({
      items: [
        { kind: 'decl', prop: 'display', value: 'grid', important: false },
        {
          kind: 'rule',
          selector: '&:hover',
          body: {
            items: [{ kind: 'decl', prop: 'color', value: 'red', important: false }],
          },
        },
      ],
    });
  });
});
