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

    const { container } = render(
      <PreviewBreadcrumb path={path} onSelect={onSelect} showTagIcons={false} />
    );

    expect(screen.getByRole('navigation')).toHaveClass('preview-breadcrumb');
    expect(
      screen.getByRole('button', { name: 'Select parent <section> .hero' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Select parent <div> .content' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current element <button> .primary-button')).toBeInTheDocument();
    expect(container.querySelector('[title]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select parent <section> .hero' }));
    expect(onSelect).toHaveBeenCalledWith(path[0]);
  });

  it('collapses the middle of a long path with an ellipsis', () => {
    const longPath: ElementPathItem[] = [
      ...path,
      { tagName: 'article', className: 'card', domPath: 'body:0>section:0>article:0' },
      { tagName: 'div', className: 'content', domPath: 'body:0>section:0>article:0>div:0' },
      { tagName: 'span', className: 'label', domPath: 'body:0>section:0>article:0>div:0>span:0' },
    ];

    const onSelect = vi.fn();
    const { container } = render(
      <PreviewBreadcrumb path={longPath} onSelect={onSelect} showTagIcons={false} />
    );

    expect(container.querySelector('.breadcrumb__ellipsis')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Select parent <section> .hero' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Select parent <div> .content' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current element <span> .label')).toBeInTheDocument();
    const ellipsis = screen.getByRole('button', { name: 'Show hidden elements' });
    expect(ellipsis).toHaveAttribute('aria-expanded', 'false');
    expect(ellipsis).not.toHaveAttribute('title');

    fireEvent.click(ellipsis);
    expect(ellipsis).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '<article> .card' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: '<article> .card' }));
    expect(onSelect).toHaveBeenCalledWith(longPath[3]);
  });

  it('uses the shared tag icon mode and falls back to tag text when no icon exists', () => {
    const mixedPath: ElementPathItem[] = [
      { tagName: 'section', className: 'hero', domPath: 'body:0>section:0' },
      { tagName: 'custom-widget', className: 'card', domPath: 'body:0>custom-widget:0' },
    ];

    const { container, rerender } = render(
      <PreviewBreadcrumb path={mixedPath} onSelect={vi.fn()} showTagIcons />
    );

    expect(
      container.querySelector('.preview-breadcrumb__icon [data-icon-name="ElementSectionIcon"]')
    ).toBeInTheDocument();
    expect(container.querySelector('.preview-breadcrumb__tag')).toHaveTextContent(
      '<custom-widget>'
    );

    rerender(<PreviewBreadcrumb path={mixedPath} onSelect={vi.fn()} showTagIcons={false} />);

    expect(container.querySelector('.preview-breadcrumb__icon')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.preview-breadcrumb__tag')).toHaveLength(2);
  });
});
