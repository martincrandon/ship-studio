import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { useCssVariables } from '../../hooks/useCssVariables';
import { VariablesPanel } from './VariablesPanel';

function variablesState(): ReturnType<typeof useCssVariables> {
  return {
    variables: [],
    loading: false,
    setValue: vi.fn(),
    addVariable: vi.fn(),
    reload: vi.fn(),
  };
}

describe('VariablesPanel', () => {
  it('renders standalone panel chrome and closes from its header', () => {
    const onClose = vi.fn();
    render(<VariablesPanel variablesState={variablesState()} onClose={onClose} />);

    expect(screen.getByTestId('variables-panel')).toBeInTheDocument();
    expect(screen.getByText('Variables')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close Variables panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
