import { describe, expect, it } from 'vitest';
import { useComponentsAvailability } from './useComponentsAvailability';

describe('useComponentsAvailability', () => {
  it('keeps every supported source dialect reachable through the workspace gate', () => {
    expect(useComponentsAvailability('/projects/next', 'nextjs')).toBe(true);
    expect(useComponentsAvailability('/projects/astro', 'astro')).toBe(true);
    expect(useComponentsAvailability('/projects/nuxt', 'nuxt')).toBe(true);
    expect(useComponentsAvailability('/projects/svelte', 'sveltekit')).toBe(true);
    expect(useComponentsAvailability('/projects/shopify', 'shopifytheme')).toBe(true);
    expect(useComponentsAvailability('/projects/web', 'statichtml')).toBe(true);
    expect(useComponentsAvailability('/projects/web', 'generic')).toBe(true);
    expect(useComponentsAvailability('/projects/native', 'reactnative')).toBe(true);
    expect(useComponentsAvailability('/projects/native', 'flutter')).toBe(true);
  });

  it('fails closed for unknown projects', () => {
    expect(useComponentsAvailability('/projects/unknown', 'unknown')).toBe(false);
  });
});
