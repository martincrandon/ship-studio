import { describe, expect, it } from 'vitest';
import { applyTextEdits, sha256 } from '../ranges';
import { bindComponentSelection, buildComponentIndex, planStaticPropEdit } from '../index';
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

describe('Svelte component adapter', () => {
  it('catalogs legacy props, slots, and source-anchored usages', () => {
    const source = snapshot([
      file(
        'src/Card.svelte',
        `<script lang="ts">
export let title: string;
</script>
<article><slot name="footer" /></article>
`
      ),
      file(
        'src/routes/+page.svelte',
        `<script lang="ts">
import Card from '../Card.svelte';
</script>
<main><Card title="Launch" /></main>
`
      ),
    ]);

    const index = buildComponentIndex(source, { projectType: 'sveltekit' });
    const card = index.components.find((component) => component.name === 'Card');
    const instance = index.instances.find((candidate) => candidate.componentId === card?.id);

    expect(index.profile.dialects).toEqual(['svelte']);
    expect(card).toMatchObject({
      dialect: 'svelte',
      usageCount: 1,
      props: [expect.objectContaining({ name: 'title', control: 'text' })],
      slots: [expect.objectContaining({ name: 'footer' })],
    });
    expect(instance?.props.title).toMatchObject({
      kind: 'static',
      value: { kind: 'string', value: 'Launch' },
    });
    expect(
      bindComponentSelection(
        { file: instance?.invocation.file, line: instance?.invocation.line, symbolHint: 'Card' },
        index
      )
    ).toMatchObject({ confidence: 'sourceAnchored', componentId: card?.id });
  });

  it('edits a static prop and refuses a dynamic expression', () => {
    const page = `<script>
import Card from './Card.svelte';
let title = 'Launch';
</script>
<Card title="Old" /><Card title={title} />
`;
    const source = snapshot([
      file(
        'src/Card.svelte',
        '<script>export let title: string;</script><article><slot /></article>'
      ),
      file('src/Page.svelte', page),
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
