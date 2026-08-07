import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVariablesPanel } from './CssVariablesPanel';

vi.mock('./EditPopover', () => ({
  EditPopover: ({
    enableColorPicker,
    onClose,
  }: {
    enableColorPicker?: boolean;
    onClose: () => void;
  }) => (
    <div data-testid="edit-popover" data-color-picker={enableColorPicker ? 'true' : 'false'}>
      <button type="button" onClick={onClose}>
        Close editor
      </button>
    </div>
  ),
}));

describe('CssVariablesPanel', () => {
  it('toggles the picker from the swatch and keeps value editing textual', () => {
    const { container } = render(
      <CssVariablesPanel
        variables={[
          {
            name: '--accent',
            value: '#009c52',
            selector: ':root',
            file: 'styles.css',
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--accent']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Open color picker' });
    fireEvent.click(swatch);
    expect(screen.getByTestId('edit-popover')).toHaveAttribute('data-color-picker', 'true');

    fireEvent.click(swatch);
    expect(screen.queryByTestId('edit-popover')).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('.ss-var-row__value') as HTMLElement);
    expect(screen.getByTestId('edit-popover')).toHaveAttribute('data-color-picker', 'false');
  });
});
