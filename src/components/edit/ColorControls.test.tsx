import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BASE_BREAKPOINT, type LayerContext } from '../../lib/edit';
import { ColorField } from './ColorControls';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const LAYER: LayerContext = {
  bp: BASE_BREAKPOINT,
  ordered: [BASE_BREAKPOINT],
  known: new Set(),
};

describe('ColorField', () => {
  it('uses the transparency checkerboard when no color is set', () => {
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass=""
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Text color' });
    expect(swatch).toHaveClass('ss-color-swatch--embedded');
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).toBeInTheDocument();
    expect(swatch).not.toHaveTextContent('—');
  });

  it('keeps the checkerboard off a swatch with a color value', () => {
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass="text-[#e2f8fd]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Text color' });
    expect(swatch.querySelector('.ss-color-swatch__chip')).toBeInTheDocument();
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).not.toBeInTheDocument();
  });

  it('does not treat an unresolved color variable as transparent', () => {
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass="text-[var(--foreground)]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Text color' });
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).not.toBeInTheDocument();
  });
});
