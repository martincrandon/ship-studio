import { describe, expect, it } from 'vitest';
import { buildComponentIndex } from './index';
import { projectComponentTree } from './component-tree';
import { sha256 } from './ranges';
import type {
  ComponentBoundary,
  ComponentFocusSession,
  ComponentSourceSnapshot,
  RawComponentTreeNode,
  SourceFileSnapshot,
} from './types';

function file(path: string, content: string): SourceFileSnapshot {
  return { file: path, content, contentHash: sha256(content) };
}

function fixture() {
  const card = file(
    'src/Card.tsx',
    `export function Card() {
  return <section className="card"><div className="card-body"><span>Card</span></div></section>;
}
`
  );
  const badge = file(
    'src/Badge.tsx',
    `export function Badge() {
  return <span className="badge">Badge</span>;
}
`
  );
  const page = file(
    'src/Page.tsx',
    `import { Card } from './Card';
import { Badge } from './Badge';
export function Page() {
  return <main><Card /><Badge /></main>;
}
`
  );
  const snapshot: ComponentSourceSnapshot = {
    workspaceRoot: '.',
    revision: sha256(
      [card, badge, page].map((entry) => `${entry.file}:${entry.contentHash}`).join('\n')
    ),
    files: [card, badge, page],
    partial: false,
    diagnostics: [],
  };
  const index = buildComponentIndex(snapshot, { projectType: 'vite' });
  const cardComponent = index.components.find((component) => component.name === 'Card')!;
  const badgeComponent = index.components.find((component) => component.name === 'Badge')!;
  const cardInstance = index.instances.find(
    (instance) => instance.componentId === cardComponent.id
  )!;
  const badgeInstance = index.instances.find(
    (instance) => instance.componentId === badgeComponent.id
  )!;
  return { index, cardComponent, badgeComponent, cardInstance, badgeInstance };
}

function boundary(
  component: ReturnType<typeof fixture>['cardComponent'],
  instance: ReturnType<typeof fixture>['cardInstance'],
  hostNodeIds: number[],
  indexRevision: string
): ComponentBoundary {
  return {
    key: instance.id,
    componentId: component.id,
    instanceId: instance.id,
    name: component.name,
    confidence: 'exact',
    hostNodeIds,
    definition: component.definition,
    invocation: instance.invocation,
    indexRevision,
  };
}

function hint(value: ComponentBoundary) {
  return { ...value };
}

const tree: RawComponentTreeNode = {
  id: 1,
  tag: 'body',
  cls: '',
  text: '',
  children: [
    {
      id: 2,
      tag: 'main',
      cls: '',
      text: '',
      children: [
        {
          id: 3,
          tag: 'section',
          cls: 'card',
          text: '',
          children: [{ id: 4, tag: 'div', cls: 'card-body', text: '', children: [] }],
        },
        { id: 5, tag: 'span', cls: 'badge', text: 'Badge', children: [] },
      ],
    },
  ],
};

describe('component tree projection', () => {
  it('keeps an exact boundary opaque until its focus session expands it', () => {
    const { index, cardComponent, cardInstance } = fixture();
    const cardBoundary = boundary(cardComponent, cardInstance, [3], index.revision);

    const collapsed = projectComponentTree({ tree, index, boundaries: [hint(cardBoundary)] });
    const collapsedMain = collapsed.tree?.kind === 'element' ? collapsed.tree.children[0] : null;
    expect(collapsedMain).toMatchObject({ kind: 'element', nodeId: 2 });
    expect(collapsedMain?.children).toHaveLength(2);
    expect(collapsedMain?.children[0]).toMatchObject({
      kind: 'component',
      instanceId: cardInstance.id,
      hostNodeIds: [3],
      children: [],
    });

    const focused: ComponentFocusSession = {
      ...cardBoundary,
      ancestry: [],
      routeKey: null,
    };
    const expanded = projectComponentTree({
      tree,
      index,
      boundaries: [hint(cardBoundary)],
      focus: focused,
    });
    const expandedCard =
      expanded.tree?.kind === 'element' ? expanded.tree.children[0].children[0] : null;
    expect(expandedCard?.kind).toBe('component');
    expect(expandedCard?.children).toMatchObject([
      { kind: 'element', nodeId: 4, tag: 'div', children: [] },
    ]);
  });

  it('preserves multi-root instances as one component row', () => {
    const { index, cardComponent, cardInstance } = fixture();
    const multiRootTree: RawComponentTreeNode = {
      id: 1,
      tag: 'body',
      cls: '',
      text: '',
      children: [
        { id: 3, tag: 'section', cls: 'card', text: '', children: [] },
        { id: 4, tag: 'aside', cls: 'card', text: '', children: [] },
      ],
    };
    const result = projectComponentTree({
      tree: multiRootTree,
      index,
      boundaries: [hint(boundary(cardComponent, cardInstance, [3, 4], index.revision))],
    });
    expect(result.tree?.kind).toBe('element');
    expect(result.tree?.children).toMatchObject([
      {
        kind: 'component',
        hostNodeIds: [3, 4],
      },
    ]);
    expect(result.tree?.children).toHaveLength(1);
  });

  it('shows nested exact boundaries only after the containing component is focused', () => {
    const { index, cardComponent, badgeComponent, cardInstance, badgeInstance } = fixture();
    const cardBoundary = boundary(cardComponent, cardInstance, [3], index.revision);
    const badgeBoundary = boundary(badgeComponent, badgeInstance, [5], index.revision);

    const outerFocus: ComponentFocusSession = {
      ...cardBoundary,
      ancestry: [],
      routeKey: null,
    };
    const result = projectComponentTree({
      tree,
      index,
      boundaries: [hint(cardBoundary), hint(badgeBoundary)],
      focus: outerFocus,
    });
    const main = result.tree?.kind === 'element' ? result.tree.children[0] : null;
    const outer = main?.children[0];
    expect(outer?.kind).toBe('component');
    expect(outer?.children).toMatchObject([{ kind: 'element', nodeId: 4 }]);
    // Badge is a sibling of Card in this raw snapshot, so it remains visible as
    // a nested projection candidate only when its own boundary is encountered.
    expect(main?.children[1]).toMatchObject({ kind: 'component', instanceId: badgeInstance.id });
  });

  it('leaves source-anchored or stale boundaries as ordinary DOM rows', () => {
    const { index, cardComponent, cardInstance } = fixture();
    const exact = boundary(cardComponent, cardInstance, [3], index.revision);
    const sourceAnchored = {
      ...hint(exact),
      confidence: 'sourceAnchored' as const,
      binding: {
        confidence: 'sourceAnchored' as const,
        componentId: exact.componentId,
        source: exact.invocation,
        candidates: [],
        diagnostics: [],
      },
    };
    const result = projectComponentTree({ tree, index, boundaries: [sourceAnchored] });
    const main = result.tree?.kind === 'element' ? result.tree.children[0] : null;
    expect(main?.children[0]).toMatchObject({ kind: 'element', nodeId: 3, tag: 'section' });
    expect(result.boundaries).toHaveLength(0);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === 'component-boundary-unproven')
    ).toBe(true);
  });
});
