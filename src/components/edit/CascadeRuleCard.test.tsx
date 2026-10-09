import { fireEvent, render, screen } from '@testing-library/react';
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
});
