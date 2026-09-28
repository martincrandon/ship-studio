import { describe, expect, it } from 'vitest';
import { buildRendererRegistry, serializeRendererRegistry } from './renderer-registry';
import type { ComponentIndex } from './types';

function component(overrides: Partial<ComponentIndex['components'][number]> = {}) {
  return {
    id: 'react:Card#default',
    dialect: 'react' as const,
    kind: 'component' as const,
    name: 'Card',
    localName: 'Card',
    exportName: 'default',
    description: null,
    definition: {
      file: 'src/Card.tsx',
      start: 0,
      end: 10,
      line: 1,
      column: 1,
      contentHash: 'hash',
    },
    props: [],
    slots: [],
    variantProps: [],
    usageCount: 1,
    capabilities: {
      catalog: true,
      usageGraph: true,
      definitionBinding: true,
      instanceBinding: true,
      place: true,
      editStaticProps: true,
      editSlots: true,
      editMain: true,
      componentTreeBoundary: true,
      focusedVisualEditing: true,
      duplicateDefinition: true,
      renameDefinition: true,
      deleteDefinition: true,
      extract: true,
      isolatedPreview: false,
      editLifecycle: false,
    },
    diagnostics: [],
    ...overrides,
  };
}

const index: ComponentIndex = {
  revision: 'index-revision',
  partial: false,
  profile: {} as ComponentIndex['profile'],
  components: [component()],
  instances: [],
  importEdges: [],
  diagnostics: [],
};

describe('renderer registry', () => {
  it('builds deterministic data-only entries for parser-proven React exports', () => {
    const result = buildRendererRegistry(index, { revision: 'source-revision' });
    expect(result.supportedComponentIds).toEqual(['react:Card#default']);
    expect(result.entries[0]).toMatchObject({
      modulePath: './src/Card.tsx',
      exportKind: 'default',
      sourceRevision: 'source-revision',
    });
  });

  it('rejects unsafe paths, parser errors, and unsupported dialects without dropping diagnostics', () => {
    const result = buildRendererRegistry(
      {
        ...index,
        components: [
          component({ definition: { ...component().definition, file: '../escape.tsx' } }),
          component({
            id: 'vue:Card#default',
            dialect: 'vue',
            definition: { ...component().definition, file: 'src/Card.vue' },
          }),
          component({
            id: 'react:Broken#default',
            diagnostics: [{ code: 'parse', severity: 'error', message: 'broken' }],
          }),
        ],
      },
      { revision: 'source-revision' }
    );
    expect(result.supportedComponentIds).toEqual([]);
    expect(result.rejected).toHaveLength(3);
  });

  it('serializes only supported component revisions for the reviewed native registry', () => {
    const registry = buildRendererRegistry(index, { revision: 'source-revision' });
    expect(JSON.parse(serializeRendererRegistry(registry))).toEqual({
      sourceRevision: 'source-revision',
      componentRevisions: { 'react:Card#default': 'source-revision' },
    });
    expect(serializeRendererRegistry(registry)).not.toContain('src/Card.tsx');
  });

  it('rejects required values that cannot be represented as static props', () => {
    const result = buildRendererRegistry(
      {
        ...index,
        components: [
          component({
            props: [
              {
                name: 'render',
                required: true,
                typeText: '() => ReactNode',
                defaultValue: null,
                choices: null,
                control: 'readonly',
                source: component().definition,
                diagnostics: [],
              },
            ],
          }),
        ],
      },
      { revision: 'source-revision' }
    );
    expect(result.rejected[0]?.reason).toContain('non-serializable');
  });

  it('rejects ambiguous exports, dynamic imports, unresolved re-exports, and stale revisions', () => {
    const ambiguous = buildRendererRegistry(
      { ...index, components: [component({ rendererSafety: { ambiguousExport: true } })] },
      { revision: 'source-revision' }
    );
    expect(ambiguous.rejected[0]?.reason).toContain('ambiguous default/named');

    const dynamic = buildRendererRegistry(
      { ...index, components: [component({ rendererSafety: { dynamicImport: true } })] },
      { revision: 'source-revision' }
    );
    expect(dynamic.rejected[0]?.reason).toContain('dynamic import');

    const unresolvedReExport = buildRendererRegistry(
      {
        ...index,
        importEdges: [
          {
            fromFile: 'src/index.ts',
            toFile: null,
            importedName: 'default',
            localName: 'Card',
            source: component().definition,
            status: 'unresolved',
            diagnostics: [],
            kind: 're-export',
            moduleSpecifier: './Card',
          },
        ],
      },
      { revision: 'source-revision' }
    );
    expect(unresolvedReExport.rejected[0]?.reason).toContain('re-export');

    const stale = buildRendererRegistry(index, { revision: 'source-revision' }, 'react', {
      currentSourceRevision: 'newer-source-revision',
    });
    expect(stale.rejected[0]?.reason).toContain('stale');
  });
});
