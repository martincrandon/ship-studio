import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuleContextChips } from './RuleContextChips';

/** A condition that is a substring of a suggested one, so the browse menu's first
 *  match differs from what the rule actually says. */
const CONDITION = '(max-width: 768px)';

function open(onRenameAtRule = vi.fn()) {
  render(<RuleContextChips mediaText={CONDITION} onRenameAtRule={onRenameAtRule} />);
  fireEvent.click(screen.getByRole('button', { name: 'max-width:' }));
  return {
    input: screen.getByRole('combobox', { name: 'Edit media query feature' }),
    onRenameAtRule,
  };
}

describe('RuleContextChips media condition', () => {
  it('does not rewrite the condition when Enter follows a click with no typing', () => {
    const { input, onRenameAtRule } = open();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameAtRule).not.toHaveBeenCalled();
  });

  it('applies the highlighted suggestion once the user types', () => {
    const { input, onRenameAtRule } = open();
    fireEvent.change(input, { target: { value: 'min' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameAtRule).toHaveBeenCalledWith('(min-width: 768px)');
  });

  it('applies the highlighted suggestion once the user arrows to it', () => {
    const { input, onRenameAtRule } = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameAtRule).toHaveBeenCalledWith('(min-width: 768px)');
  });
});
