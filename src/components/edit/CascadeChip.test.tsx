import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeChip } from './CascadeChip';
import { RuleContextChips } from './RuleContextChips';
import { SelectorChip } from './SelectorChip';

describe('CascadeChip', () => {
  it('exposes tone and editing state through one stable root contract', () => {
    const { rerender } = render(<CascadeChip tone="selector">.button</CascadeChip>);
    const chip = screen.getByText('.button');
    expect(chip).toHaveClass('ss-cascade-chip');
    expect(chip).toHaveAttribute('data-tone', 'selector');

    rerender(
      <CascadeChip tone="media" editing>
        <input aria-label="Condition" />
      </CascadeChip>
    );
    expect(screen.getByLabelText('Condition').parentElement).toHaveClass(
      'ss-cascade-chip',
      'is-editing'
    );
    expect(screen.getByLabelText('Condition').parentElement).toHaveAttribute('data-tone', 'media');
  });

  it('opens selector editing with keyboard activation', () => {
    render(<SelectorChip selector=".button" suggestions={[]} onCommit={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(screen.getByRole('combobox', { name: 'Rule selector' })).toHaveValue('.button');
  });

  it('uses the same media-tone contract in display and editing states', () => {
    render(<RuleContextChips mediaText="(max-width: 768px)" onRenameAtRule={vi.fn()} />);
    const displayChip = screen.getByRole('button');
    expect(displayChip).toHaveAttribute('data-tone', 'media');

    fireEvent.click(displayChip);
    const input = screen.getByRole('combobox', { name: 'Media condition' });
    expect(input.parentElement).toHaveClass('ss-cascade-chip', 'is-editing');
    expect(input.parentElement).toHaveAttribute('data-tone', 'media');
  });
});
