import { act, fireEvent, render, screen } from '@testing-library/react';
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
  function pointer(type: string, x: number, y: number, pointerId = 1) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      pointerType: { value: 'mouse' },
      clientX: { value: x },
      clientY: { value: y },
    });
    return event;
  }

  function sortableVariables() {
    return ['first', 'second', 'third'].map((name, index) => ({
      name: `--${name}`,
      value: `${index + 1}px`,
      selector: ':root' as const,
      file: 'styles.css',
      line: 1,
      editable: true,
    }));
  }

  it('sorts editable rows with a leading hover handle and in-flow movement', async () => {
    vi.useFakeTimers();
    try {
      const variables = sortableVariables();
      const onReorderVariables = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <CssVariablesPanel
          variables={variables}
          loading={false}
          variableNames={variables.map((variable) => variable.name)}
          onSetValue={vi.fn()}
          onAddVariable={vi.fn()}
          onAnalyzeDelete={vi.fn()}
          onDeleteVariable={vi.fn()}
          onReorderVariables={onReorderVariables}
        />
      );
      const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
      items.forEach((item, index) => {
        Object.defineProperty(item, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            left: 0,
            top: index * 30,
            right: 280,
            bottom: index * 30 + 20,
            width: 280,
            height: 20,
          }),
        });
      });
      const firstRow = items[0]?.querySelector('.ss-var-row');
      const handle = screen.getByRole('button', { name: 'Move --first variable' });
      expect(firstRow?.firstElementChild).toBe(handle);
      expect(handle).toHaveAttribute('data-drag-sort-handle-visibility', 'hover');

      fireEvent(handle, pointer('pointerdown', 10, 10));
      fireEvent(window, pointer('pointermove', 10, 75));
      expect(items[0]).toHaveAttribute('data-drag-sort-dragging', 'true');
      expect(items[0]).toHaveAttribute('data-drag-sort-has-overlay', 'false');
      expect(items[0]).not.toHaveAttribute('data-drag-sort-placeholder');
      expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();

      fireEvent(window, pointer('pointerup', 10, 75));
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(onReorderVariables).toHaveBeenCalledWith([variables[1], variables[2], variables[0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports keyboard sorting from the mounted row handle', async () => {
    vi.useFakeTimers();
    try {
      const variables = sortableVariables();
      const onReorderVariables = vi.fn().mockResolvedValue(undefined);
      render(
        <CssVariablesPanel
          variables={variables}
          loading={false}
          variableNames={variables.map((variable) => variable.name)}
          onSetValue={vi.fn()}
          onAddVariable={vi.fn()}
          onAnalyzeDelete={vi.fn()}
          onDeleteVariable={vi.fn()}
          onReorderVariables={onReorderVariables}
        />
      );
      const handle = screen.getByRole('button', { name: 'Move --second variable' });
      fireEvent.keyDown(handle, { key: ' ' });
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      fireEvent.keyDown(handle, { key: ' ' });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(onReorderVariables).toHaveBeenCalledWith([variables[0], variables[2], variables[1]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves singleton source groups unsortable', () => {
    const variables = [
      ...sortableVariables().slice(0, 2),
      {
        name: '--singleton',
        value: '4px',
        selector: ':root',
        file: 'other.css',
        line: 1,
        editable: true,
      },
    ];
    const { container } = render(
      <CssVariablesPanel
        variables={variables}
        loading={false}
        variableNames={variables.map((variable) => variable.name)}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
        onReorderVariables={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'Move --singleton variable' })
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-drag-sort-item]')).toHaveLength(2);
  });

  it('analyzes impact before confirming variable deletion', async () => {
    const variable = {
      name: '--space-sm',
      value: '8px',
      selector: ':root',
      file: 'styles.css',
      line: 1,
      editable: true,
    };
    const impact = {
      usageCount: 3,
      ruleCount: 2,
      fileCount: 1,
      definitionCount: 1,
      replacementValue: '8px',
    };
    const onAnalyzeDelete = vi.fn().mockResolvedValue(impact);
    const onDeleteVariable = vi.fn().mockResolvedValue(impact);

    render(
      <CssVariablesPanel
        variables={[variable]}
        loading={false}
        variableNames={[variable.name]}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={onAnalyzeDelete}
        onDeleteVariable={onDeleteVariable}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Actions for --space-sm' });
    expect(trigger.querySelector('svg')).toHaveAttribute('width', '14');

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveClass('ss-var-row__menu');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onAnalyzeDelete).toHaveBeenCalledWith(variable);
    expect(await screen.findByText('3 times')).toBeInTheDocument();
    expect(screen.getByText('2 CSS rules')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete variable' }));
    expect(onDeleteVariable).toHaveBeenCalledWith(variable, impact);
  });

  it('keeps long values in an independently wrapping value cell', () => {
    const longValue =
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

    const { container } = render(
      <CssVariablesPanel
        variables={[
          {
            name: '--font-sans',
            value: longValue,
            selector: ':root',
            file: 'styles.css',
            line: 1,
            editable: true,
          },
          {
            name: '--space-sm',
            value: '8px',
            selector: ':root',
            file: 'styles.css',
            line: 5,
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--font-sans', '--space-sm']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
      />
    );

    const rows = container.querySelectorAll('.ss-var-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.ss-css-value-text')).toHaveTextContent(longValue);
    expect(rows[1]?.querySelector('.ss-css-value-text')).toHaveTextContent('8px');
  });

  it('toggles the picker from the swatch and keeps value editing textual', () => {
    const { container } = render(
      <CssVariablesPanel
        variables={[
          {
            name: '--accent',
            value: '#009c52',
            selector: ':root',
            file: 'styles.css',
            line: 1,
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--accent']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Open color picker' });
    expect(
      container.querySelector(
        '.ss-var-row__name .ss-var-row__type-icon [data-icon-name="ColorIcon"]'
      )
    ).toBeInTheDocument();
    expect(swatch.parentElement).toHaveClass('ss-var-row__value-group');
    fireEvent.click(swatch);
    expect(screen.getByTestId('edit-popover')).toHaveAttribute('data-color-picker', 'true');

    fireEvent.click(swatch);
    expect(screen.queryByTestId('edit-popover')).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('.ss-var-row__value') as HTMLElement);
    expect(screen.getByTestId('edit-popover')).toHaveAttribute('data-color-picker', 'false');
  });

  it('shows the checkerboard behind a fully transparent color variable', () => {
    render(
      <CssVariablesPanel
        variables={[
          {
            name: '--test-token',
            value: 'hsla(0, 0%, 100%, 0)',
            selector: ':root',
            file: 'styles.css',
            line: 1,
            editable: true,
          },
        ]}
        loading={false}
        variableNames={['--test-token']}
        onSetValue={vi.fn()}
        onAddVariable={vi.fn()}
        onAnalyzeDelete={vi.fn()}
        onDeleteVariable={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Open color picker' });
    expect(swatch).toHaveClass('ss-color-swatch__chip--checkerboard');
    expect(swatch.querySelector('.ss-var-row__swatch-color')).toHaveStyle({
      backgroundColor: 'hsla(0, 0%, 100%, 0)',
    });
  });
});
