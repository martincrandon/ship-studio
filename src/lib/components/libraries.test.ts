import { describe, expect, it } from 'vitest';
import {
  compareComponentLibrary,
  discoverComponentLibraries,
  planLibraryFork,
  withComponentLibraries,
} from './libraries';
import { sha256 } from './ranges';
import type {
  ComponentDescriptor,
  ComponentImportEdge,
  ComponentIndex,
  ComponentSourceSnapshot,
  SourceFileSnapshot,
} from './types';

function file(fileName: string, content: string): SourceFileSnapshot {
  return { file: fileName, content, contentHash: sha256(content) };
}

function snapshot(files: SourceFileSnapshot[]): ComponentSourceSnapshot {
  return {
    workspaceRoot: '.',
    revision: sha256(files.map((entry) => `${entry.file}:${entry.contentHash}`).join('\n')),
    files,
    partial: false,
    diagnostics: [],
  };
}

function librarySnapshot() {
  return snapshot([
    file(
      'package.json',
      JSON.stringify({
        name: 'consumer',
        private: true,
        dependencies: { '@acme/ui': 'workspace:*' },
      })
    ),
    file(
      'packages/ui/package.json',
      JSON.stringify({
        name: '@acme/ui',
        version: '2.4.0',
        repository: { type: 'git', url: 'https://example.test/acme/ui.git' },
        exports: { '.': './src/index.ts' },
      })
    ),
    file('packages/ui/src/index.ts', "export { Button } from './Button';"),
    file(
      'packages/ui/src/Button.tsx',
      'export function Button() { return <button>Library button</button>; }'
    ),
    file(
      'src/Page.tsx',
      "import { Button } from '@acme/ui'; export function Page() { return <Button />; }"
    ),
  ]);
}

function sourceRef(file: string) {
  return { file, start: 0, end: 1, line: 1, column: 1, contentHash: 'ref-hash' };
}

function libraryIndex(source: ComponentSourceSnapshot): ComponentIndex {
  const button = source.files.find((file) => file.file === 'packages/ui/src/Button.tsx');
  if (!button) throw new Error('test library source is missing');
  const component: ComponentDescriptor = {
    id: 'react:packages/ui/src/Button.tsx#Button',
    dialect: 'react',
    kind: 'component',
    name: 'Button',
    localName: 'Button',
    exportName: 'Button',
    description: null,
    definition: {
      ...sourceRef(button.file),
      end: button.content.length,
      contentHash: button.contentHash,
    },
    props: [],
    slots: [],
    variantProps: [],
    usageCount: 1,
    capabilities: {} as ComponentDescriptor['capabilities'],
    diagnostics: [],
  };
  const reExport: ComponentImportEdge = {
    fromFile: 'packages/ui/src/index.ts',
    toFile: button.file,
    importedName: 'Button',
    localName: 'Button',
    source: sourceRef('packages/ui/src/index.ts'),
    status: 'resolved',
    diagnostics: [],
  };
  return {
    revision: source.revision,
    partial: false,
    profile: {} as ComponentIndex['profile'],
    components: [component],
    instances: [],
    importEdges: [reExport],
    diagnostics: [],
  };
}

describe('component library discovery', () => {
  it('detects explicitly exported workspace components and preserves known metadata', () => {
    const source = librarySnapshot();
    const index = libraryIndex(source);
    const libraries = discoverComponentLibraries(source, index.components, index.importEdges);

    expect(libraries).toEqual([
      expect.objectContaining({
        id: 'package:packages/ui:@acme/ui',
        packageName: '@acme/ui',
        packageRoot: 'packages/ui',
        version: '2.4.0',
        repository: 'https://example.test/acme/ui.git',
        ownership: 'library',
        componentIds: [expect.stringContaining('react:packages/ui/src/Button.tsx#Button')],
      }),
    ]);
  });

  it('publishes library metadata on the worker index without changing component DTOs', () => {
    const source = librarySnapshot();
    const index = libraryIndex(source);
    const enriched = withComponentLibraries(index, source);

    expect(enriched.libraries).toHaveLength(1);
    expect(enriched.components[0]).not.toHaveProperty('library');
  });

  it('plans a detached local fork and refuses destination collisions', () => {
    const source = librarySnapshot();
    const index = withComponentLibraries(libraryIndex(source), source);
    const component = index.components.find((item) => item.name === 'Button');
    if (!component) throw new Error('test library component was not indexed');

    const planned = planLibraryFork(
      {
        componentId: component.id,
        destinationFile: 'src/components/Button.tsx',
      },
      index,
      source
    );
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    const operation = planned.plan.operations?.[0];
    expect(operation?.kind).toBe('create');
    if (!operation || operation.kind !== 'create') return;
    expect(operation.file).toBe('src/components/Button.tsx');
    expect(operation.contents).toContain('export function Button');
    expect(planned.plan.warnings?.[0]?.code).toBe('library-fork-detaches-updates');

    const collision = snapshot([...source.files, file('src/components/Button.tsx', 'existing')]);
    const collisionIndex = withComponentLibraries(libraryIndex(collision), collision);
    const refused = planLibraryFork(
      { componentId: component.id, destinationFile: 'src/components/Button.tsx' },
      collisionIndex,
      collision
    );
    expect(refused).toMatchObject({ status: 'refused', code: 'path-collision' });
  });

  it('refuses a fork rename until binding-aware references can be updated', () => {
    const source = librarySnapshot();
    const index = withComponentLibraries(libraryIndex(source), source);
    const component = index.components[0];

    expect(
      planLibraryFork(
        {
          componentId: component.id,
          destinationFile: 'src/components/ButtonCopy.tsx',
          newName: 'ButtonCopy',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
  });

  it('refuses a fork when the copied definition has a relative dependency', () => {
    const source = librarySnapshot();
    const files = source.files.map((item) =>
      item.file === 'packages/ui/src/Button.tsx'
        ? file(
            item.file,
            "import { Icon } from './Icon'; export function Button() { return <Icon />; }"
          )
        : item
    );
    const next = snapshot(files);
    const index = withComponentLibraries(libraryIndex(next), next);
    const component = index.components.find((item) => item.name === 'Button');
    if (!component) throw new Error('test library component was not indexed');
    expect(
      planLibraryFork(
        { componentId: component.id, destinationFile: 'src/components/Button.tsx' },
        index,
        next
      )
    ).toMatchObject({ status: 'refused', code: 'unsafe-dependency-closure' });
  });

  it('reports only explicit package, export, contract, and resource changes', () => {
    const source = librarySnapshot();
    const index = withComponentLibraries(libraryIndex(source), source);
    const previous = index.libraries?.[0];
    if (!previous) throw new Error('library metadata is missing');
    const current = {
      ...previous,
      version: '2.5.0',
      contracts: previous.contracts?.map((contract) => ({
        ...contract,
        props: [{ name: 'tone', required: false, typeText: "'neutral'", choices: null }],
      })),
      resources: [{ kind: 'token' as const, id: 'color.accent', revision: '2' }],
    };
    const diff = compareComponentLibrary(previous, current);
    expect(diff.requiresDependencyPlan).toBe(true);
    expect(diff.changes.map((change) => change.kind)).toEqual(
      expect.arrayContaining(['package-metadata', 'component-contract', 'token'])
    );
  });

  it('reports same-file export identity changes as removed and added, not an inferred rename', () => {
    const source = librarySnapshot();
    const index = withComponentLibraries(libraryIndex(source), source);
    const previous = index.libraries?.[0];
    if (!previous) throw new Error('library metadata is missing');
    const previousContract = previous.contracts?.[0];
    if (!previousContract) throw new Error('library contract metadata is missing');
    const currentContract = {
      ...previousContract,
      componentId: previousContract.componentId.replace('#Button', '#PrimaryButton'),
      name: 'PrimaryButton',
      exportName: 'PrimaryButton',
    };

    const diff = compareComponentLibrary(previous, {
      ...previous,
      contracts: [currentContract],
    });

    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'removed-export', detail: 'Button' }),
        expect.objectContaining({ kind: 'added-export', detail: 'PrimaryButton' }),
      ])
    );
    expect(diff.changes.map((change) => change.kind)).not.toContain('renamed-export');
  });
});
