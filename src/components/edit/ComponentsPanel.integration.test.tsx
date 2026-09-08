import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComponentsPanel } from './ComponentsPanel';
import type { ComponentIndexWithLibraries } from '../../lib/components';
import type { ComponentLibraryMetadata } from '../../lib/components/libraries';
import type {
  ComponentBinding,
  ComponentCapabilities,
  ComponentDialect,
  ComponentDescriptor,
  ComponentInstance,
  SourceRef,
} from '../../lib/components/types';
import { astroCapabilities } from '../../lib/components/adapters/astro';
import { componentCapabilities } from '../../lib/components/adapters/react-helpers';
import { reactNativeCapabilities } from '../../lib/components/adapters/react-native';
import { shopifyCapabilities } from '../../lib/components/adapters/shopify';
import { svelteCapabilities } from '../../lib/components/adapters/svelte';
import { vueCapabilities } from '../../lib/components/adapters/vue';
import { webComponentCapabilities } from '../../lib/components/adapters/web-components';
import { flutterSourceCapabilities } from '../../lib/components/flutter-analyzer';

vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn() }));

const dialects: ComponentDialect[] = [
  'react',
  'astro',
  'vue',
  'svelte',
  'shopify',
  'web-component',
  'react-native',
  'flutter',
];

const dialectCapabilities: Record<ComponentDialect, ComponentCapabilities> = {
  react: componentCapabilities(true, true, true),
  astro: astroCapabilities(),
  vue: vueCapabilities(),
  svelte: svelteCapabilities(),
  shopify: shopifyCapabilities(),
  'web-component': webComponentCapabilities(),
  'react-native': reactNativeCapabilities(),
  flutter: flutterSourceCapabilities(),
};

const source: SourceRef = {
  file: 'src/Example.tsx',
  start: 0,
  end: 20,
  line: 1,
  column: 1,
  contentHash: 'example-hash',
};

function readOnlyCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: false,
    instanceBinding: false,
    place: false,
    editStaticProps: false,
    editSlots: false,
    editMain: false,
    componentTreeBoundary: false,
    focusedVisualEditing: false,
    duplicateDefinition: false,
    renameDefinition: false,
    deleteDefinition: false,
    extract: false,
    isolatedPreview: false,
  };
}

function indexFor(dialect: ComponentDialect): ComponentIndexWithLibraries {
  const capabilities = dialectCapabilities[dialect];
  const component: ComponentDescriptor = {
    id: `${dialect}:src/Example.tsx#Example`,
    dialect,
    kind: 'component',
    name: `${dialect} Example`,
    localName: 'Example',
    exportName: 'Example',
    description: null,
    definition: source,
    props: [],
    slots: [],
    variantProps: [],
    usageCount: 0,
    capabilities,
    diagnostics: [],
  };
  return {
    revision: `${dialect}-revision`,
    partial: false,
    profile: {
      projectType: null,
      primaryDialect: dialect,
      dialects: [dialect],
      workspaceRoot: '.',
      capabilities: {
        react: dialect === 'react' ? capabilities : readOnlyCapabilities(),
        astro: dialect === 'astro' ? capabilities : readOnlyCapabilities(),
        vue: dialect === 'vue' ? capabilities : readOnlyCapabilities(),
        svelte: dialect === 'svelte' ? capabilities : readOnlyCapabilities(),
        shopify: dialect === 'shopify' ? capabilities : readOnlyCapabilities(),
        'web-component': dialect === 'web-component' ? capabilities : readOnlyCapabilities(),
        'react-native': dialect === 'react-native' ? capabilities : readOnlyCapabilities(),
        flutter: dialect === 'flutter' ? capabilities : readOnlyCapabilities(),
      },
      diagnostics: [],
    },
    components: [component],
    instances: [],
    importEdges: [],
    diagnostics: [],
    libraries: [],
  };
}

describe('ComponentsPanel cross-dialect integration', () => {
  it.each(dialects)('reaches %s and honors its advertised capability boundary', (dialect) => {
    const index = indexFor(dialect);
    render(
      <ComponentsPanel
        index={index}
        selectedComponentId={index.components[0].id}
        onSelect={vi.fn()}
        onPlace={vi.fn()}
        onOpenSource={vi.fn()}
        onRefresh={vi.fn()}
        onSelectUsage={vi.fn()}
        onDuplicate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByTestId('components-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: `${dialect} Example` })).toBeInTheDocument();
    if (index.components[0].capabilities.place) {
      expect(screen.getByRole('button', { name: 'Place' })).toBeEnabled();
    } else {
      expect(screen.getByRole('button', { name: 'Place' })).toBeDisabled();
    }
    if (!index.components[0].capabilities.place) {
      expect(screen.getByText('Read-only')).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveProperty(
      'disabled',
      !index.components[0].capabilities.duplicateDefinition
    );
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveProperty(
      'disabled',
      !index.components[0].capabilities.renameDefinition
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty(
      'disabled',
      !index.components[0].capabilities.deleteDefinition
    );
  });

  it('removes nested slot writes and child-main edits for library-owned components', () => {
    const base = indexFor('react');
    const component: ComponentDescriptor = {
      ...base.components[0],
      slots: [
        {
          name: 'children',
          required: false,
          scoped: false,
          source,
        },
      ],
      usageCount: 1,
    };
    const child = {
      instanceId: 'nested-instance',
      componentId: component.id,
      name: 'Nested',
      invocation: source,
    };
    const usage: ComponentInstance = {
      id: 'usage-instance',
      componentId: component.id,
      invocation: source,
      containingComponentId: null,
      route: '/',
      props: {},
      slots: [{ name: 'children', value: null, children: [child] }],
      slotSources: { children: { ...source, text: '<Nested />' } },
    };
    const binding: ComponentBinding = {
      confidence: 'exact',
      componentId: component.id,
      instanceId: usage.id,
      source,
      candidates: [],
      diagnostics: [],
    };
    const library: ComponentLibraryMetadata = {
      id: 'package:packages/ui:@acme/ui',
      packageName: '@acme/ui',
      packageRoot: 'packages/ui',
      version: '1.2.0',
      repository: null,
      ownership: 'library',
      exportedFiles: [component.definition.file],
      componentIds: [component.id],
      contracts: [],
    };

    render(
      <ComponentsPanel
        index={{ ...base, components: [component], instances: [usage], libraries: [library] }}
        projectPath="/projects/consumer"
        selectedComponentId={component.id}
        binding={binding}
        onSelect={vi.fn()}
        onPlace={vi.fn()}
        onOpenSource={vi.fn()}
        onRefresh={vi.fn()}
        onSelectUsage={vi.fn()}
        onEditStructuredSlot={vi.fn()}
        onEditSlotChildMain={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: 'Instance values' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Nested main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Nested' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add component' })).not.toBeInTheDocument();
  });

  it('groups validated library ownership and routes a fork through explicit review input', () => {
    const base = indexFor('react');
    const component = base.components[0];
    const library: ComponentLibraryMetadata = {
      id: 'package:packages/ui:@acme/ui',
      packageName: '@acme/ui',
      packageRoot: 'packages/ui',
      version: '1.2.0',
      repository: 'https://example.test/acme/ui.git',
      ownership: 'library',
      exportedFiles: [component.definition.file],
      componentIds: [component.id],
      contracts: [],
    };
    const onForkLibrary = vi.fn();
    render(
      <ComponentsPanel
        index={{ ...base, libraries: [library] }}
        projectPath="/projects/consumer"
        selectedComponentId={component.id}
        onSelect={vi.fn()}
        onPlace={vi.fn()}
        onOpenSource={vi.fn()}
        onRefresh={vi.fn()}
        onSelectUsage={vi.fn()}
        onForkLibrary={onForkLibrary}
      />
    );

    expect(screen.getByText('Library Components')).toBeInTheDocument();
    expect(screen.getByText('@acme/ui · v1.2.0')).toBeInTheDocument();
    expect(screen.getByText('Library-owned · read-only in this project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy to project' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Library fork destination file' }), {
      target: { value: 'src/components/Example.tsx' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review copy' }));
    expect(onForkLibrary).toHaveBeenCalledWith({
      componentId: component.id,
      destinationFile: 'src/components/Example.tsx',
    });
  });
});
