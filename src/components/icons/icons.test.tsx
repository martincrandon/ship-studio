import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RefObject } from 'react';
import {
  CloudflareIcon,
  ComponentsIcon,
  CopyIcon,
  FolderOpenIcon,
  ImageUploadIcon,
  NestRuleIcon,
  PlayIcon,
  RulerIcon,
  SearchIcon,
  StopIcon,
  TemplateIcon,
  VariablesIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './index';
import { getGalleryIcons } from './IconGallery';

describe('shared icons', () => {
  it('renders SearchIcon metadata, currentColor artwork, and decorative accessibility defaults', () => {
    const { container } = render(<SearchIcon />);
    const icon = container.querySelector('svg');

    expect(icon).toHaveAttribute('data-icon-name', 'SearchIcon');
    expect(icon).toHaveAttribute('data-icon-kind', 'ui');
    expect(icon).toHaveAttribute('data-icon-source', 'icons/search.svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('stroke-width', '1px');
    expect(icon?.innerHTML).toContain('currentColor');
  });

  it('registers the Variables icon from the imported design-system asset', () => {
    const { container } = render(<VariablesIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/variables.svg'
    );
  });

  it('registers the Components icon from the imported design-system asset', () => {
    const { container } = render(<ComponentsIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/components.svg'
    );
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('registers imported project-action icons with currentColor artwork', () => {
    const { container, rerender } = render(<ImageUploadIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/image-upload.svg'
    );
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');

    rerender(<TemplateIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/template.svg'
    );
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('registers the stop previews icon from the shared icon asset', () => {
    const { container } = render(<StopIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('data-icon-source', 'icons/stop.svg');
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('registers the shared play icon from the imported asset', () => {
    const { container } = render(<PlayIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('data-icon-source', 'icons/play.svg');
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('registers the ruler icon from the imported asset', () => {
    const { container } = render(<RulerIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('data-icon-source', 'icons/ruler.svg');
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('registers the zoom control icons from the imported assets', () => {
    const { container, rerender } = render(<ZoomOutIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/zoom-out.svg'
    );
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');

    rerender(<ZoomInIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('data-icon-source', 'icons/zoom-in.svg');
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('keeps the legacy standard-size compatibility result for size 14', () => {
    const { container } = render(<SearchIcon size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '16');
  });

  it('keeps compact icons at 14px for requests of 12 or 14', () => {
    const { container, rerender } = render(<CopyIcon size={12} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
    rerender(<CopyIcon size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });

  it('labels icons as images and preserves caller props and refs', () => {
    const ref = { current: null } as RefObject<SVGSVGElement | null>;
    const { container } = render(
      <SearchIcon ref={ref} title="Search" className="test-icon" fill="none" aria-label="Search" />
    );
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('role', 'img');
    expect(icon).not.toHaveAttribute('aria-hidden');
    expect(icon).toHaveClass('test-icon');
    expect(icon).toHaveAttribute('fill', 'none');
    expect(ref.current).toBe(icon);
  });

  it('preserves non-square viewBoxes and extracted artwork attributes', () => {
    const { container, rerender } = render(<FolderOpenIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 25 24');
    rerender(<NestRuleIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '2');
  });

  it('preserves fixed brand colour artwork', () => {
    const { container } = render(<CloudflareIcon />);
    expect(container.querySelector('path')).toHaveAttribute('fill', '#f38020');
  });

  it('discovers shared icons from iconMeta and sorts by semantic name', () => {
    const icons = getGalleryIcons();
    const names = icons.map((icon) => icon.iconMeta.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain('SearchIcon');
    expect(icons.find((icon) => icon.iconMeta.name === 'SearchIcon')?.iconMeta.source).toBe(
      'icons/search.svg'
    );
  });
});
