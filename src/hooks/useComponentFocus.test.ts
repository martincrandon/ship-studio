import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildComponentIndex } from '../lib/components';
import { sha256 } from '../lib/components/ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from '../lib/components/types';
import { useComponentFocus } from './useComponentFocus';
import type { ComponentTreeNode } from './useElementTree';

function file(path: string, content: string): SourceFileSnapshot {
  return { file: path, content, contentHash: sha256(content) };
}

function setup() {
  const card = file('src/Card.tsx', 'export function Card() { return <section>Card</section>; }');
  const badge = file('src/Badge.tsx', 'export function Badge() { return <span>Badge</span>; }');
  const page = file(
    'src/Page.tsx',
    "import { Card } from './Card'; import { Badge } from './Badge'; export function Page() { return <main><Card><Badge /></Card></main>; }"
  );
  const snapshot: ComponentSourceSnapshot = {
    workspaceRoot: '.',
    revision: sha256(
      `${card.file}:${card.contentHash}\n${badge.file}:${badge.contentHash}\n${page.file}:${page.contentHash}`
    ),
    files: [card, badge, page],
    partial: false,
    diagnostics: [],
  };
  const index = buildComponentIndex(snapshot, { projectType: 'vite' });
  const node = (
    currentIndex: typeof index,
    name: string,
    hostNodeIds: number[]
  ): ComponentTreeNode => {
    const component = currentIndex.components.find((item) => item.name === name)!;
    const instance = currentIndex.instances.find((item) => item.componentId === component.id)!;
    return {
      kind: 'component',
      key: instance.id,
      componentId: component.id,
      instanceId: instance.id,
      name: component.name,
      confidence: 'exact',
      hostNodeIds,
      definition: component.definition,
      invocation: instance.invocation,
      children: [],
    };
  };
  return { index, snapshot, node };
}

describe('useComponentFocus', () => {
  it('enters exact boundaries, nests, and unwinds one level at a time', () => {
    const { index, node } = setup();
    const outer = node(index, 'Card', [3, 4]);
    const nested = node(index, 'Badge', [4]);
    const { result } = renderHook(() => useComponentFocus({ index, routeKey: '/' }));

    let transition: ReturnType<typeof result.current.enter> = {
      status: 'refused',
      code: 'not-focused',
      diagnostics: [],
    };
    act(() => {
      transition = result.current.enter(outer);
    });
    expect(transition.status).toBe('entered');
    expect(result.current.path).toEqual([{ key: outer.instanceId, name: 'Card' }]);

    act(() => {
      transition = result.current.enter(nested);
    });
    expect(transition.status).toBe('changed');
    expect(result.current.path).toHaveLength(2);
    expect(result.current.path[0].name).toBe('Card');

    act(() => {
      transition = result.current.focusParent();
    });
    expect(transition.status).toBe('changed');
    expect(result.current.path).toEqual([{ key: outer.instanceId, name: 'Card' }]);

    act(() => {
      transition = result.current.exit();
    });
    expect(transition).toMatchObject({ status: 'changed', session: null });
    expect(result.current.path).toEqual([]);
  });

  it('refuses a non-exact boundary and a nested row outside the focused host set', () => {
    const { index, node } = setup();
    const { result } = renderHook(() => useComponentFocus({ index }));
    const sourceAnchored = {
      ...node(index, 'Card', [3]),
      confidence: 'sourceAnchored',
    } as unknown as ComponentTreeNode;
    expect(result.current.enter(sourceAnchored)).toMatchObject({
      status: 'refused',
      code: 'not-exact',
    });

    act(() => {
      result.current.enter(node(index, 'Card', [3]));
    });
    const outside = { ...node(index, 'Badge', [9]) };
    expect(result.current.enter(outside)).toMatchObject({
      status: 'refused',
      code: 'not-focused',
    });
  });

  it('keeps a stale session available for an exact same-instance HMR rebind', () => {
    const { index, snapshot: initialSnapshot, node } = setup();
    const { result, rerender } = renderHook(
      ({ currentIndex }) => useComponentFocus({ index: currentIndex, routeKey: '/' }),
      { initialProps: { currentIndex: index } }
    );
    act(() => {
      result.current.enter(node(index, 'Card', [3]));
    });

    const changedCard = file(
      'src/Card.tsx',
      'export function Card() { return <section className="updated">Card</section>; }'
    );
    const changedSnapshot: ComponentSourceSnapshot = {
      ...initialSnapshot,
      revision: sha256(
        `${changedCard.file}:${changedCard.contentHash}\n${initialSnapshot.files[1].file}:${initialSnapshot.files[1].contentHash}\n${initialSnapshot.files[2].file}:${initialSnapshot.files[2].contentHash}`
      ),
      files: [changedCard, initialSnapshot.files[1], initialSnapshot.files[2]],
    };
    const changedIndex = buildComponentIndex(changedSnapshot, { projectType: 'vite' });

    rerender({ currentIndex: changedIndex });
    expect(result.current.session?.indexRevision).toBe(index.revision);

    let transition: ReturnType<typeof result.current.rebind> = {
      status: 'refused',
      code: 'not-focused',
      diagnostics: [],
    };
    act(() => {
      transition = result.current.rebind(node(changedIndex, 'Card', [8]));
    });
    expect(transition).toMatchObject({ status: 'changed' });
    expect(result.current.session).toMatchObject({
      indexRevision: changedIndex.revision,
      hostNodeIds: [8],
    });
  });
});
