import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewBreadcrumb } from './PreviewBreadcrumb';
import type { ElementPathItem } from '../../lib/edit';

const path: ElementPathItem[] = [
  { tagName: 'section', className: 'hero', domPath: 'body:0>section:0' },
  { tagName: 'div', className: 'content', domPath: 'body:0>section:0>div:0' },
  {
    tagName: 'button',
    className: 'primary-button px-4',
    domPath: 'body:0>section:0>div:0>button:0',
  },
];

describe('PreviewBreadcrumb', () => {
  it('shows the selected element path and reselects the clicked parent', () => {
    const onSelect = vi.fn();

    render(<PreviewBreadcrumb path={path} onSelect={onSelect} />);

    expect(screen.getByRole('navigation')).toHaveClass('preview-breadcrumb');
    expect(
      screen.getByRole('button', { name: 'Select parent <section> .hero' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Select parent <div> .content' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current element <button> .primary-button')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select parent <section> .hero' }));
    expect(onSelect).toHaveBeenCalledWith(path[0]);
  });
});
