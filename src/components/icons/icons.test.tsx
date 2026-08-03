import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopyIcon, InfoIcon, SearchIcon } from './index';

describe('icon provenance', () => {
  it('marks and normalizes an icon from the new design set', () => {
    const { container } = render(<SearchIcon size={16} />);
    const icon = container.querySelector('svg');

    expect(icon).toHaveAttribute('data-icon-name', 'SearchIcon');
    expect(icon).toHaveAttribute('data-icon-provenance', 'new-design');
    expect(icon).toHaveAttribute('width', '16');
    expect(icon).toHaveAttribute('stroke-width', '1px');
    expect(icon?.innerHTML).toContain('currentColor');
    expect(icon?.innerHTML).not.toContain('#979797');
  });

  it('uses 16px for standard icons when the old 14px size is requested', () => {
    const { container } = render(<SearchIcon size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '16');
  });

  it('uses 14px for compact actions at both legacy and compact sizes', () => {
    const { container, rerender } = render(<CopyIcon size={12} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');

    rerender(<CopyIcon size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });

  it('marks an icon that still needs replacement as legacy', () => {
    const { container } = render(<InfoIcon />);
    const icon = container.querySelector('svg');

    expect(icon).toHaveAttribute('data-icon-name', 'InfoIcon');
    expect(icon).toHaveAttribute('data-icon-provenance', 'legacy');
    expect(icon).toHaveAttribute('width', '16');
    expect(icon).toHaveAttribute('stroke-width', '1px');
  });
});
