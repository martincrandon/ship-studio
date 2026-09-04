import { describe, expect, it } from 'vitest';
import { buildComponentIndex, planStaticSlotEdit } from './index';
import { applyTextEdits, sha256 } from './ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from './types';

function snapshot(contents: Record<string, string>): ComponentSourceSnapshot {
  const files: SourceFileSnapshot[] = Object.entries(contents).map(([file, content]) => ({
    file,
    content,
    contentHash: sha256(content),
  }));
  return {
    workspaceRoot: '.',
    revision: 'revision-slots',
    files,
    partial: false,
    diagnostics: [],
  };
}

describe('static component slot editing', () => {
  it('edits an exact React default slot while preserving surrounding source', () => {
    const source = snapshot({
      'components/Card.tsx': 'export function Card() { return <section />; }\n',
      'app/page.tsx': `import { Card } from '../components/Card';
export function Page() {
  return <Card>\n    <span className="old">Old</span>\n  </Card>;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const instance = index.instances.find((item) => item.componentId.endsWith('#Card'))!;
    expect(instance.slotSources?.children).toBeDefined();

    const result = planStaticSlotEdit(
      {
        kind: 'slot',
        instanceId: instance.id,
        slotName: 'children',
        replacementSource: '<span className="new">New</span>',
      },
      index,
      source
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const mutation = result.plan.files[0];
    const after = applyTextEdits(
      source.files.find((file) => file.file === 'app/page.tsx')!.content,
      mutation.edits
    );
    expect(after).toContain('<Card>\n    <span className="new">New</span>\n  </Card>');
    expect(result.plan.expectedGraphDelta).toMatchObject({
      componentId: instance.componentId,
      usagesBefore: 1,
      usagesAfter: 1,
      delta: 0,
    });
  });

  it('accepts the default alias for markup adapters and refuses dynamic slot bodies', () => {
    const source = snapshot({
      'components/Card.vue': `<script setup>defineProps({ title: String })</script>
<template><section><slot /></section></template>
`,
      'app/App.vue': `<script setup>import Card from '../components/Card.vue'; const title = 'Hi';</script>
<template><Card><strong>Old</strong></Card><Card>{{ title }}</Card></template>
`,
    });
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const instances = index.instances.filter((item) => item.componentId.endsWith('#default'));
    expect(instances).toHaveLength(2);

    const staticResult = planStaticSlotEdit(
      {
        kind: 'slot',
        instanceId: instances[0].id,
        slotName: 'default',
        replacementSource: '<em>New</em>',
      },
      index,
      source
    );
    expect(staticResult.status).toBe('planned');

    const dynamicResult = planStaticSlotEdit(
      {
        kind: 'slot',
        instanceId: instances[1].id,
        slotName: 'default',
        replacementSource: '<em>New</em>',
      },
      index,
      source
    );
    expect(dynamicResult).toMatchObject({ status: 'refused', code: 'dynamic-slot' });
  });

  it('indexes and edits an explicit Vue named slot without touching the wrapper', () => {
    const source = snapshot({
      'components/Card.vue': '<template><article><slot name="title" /></article></template>\n',
      'app/App.vue':
        "<script setup>import Card from '../components/Card.vue';</script>\n" +
        '<template><Card><template #title><strong>Old</strong></template></Card></template>\n',
    });
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const instance = index.instances.find((item) => item.componentId.endsWith('#default'))!;

    expect(instance.slots).toEqual([
      expect.objectContaining({ name: 'title', sourceText: '<strong>Old</strong>' }),
    ]);
    const result = planStaticSlotEdit(
      {
        kind: 'slot',
        instanceId: instance.id,
        slotName: 'title',
        replacementSource: '<em>New</em>',
      },
      index,
      source
    );
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const after = applyTextEdits(
      source.files.find((file) => file.file === 'app/App.vue')!.content,
      result.plan.files[0].edits
    );
    expect(after).toContain('<template #title><em>New</em></template>');
    expect(after).toContain('<Card>');
  });

  it('refuses missing slot ranges, stale content, and no-op edits', () => {
    const source = snapshot({
      'components/Card.tsx': 'export function Card() { return <section />; }\n',
      'app/page.tsx':
        'import { Card } from "../components/Card"; export function Page() { return <Card />; }',
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const instance = index.instances.find((item) => item.componentId.endsWith('#Card'))!;
    expect(
      planStaticSlotEdit(
        { kind: 'slot', instanceId: instance.id, slotName: 'children', replacementSource: 'New' },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'missing-slot' });

    const staleIndex = {
      ...index,
      instances: index.instances.map((candidate) =>
        candidate.id === instance.id
          ? {
              ...candidate,
              slotSources: {
                children: { ...candidate.invocation, contentHash: 'stale' },
              },
            }
          : candidate
      ),
    };
    expect(
      planStaticSlotEdit(
        { kind: 'slot', instanceId: instance.id, slotName: 'children', replacementSource: 'New' },
        staleIndex,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });
});
