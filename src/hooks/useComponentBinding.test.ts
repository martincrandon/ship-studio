import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildComponentIndex } from '../lib/components';
import { sha256 } from '../lib/components/ranges';
import type {
  ComponentFocusSession,
  ComponentSourceSnapshot,
  SourceFileSnapshot,
  SourceRef,
} from '../lib/components/types';
import { useComponentBinding } from './useComponentBinding';

function file(path: string, content: string): SourceFileSnapshot {
  return { file: path, content, contentHash: sha256(content) };
}

function fixture() {
  const card = file('src/Card.tsx', 'export function Card() { return <section>Card</section>; }');
  const page = file(
    'src/Page.tsx',
    "import { Card } from './Card'; export function Page() { return <main><Card /></main>; }"
  );
  const snapshot: ComponentSourceSnapshot = {
    workspaceRoot: '.',
    revision: sha256(`${card.file}:${card.contentHash}\n${page.file}:${page.contentHash}`),
    files: [card, page],
    partial: false,
    diagnostics: [],
  };
  const index = buildComponentIndex(snapshot, { projectType: 'vite' });
  const component = index.components.find((item) => item.name === 'Card')!;
  const instance = index.instances.find((item) => item.componentId === component.id)!;
  const session: ComponentFocusSession = {
    componentId: component.id,
    instanceId: instance.id,
    name: component.name,
    hostNodeIds: [3],
    definition: component.definition,
    invocation: instance.invocation,
    indexRevision: index.revision,
    ancestry: [],
    routeKey: '/',
  };
  const inside: SourceRef = {
    ...component.definition,
    start: component.definition.start + 1,
    end: component.definition.start + 8,
  };
  const outside: SourceRef = {
    ...inside,
    file: 'src/Page.tsx',
  };
  return { index, session, inside, outside };
}

describe('useComponentBinding', () => {
  it('keeps the focused editor context revision- and range-bound', () => {
    const { index, session, inside, outside } = fixture();
    const { result, rerender } = renderHook(
      ({ selectedChild, routeKey, currentIndex }) =>
        useComponentBinding({
          index: currentIndex,
          session,
          routeKey,
          selectedChild,
        }),
      { initialProps: { selectedChild: inside, routeKey: '/', currentIndex: index } }
    );

    expect(result.current).toMatchObject({
      componentId: session.componentId,
      instanceId: session.instanceId,
      indexRevision: index.revision,
      selectedChild: inside,
      usageCount: 1,
      affectsAllUsages: true,
    });

    rerender({ selectedChild: outside, routeKey: '/', currentIndex: index });
    expect(result.current?.selectedChild).toBeNull();

    rerender({ selectedChild: inside, routeKey: '/other', currentIndex: index });
    expect(result.current).toBeNull();

    rerender({
      selectedChild: inside,
      routeKey: '/',
      currentIndex: { ...index, revision: 'stale-revision' },
    });
    expect(result.current).toBeNull();
  });
});
