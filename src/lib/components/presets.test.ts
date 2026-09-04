import { describe, expect, it } from 'vitest';
import { sha256 } from './ranges';
import {
  COMPONENT_PRESET_VERSION,
  parseComponentPreviewPresetStore,
  reconcileComponentPreviewPresets,
  writeComponentPreviewPresetStore,
  type ComponentPreviewPresetStore,
} from './presets';
import type { ComponentIndex } from './types';

function index(): ComponentIndex {
  const source = {
    file: 'src/Card.tsx',
    start: 0,
    end: 1,
    line: 1,
    column: 1,
    contentHash: sha256('card'),
  };
  return {
    revision: 'preset-index',
    partial: false,
    profile: {
      projectType: 'nextjs',
      primaryDialect: 'react',
      dialects: ['react'],
      workspaceRoot: '.',
      capabilities: {} as ComponentIndex['profile']['capabilities'],
      diagnostics: [],
    },
    components: [
      {
        id: 'react:src/Card.tsx#Card',
        dialect: 'react',
        kind: 'component',
        name: 'Card',
        localName: 'Card',
        exportName: 'Card',
        description: null,
        definition: source,
        props: [],
        slots: [],
        variantProps: [],
        usageCount: 0,
        capabilities: {} as ComponentIndex['components'][number]['capabilities'],
        diagnostics: [],
      },
    ],
    instances: [],
    importEdges: [],
    diagnostics: [],
  };
}

function preset(id: string, componentId = 'react:src/Card.tsx#Card') {
  return {
    id,
    version: COMPONENT_PRESET_VERSION,
    componentId,
    dialect: 'react' as const,
    name: 'Launch card',
    props: { title: { kind: 'string' as const, value: 'Launch' } },
    slots: {},
  };
}

describe('component preview presets', () => {
  it('accepts only versioned explicit presentation values', () => {
    const store = parseComponentPreviewPresetStore({
      version: COMPONENT_PRESET_VERSION,
      presets: [preset('valid'), { ...preset('invalid'), props: { title: { kind: 'function' } } }],
    });
    expect(store).toMatchObject({ version: 1, presets: [preset('valid')] });
  });

  it('keeps removed or incompatible definitions orphaned instead of retargeting them', () => {
    const valid = { ...preset('valid'), props: {} };
    const removed = preset('removed', 'react:src/Removed.tsx#Removed');
    const store: ComponentPreviewPresetStore = {
      version: COMPONENT_PRESET_VERSION,
      presets: [valid, removed],
    };
    const result = reconcileComponentPreviewPresets(store, index());
    expect(result.active).toEqual([valid]);
    expect(result.orphaned).toMatchObject([{ preset: removed, reason: 'missing-component' }]);
  });

  it('writes a normalized versioned store through the provided storage boundary', () => {
    let value = '';
    writeComponentPreviewPresetStore(
      {
        setItem: (_key, next) => {
          value = next;
        },
      },
      { version: COMPONENT_PRESET_VERSION, presets: [preset('saved')] }
    );
    expect(JSON.parse(value)).toMatchObject({ version: 1, presets: [preset('saved')] });
  });
});
