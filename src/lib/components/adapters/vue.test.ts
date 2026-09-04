import { describe, expect, it } from 'vitest';
import { applyTextEdits, sha256 } from '../ranges';
import { buildComponentIndex, bindComponentSelection, planStaticPropEdit } from '../index';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from '../types';

function file(path: string, content: string): SourceFileSnapshot {
  return { file: path, content, contentHash: sha256(content) };
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

describe('Vue component adapter', () => {
  it('catalogs script-setup props, named slots, and imported template usages', () => {
    const source = snapshot([
      file(
        'src/components/Card.vue',
        `<script setup lang="ts">
interface Props {
  title: string;
  tone?: 'neutral' | 'accent';
}
defineProps<Props>();
</script>
<template><article><slot name="footer" /></article></template>
`
      ),
      file(
        'src/pages/index.vue',
        `<script setup lang="ts">
import Card from '../components/Card.vue';
</script>
<template><main><Card title="Launch" tone="accent" /></main></template>
`
      ),
    ]);

    const index = buildComponentIndex(source, { projectType: 'nuxt' });
    const card = index.components.find((component) => component.name === 'Card');
    const instance = index.instances.find((candidate) => candidate.componentId === card?.id);

    expect(index.profile.dialects).toEqual(['vue']);
    expect(card).toMatchObject({
      dialect: 'vue',
      usageCount: 1,
      props: [
        expect.objectContaining({ name: 'title', control: 'text' }),
        expect.objectContaining({ name: 'tone', control: 'select' }),
      ],
      slots: [expect.objectContaining({ name: 'footer' })],
    });
    expect(instance?.props.tone).toMatchObject({
      kind: 'static',
      value: { kind: 'string', value: 'accent' },
    });

    expect(
      bindComponentSelection(
        {
          file: instance?.invocation.file,
          line: instance?.invocation.line,
          symbolHint: 'Card',
          sourceHash: instance?.invocation.contentHash,
        },
        index
      )
    ).toMatchObject({ confidence: 'sourceAnchored', componentId: card?.id });
  });

  it('edits a static template prop while refusing a Vue binding expression', () => {
    const page = `<script setup>
import Card from './Card.vue';
const title = 'Launch';
</script>
<template><Card title="Old" /><Card :title="title" /></template>
`;
    const source = snapshot([
      file(
        'src/Card.vue',
        '<script setup lang="ts">defineProps<{ title?: string }>();</script><template><article><slot /></article></template>'
      ),
      file('src/Page.vue', page),
    ]);
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const card = index.components.find((component) => component.name === 'Card')!;
    const instances = index.instances.filter((instance) => instance.componentId === card.id);

    const planned = planStaticPropEdit(
      {
        kind: 'prop',
        instanceId: instances[0].id,
        propName: 'title',
        value: { kind: 'string', value: 'New' },
      },
      index,
      source
    );
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      expect(applyTextEdits(page, planned.plan.files[0].edits)).toContain('title="New"');
    }

    expect(
      planStaticPropEdit(
        {
          kind: 'prop',
          instanceId: instances[1].id,
          propName: 'title',
          value: { kind: 'string', value: 'New' },
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-expression' });
  });
});
