import { describe, expect, it } from 'vitest';
import {
  componentPropertyMetadataStorageKey,
  mergePropertyPresentation,
  knownPropertyPresentation,
  readComponentPropertyPresentationStore,
  writeComponentPropertyPresentationStore,
} from './property-metadata';
import type { ComponentDescriptor, ComponentPropDescriptor } from './types';

const source = { file: 'Card.tsx', start: 0, end: 1, line: 1, column: 1, contentHash: 'hash' };
const props: ComponentPropDescriptor[] = [
  {
    name: 'title',
    required: true,
    typeText: 'string',
    defaultValue: null,
    choices: null,
    control: 'text',
    source,
    diagnostics: [],
  },
  {
    name: 'image',
    required: false,
    typeText: 'string',
    defaultValue: null,
    choices: null,
    control: 'asset',
    source,
    diagnostics: [],
  },
];

describe('component property presentation metadata', () => {
  it('orders and groups only source-declared properties', () => {
    const metadata = {
      componentId: 'card',
      properties: [
        { name: 'image', group: 'Media', order: 1 },
        { name: 'title', group: 'Content', order: 0 },
        { name: 'missing', group: 'Unsafe', order: -1 },
      ],
    };
    const merged = mergePropertyPresentation(props, metadata);
    expect(merged.map((prop) => prop.name)).toEqual(['title', 'image']);
    expect(merged[0]).toMatchObject({ group: 'Content', order: 0 });
    expect(knownPropertyPresentation({ props } as ComponentDescriptor, metadata)).toHaveLength(2);
  });

  it('does not overwrite source descriptions with companion metadata', () => {
    const withDescription = [{ ...props[0], description: 'From JSDoc' }];
    const merged = mergePropertyPresentation(withDescription, {
      componentId: 'card',
      properties: [{ name: 'title', description: 'Unreviewed replacement' }],
    });
    expect(merged[0]?.description).toBe('From JSDoc');
  });

  it('persists presentation metadata under a project-scoped validated key', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const store = {
      version: 1 as const,
      components: [
        {
          componentId: 'card',
          properties: [{ name: 'title', label: 'Card title', group: 'Content', order: 1 }],
        },
      ],
    };
    writeComponentPropertyPresentationStore(storage, '/projects/one', store);
    expect(values.has(componentPropertyMetadataStorageKey('/projects/one'))).toBe(true);
    expect(readComponentPropertyPresentationStore(storage, '/projects/one')).toEqual(store);
    expect(readComponentPropertyPresentationStore(storage, '/projects/two').components).toEqual([]);
  });
});
