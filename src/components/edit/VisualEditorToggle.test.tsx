import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VisualEditorToggle } from './VisualEditorToggle';

describe('VisualEditorToggle', () => {
  it('reflects the active state and reports toggle intent', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<VisualEditorToggle enabled active={false} onToggle={onToggle} />);

    const toggle = screen.getByRole('button', { name: 'Edit' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveClass('preview-edit-control');

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<VisualEditorToggle enabled active onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the control visible but unavailable when visual editing is unsupported', () => {
    render(<VisualEditorToggle enabled={false} active={false} onToggle={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: 'Edit' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveClass('preview-edit-toggle--disabled');
  });
});
