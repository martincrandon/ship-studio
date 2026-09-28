import { describe, expect, it } from 'vitest';
import { rendererReadiness } from './renderer-readiness';
import type { RendererRegistryEntry } from './renderer-registry';

const entry: RendererRegistryEntry = {
  componentId: 'react:Card',
  modulePath: './src/Card.tsx',
  exportName: 'Card',
  exportKind: 'named',
  sourceFile: 'src/Card.tsx',
  sourceRevision: 'revision-1',
  clientModule: false,
  supported: true,
};

describe('renderer readiness', () => {
  it('reports the reviewed Next adapter as ready while setup remains explicit', () => {
    expect(rendererReadiness('nextjs', entry)).toMatchObject({
      adapter: 'next',
      live: true,
      label: 'Renderer ready',
    });
  });

  it('keeps a disabled adapter catalog-only when explicitly gated off', () => {
    expect(
      rendererReadiness('nextjs', entry, {
        react: false,
        nextAppRouter: false,
        nextPagesRouter: false,
        vite: false,
        stage: false,
        editing: false,
      })
    ).toMatchObject({ live: false, label: 'Catalog-only' });
  });

  it('reports parser rejection before adapter state', () => {
    expect(
      rendererReadiness('vite', { ...entry, supported: false, reason: 'ambiguous export' })
    ).toMatchObject({ live: false, reason: 'ambiguous export' });
  });

  it('explains why Astro projects remain catalog-only', () => {
    expect(rendererReadiness('astro', entry)).toEqual({
      adapter: 'unsupported',
      live: false,
      label: 'Catalog-only',
      reason:
        'Astro components stay catalog-only until a reviewed Astro renderer adapter preserves the project runtime, integrations, styles, and server/client boundaries.',
    });
  });
});
