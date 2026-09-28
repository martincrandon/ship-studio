import { describe, expect, it } from 'vitest';
import { spikeViteRendererHost } from './vite-renderer-adapter';
import type { RendererRegistryEntry } from './renderer-registry';

describe('vite renderer spike', () => {
  it('refuses implicit generated-entry hosting even when a Vite config exists', () => {
    const result = spikeViteRendererHost({
      projectFiles: ['vite.config.ts', 'src/App.tsx'],
      registry: {
        entries: [
          {
            componentId: 'react:Card',
            modulePath: './src/Card.tsx',
            exportName: 'Card',
            exportKind: 'named',
            sourceFile: 'src/Card.tsx',
            sourceRevision: 'revision',
            clientModule: false,
            supported: true,
          } satisfies RendererRegistryEntry,
        ],
      },
      devServerOrigin: 'http://localhost:5173',
    });
    expect(result.supported).toBe(false);
    expect(result.detectedConfigFiles).toEqual(['vite.config.ts']);
    expect(result.reason).toContain('not accepted');
    expect(result.remediation).toContain('will not edit vite.config.*');
  });

  it('reports a precise catalog-only reason when no config is present', () => {
    const result = spikeViteRendererHost({
      projectFiles: ['src/App.tsx'],
      registry: { entries: [] },
    });
    expect(result.detectedConfigFiles).toEqual([]);
    expect(result.reason).toContain('No Vite config file');
    expect(result.remediation).toContain('catalog-only');
  });
});
