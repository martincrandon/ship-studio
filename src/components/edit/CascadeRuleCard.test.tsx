import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeRuleCard } from './CascadeRuleCard';

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
  });
});
