import { describe, expect, it } from 'vitest';
import { useComponentsAvailability } from './useComponentsAvailability';

describe('useComponentsAvailability', () => {
  it('exposes the catalog for every supported web project detector result', () => {
    const availabilityForProject = useComponentsAvailability;
    for (const projectType of [
      'nextjs',
      'sveltekit',
      'astro',
      'nuxt',
      'vite',
      'statichtml',
      'shopifytheme',
      'generic',
    ] as const) {
      expect(availabilityForProject('/project', projectType)).toBe(true);
    }
  });

  it('keeps native and unresolved projects out of the web catalog gate', () => {
    expect(useComponentsAvailability('/project', 'reactnative')).toBe(false);
    expect(useComponentsAvailability('/project', 'flutter')).toBe(false);
    expect(useComponentsAvailability('/project', 'unknown')).toBe(false);
  });
});
