import { describe, expect, it } from 'vitest';
import { buildComponentIndex, planStaticPropEdit, planStaticSlotEdit } from './index';
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
  it('removes an optional React prop and refuses required-prop resets', () => {
    const source = snapshot({
      'components/Card.tsx':
        'export function Card({ title, required }: { title?: string; required: string }) { return <section />; }\n',
      'app/page.tsx':
        'import { Card } from "../components/Card"; export function Page() { return <Card title="Custom" required="yes" />; }',
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const instance = index.instances.find((item) => item.componentId.endsWith('#Card'))!;
    const reset = planStaticPropEdit(
      { kind: 'prop', operation: 'remove', instanceId: instance.id, propName: 'title' },
      index,
      source
    );
    expect(reset.status).toBe('planned');
    if (reset.status === 'planned') {
      const page = source.files.find((file) => file.file === 'app/page.tsx')!;
      expect(applyTextEdits(page.content, reset.plan.files[0].edits)).toContain(
        '<Card required="yes" />'
      );
    }
    expect(
      planStaticPropEdit(
        { kind: 'prop', operation: 'remove', instanceId: instance.id, propName: 'required' },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'required-prop' });
  });

  it('projects direct slot children and plans reviewed insert/remove structure changes', () => {
    const source = snapshot({
      'components/Card.tsx':
        'export function Card({ children }: { children?: React.ReactNode }) { return <section>{children}</section>; }\n',
      'components/Badge.tsx': 'export function Badge() { return <strong>Badge</strong>; }\n',
      'app/page.tsx':
        'import { Card } from "../components/Card"; import { Badge } from "../components/Badge"; export function Page() { return <Card><Badge /></Card>; }',
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const card = index.components.find((item) => item.name === 'Card')!;
    const cardInstance = index.instances.find((item) => item.componentId === card.id)!;
    const slot = cardInstance.slots.find((item) => item.name === 'children')!;
    expect(slot.children).toEqual([
      expect.objectContaining({ name: 'Badge', componentId: 'react:components/Badge.tsx#Badge' }),
    ]);
    const badgeInstance = index.instances.find((item) => item.componentId.endsWith('#Badge'))!;

    const removed = planStaticSlotEdit(
      {
        kind: 'slot',
        operation: 'remove',
        instanceId: cardInstance.id,
        slotName: 'children',
        childInstanceId: badgeInstance.id,
      },
      index,
      source
    );
    expect(removed.status).toBe('planned');
    if (removed.status === 'planned') {
      const page = source.files.find((file) => file.file === 'app/page.tsx')!;
      expect(applyTextEdits(page.content, removed.plan.files[0].edits)).not.toContain('<Badge');
    }

    const inserted = planStaticSlotEdit(
      {
        kind: 'slot',
        operation: 'insert',
        instanceId: cardInstance.id,
        slotName: 'children',
        componentId: badgeInstance.componentId,
      },
      index,
      source
    );
    expect(inserted).toMatchObject({ status: 'planned' });
  });

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

  it('enforces only explicit allowed-component slot metadata', () => {
    const source = snapshot({
      'components/Card.tsx':
        'export function Card({ children }: { children?: React.ReactNode }) { return <section>{children}</section>; }\n',
      'components/Badge.tsx': 'export function Badge() { return <strong>Badge</strong>; }\n',
      'components/Other.tsx': 'export function Other() { return <em>Other</em>; }\n',
      'app/page.tsx':
        'import { Card } from "../components/Card"; import { Badge } from "../components/Badge"; export function Page() { return <Card> </Card>; }',
    });
    const base = buildComponentIndex(source, { projectType: 'nextjs' });
    const card = base.components.find((item) => item.name === 'Card')!;
    const badge = base.components.find((item) => item.name === 'Badge')!;
    const cardInstance = base.instances.find((item) => item.componentId === card.id)!;
    const restricted = {
      ...base,
      components: base.components.map((item) =>
        item.id === card.id
          ? {
              ...item,
              slots: item.slots.map((slot) => ({
                ...slot,
                allowedComponentIds: ['react:components/Other.tsx#Other'],
              })),
            }
          : item
      ),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: cardInstance.id,
          slotName: 'children',
          componentId: badge.id,
        },
        restricted,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
  });

  it('covers nested and empty React structured slots through the real adapter path', () => {
    const source = snapshot({
      'components/Card.tsx':
        'export function Card({ children }: { children?: React.ReactNode }) { return <section>{children}</section>; }\n',
      'components/Panel.tsx':
        'export function Panel({ children }: { children?: React.ReactNode }) { return <div>{children}</div>; }\n',
      'components/Badge.tsx': 'export function Badge() { return <strong>Badge</strong>; }\n',
      'components/Other.tsx': 'export function Other() { return <em>Other</em>; }\n',
      'app/page.tsx': `import { Card } from "../components/Card";
import { Panel } from "../components/Panel";
import { Badge } from "../components/Badge";
export function Page() {
  return <><Card><Panel><Badge /></Panel></Card><Card></Card></>;
}
`,
      'app/dynamic.tsx': `import { Card } from "../components/Card";
const items = [];
export function DynamicPage() {
  return <Card>{items}</Card>;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const cards = index.instances.filter(
      (item) => item.componentId.endsWith('#Card') && item.invocation.file === 'app/page.tsx'
    );
    const panel = index.instances.find((item) => item.componentId.endsWith('#Panel'))!;
    const badge = index.instances.find((item) => item.componentId.endsWith('#Badge'))!;
    const dynamic = index.instances.find((item) => item.invocation.file === 'app/dynamic.tsx')!;

    expect(cards).toHaveLength(2);
    expect(cards[0].slots[0]?.children).toEqual([
      expect.objectContaining({ instanceId: panel.id }),
    ]);
    expect(panel.slots[0]?.children).toEqual([expect.objectContaining({ instanceId: badge.id })]);

    const nestedRemove = planStaticSlotEdit(
      {
        kind: 'slot',
        operation: 'remove',
        instanceId: panel.id,
        slotName: 'children',
        childInstanceId: badge.id,
      },
      index,
      source
    );
    expect(nestedRemove.status).toBe('planned');

    const emptyCardInsert = planStaticSlotEdit(
      {
        kind: 'slot',
        operation: 'insert',
        instanceId: cards[1].id,
        slotName: 'children',
        componentId: badge.componentId,
      },
      index,
      source
    );
    expect(emptyCardInsert.status).toBe('planned');
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: dynamic.id,
          slotName: 'children',
          componentId: badge.componentId,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-slot' });
  });

  it('covers Svelte default and nested slot child removal through the adapter path', () => {
    const source = snapshot({
      'src/Card.svelte': '<script>export let title;</script><article><slot /></article>',
      'src/Panel.svelte': '<div><slot /></div>',
      'src/Badge.svelte': '<strong>Badge</strong>',
      'src/Page.svelte': `<script>
import Card from './Card.svelte';
import Panel from './Panel.svelte';
import Badge from './Badge.svelte';
</script>
<Card><Panel><Badge /></Panel></Card>
`,
    });
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const card = index.instances.find((item) => item.componentId.endsWith('Card.svelte#default'))!;
    const panel = index.instances.find((item) =>
      item.componentId.endsWith('Panel.svelte#default')
    )!;
    const badge = index.instances.find((item) =>
      item.componentId.endsWith('Badge.svelte#default')
    )!;

    expect(card.slots).toEqual([expect.objectContaining({ name: 'default' })]);
    expect(panel.slots[0]?.children).toEqual([expect.objectContaining({ instanceId: badge.id })]);
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: panel.id,
          slotName: 'default',
          childInstanceId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
  });

  it('covers Svelte empty, named, restricted, stale, and dynamic slot paths', () => {
    const source = snapshot({
      'src/Card.svelte': '<article><slot name="title" /><slot /></article>',
      'src/Panel.svelte': '<div><slot /></div>',
      'src/Badge.svelte': '<strong>Badge</strong>',
      'src/Other.svelte': '<em>Other</em>',
      'src/Page.svelte': `<script>
import Card from './Card.svelte';
import Panel from './Panel.svelte';
import Badge from './Badge.svelte';
</script>
<Card><Panel><Badge /></Panel></Card>
<Card></Card>
`,
      'src/Named.svelte': `<script>import Card from './Card.svelte';</script>
<Card><strong slot="title">Title</strong></Card>
`,
      'src/Dynamic.svelte': `<script>
import Card from './Card.svelte';
let items = [];
</script>
<Card>{items}</Card>
`,
    });
    const index = buildComponentIndex(source, { projectType: 'sveltekit' });
    const card = index.components.find((item) => item.name === 'Card')!;
    const nestedCard = index.instances.find(
      (item) =>
        item.componentId === card.id &&
        item.invocation.file === 'src/Page.svelte' &&
        item.slots[0]?.children?.length
    )!;
    const panel = index.instances.find((item) =>
      item.componentId.endsWith('Panel.svelte#default')
    )!;
    const empty = index.instances.find(
      (item) =>
        item.componentId === card.id &&
        item.invocation.file === 'src/Page.svelte' &&
        item.slotSources?.default?.start === item.slotSources?.default?.end
    )!;
    const named = index.instances.find(
      (item) => item.componentId === card.id && item.invocation.file === 'src/Named.svelte'
    )!;
    const dynamic = index.instances.find(
      (item) => item.componentId === card.id && item.invocation.file === 'src/Dynamic.svelte'
    )!;
    const badge = index.components.find((item) => item.name === 'Badge')!;
    const other = index.components.find((item) => item.name === 'Other')!;
    const panelChild = (panel.slots[0]?.children ?? []).find(
      (child) => child.componentId === badge.id
    )!;

    expect(card.capabilities.editSlots).toBe(true);
    expect(card.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'default' }),
        expect.objectContaining({ name: 'title' }),
      ])
    );
    expect(nestedCard.slots[0]?.children).toEqual([
      expect.objectContaining({ componentId: panel.componentId }),
    ]);
    expect(panel.slots[0]?.children).toEqual([expect.objectContaining({ componentId: badge.id })]);
    expect(empty.slotSources?.default?.start).toBe(empty.slotSources?.default?.end);
    expect(named.slots).toEqual([expect.objectContaining({ name: 'title' })]);

    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: panel.id,
          slotName: 'default',
          childInstanceId: panelChild.instanceId,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: empty.id,
          slotName: 'default',
          componentId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: dynamic.id,
          slotName: 'default',
          componentId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-slot' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          instanceId: named.id,
          slotName: 'title',
          replacementSource: '<em>New</em>',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });

    const restricted = {
      ...index,
      components: index.components.map((item) =>
        item.id === card.id
          ? {
              ...item,
              slots: item.slots.map((slot) =>
                slot.name === 'default' ? { ...slot, allowedComponentIds: [other.id] } : slot
              ),
            }
          : item
      ),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: empty.id,
          slotName: 'default',
          componentId: badge.id,
        },
        restricted,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
    const stale = {
      ...index,
      instances: index.instances.map((item) => {
        if (item.id !== panel.id || !item.slotSources?.default) return item;
        return {
          ...item,
          slotSources: {
            ...item.slotSources,
            default: { ...item.slotSources.default, contentHash: 'stale' },
          },
        };
      }),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: panel.id,
          slotName: 'default',
          childInstanceId: panelChild.instanceId,
        },
        stale,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });

  it('covers Vue default slots, dynamic refusal, and stale structured ranges', () => {
    const source = snapshot({
      'src/Card.vue': '<template><article><slot /><slot name="title" /></article></template>',
      'src/Badge.vue': '<template><strong>Badge</strong></template>',
      'src/Page.vue': `<script setup>
import Card from './Card.vue';
import Badge from './Badge.vue';
const title = 'dynamic';
</script>
<template>
  <Card><Badge /></Card>
  <Card><span>{{ title }}</span></Card>
</template>
`,
    });
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const cards = index.instances.filter((item) => item.componentId.endsWith('Card.vue#default'));
    const badge = index.instances.find((item) => item.componentId.endsWith('Badge.vue#default'))!;
    expect(cards).toHaveLength(2);
    expect(index.components.find((item) => item.name === 'Card')?.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'default' }),
        expect.objectContaining({ name: 'title' }),
      ])
    );
    const defaultCard = cards[0];
    const dynamicCard = cards[1];

    expect(defaultCard.slots).toEqual([expect.objectContaining({ name: 'default' })]);
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: defaultCard.id,
          slotName: 'default',
          childInstanceId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: dynamicCard.id,
          slotName: 'default',
          componentId: badge.componentId,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-slot' });

    const staleIndex = {
      ...index,
      instances: index.instances.map((candidate) => {
        if (candidate.id !== defaultCard.id || !candidate.slotSources?.default) return candidate;
        return {
          ...candidate,
          slotSources: {
            ...candidate.slotSources,
            default: { ...candidate.slotSources.default, contentHash: 'stale' },
          },
        };
      }),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: defaultCard.id,
          slotName: 'default',
          childInstanceId: badge.id,
        },
        staleIndex,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });

  it('covers Vue nested, empty, named, restricted, stale, and dynamic slots', () => {
    const source = snapshot({
      'src/Card.vue': '<template><article><slot /><slot name="title" /></article></template>',
      'src/Panel.vue': '<template><div><slot /></div></template>',
      'src/Badge.vue': '<template><strong>Badge</strong></template>',
      'src/Other.vue': '<template><em>Other</em></template>',
      'src/Page.vue': `<script setup>
import Card from './Card.vue';
import Panel from './Panel.vue';
import Badge from './Badge.vue';
</script>
<template>
  <Card><Panel><Badge /></Panel></Card>
  <Card></Card>
</template>
`,
      'src/NamedPage.vue': `<script setup>import Card from './Card.vue';</script>
<template><Card><strong slot="title">Title</strong></Card></template>
`,
      'src/DynamicPage.vue': `<script setup>
import Card from './Card.vue';
const items = [];
</script>
<template><Card>{{ items }}</Card></template>
`,
    });
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const card = index.components.find((item) => item.name === 'Card')!;
    const panel = index.instances.find((item) => item.componentId.endsWith('Panel.vue#default'))!;
    const badge = index.components.find((item) => item.name === 'Badge')!;
    const pageCards = index.instances.filter(
      (item) => item.componentId === card.id && item.invocation.file === 'src/Page.vue'
    );
    const nested = pageCards.find((item) => item.slots[0]?.children?.[0]?.instanceId === panel.id)!;
    const empty = pageCards.find(
      (item) => item.slotSources?.default?.start === item.slotSources?.default?.end
    )!;
    const named = index.instances.find(
      (item) => item.componentId === card.id && item.invocation.file === 'src/NamedPage.vue'
    )!;
    const dynamic = index.instances.find(
      (item) => item.componentId === card.id && item.invocation.file === 'src/DynamicPage.vue'
    )!;
    const panelChild = (nested.slots[0]?.children ?? []).find(
      (child) => child.instanceId === panel.id
    )!;
    const other = index.components.find((item) => item.name === 'Other')!;

    expect(card.capabilities.editSlots).toBe(true);
    expect(card.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'default' }),
        expect.objectContaining({ name: 'title' }),
      ])
    );
    expect(nested.slots[0]?.children).toEqual([
      expect.objectContaining({ componentId: panel.componentId }),
    ]);
    expect(empty.slotSources?.default?.start).toBe(empty.slotSources?.default?.end);
    expect(named.slots).toEqual([expect.objectContaining({ name: 'title' })]);

    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: nested.id,
          slotName: 'default',
          childInstanceId: panelChild.instanceId,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: empty.id,
          slotName: 'default',
          componentId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          instanceId: named.id,
          slotName: 'title',
          replacementSource: '<em>New</em>',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: dynamic.id,
          slotName: 'default',
          componentId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-slot' });

    const restricted = {
      ...index,
      components: index.components.map((item) =>
        item.id === card.id
          ? {
              ...item,
              slots: item.slots.map((slot) =>
                slot.name === 'default' ? { ...slot, allowedComponentIds: [other.id] } : slot
              ),
            }
          : item
      ),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: empty.id,
          slotName: 'default',
          componentId: badge.id,
        },
        restricted,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
    const stale = {
      ...index,
      instances: index.instances.map((item) => {
        if (item.id !== nested.id || !item.slotSources?.default) return item;
        return {
          ...item,
          slotSources: {
            ...item.slotSources,
            default: { ...item.slotSources.default, contentHash: 'stale' },
          },
        };
      }),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: nested.id,
          slotName: 'default',
          childInstanceId: panelChild.instanceId,
        },
        stale,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });

  it('covers web-component structured writes and refuses Shopify slots without source bodies', () => {
    const webSource = snapshot({
      'index.html': `<script>
customElements.define('x-card', class extends HTMLElement {});
</script>
<x-card><x-card></x-card></x-card>
<slot></slot>
`,
    });
    const webIndex = buildComponentIndex(webSource, { projectType: 'statichtml' });
    const webInstances = webIndex.instances.filter(
      (item) => item.componentId === 'web-component:index.html#default'
    );
    expect(webIndex.components[0]?.capabilities.editSlots).toBe(true);
    expect(webInstances).toHaveLength(2);
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: webInstances[0].id,
          slotName: 'default',
          childInstanceId: webInstances[1].id,
        },
        webIndex,
        webSource
      )
    ).toMatchObject({ status: 'planned' });

    const shopifySource = snapshot({
      'sections/card.liquid':
        '{% schema %}{"name":"Card","blocks":[{"type":"content"}]}{% endschema %}<section>{% content_for "blocks" %}</section>',
      'templates/index.json': '{"sections":{"main":{"type":"card"}}}',
    });
    const shopifyIndex = buildComponentIndex(shopifySource, { projectType: 'shopifytheme' });
    const card = shopifyIndex.components.find((item) => item.name === 'card')!;
    const instance = shopifyIndex.instances.find((item) => item.componentId === card.id)!;
    expect(card.capabilities.editSlots).toBe(true);
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: instance.id,
          slotName: 'blocks',
          componentId: card.id,
        },
        shopifyIndex,
        shopifySource
      )
    ).toMatchObject({ status: 'refused', code: 'missing-slot' });
  });

  it('covers Web Component nested, empty, named, restricted, stale, and dynamic slots', () => {
    const source = snapshot({
      'src/x-card.html': `<script>customElements.define('x-card', class extends HTMLElement {});</script>
<section><slot></slot><slot name="title"></slot></section>
`,
      'src/x-panel.html': `<script>customElements.define('x-panel', class extends HTMLElement {});</script>
<div><slot></slot></div>
`,
      'src/x-badge.html': `<script>customElements.define('x-badge', class extends HTMLElement {});</script>
<strong>Badge</strong>
`,
      'src/x-other.html': `<script>customElements.define('x-other', class extends HTMLElement {});</script>
<em>Other</em>
`,
      'src/Page.html': `<x-card><x-panel><x-badge></x-badge></x-panel></x-card>
<x-card></x-card>
<x-card><span slot="title">Title</span></x-card>
<x-card><script>runtimeGeneratedChildren();</script></x-card>
`,
    });
    const index = buildComponentIndex(source, { projectType: 'statichtml' });
    const card = index.components.find((item) => item.name === 'x-card')!;
    const panel = index.instances.find((item) =>
      item.componentId.endsWith('x-panel.html#default')
    )!;
    const badge = index.components.find((item) => item.name === 'x-badge')!;
    const pageCards = index.instances.filter(
      (item) => item.componentId === card.id && item.invocation.file === 'src/Page.html'
    );
    const nested = pageCards.find((item) => item.slots[0]?.children?.[0]?.instanceId === panel.id)!;
    const empty = pageCards.find(
      (item) => item.slotSources?.default?.start === item.slotSources?.default?.end
    )!;
    const named = pageCards.find((item) => item.slots[0]?.name === 'title')!;
    const dynamic = pageCards.find((item) => item.slots[0]?.sourceText?.includes('<script>'))!;
    const panelChild = (nested.slots[0]?.children ?? []).find(
      (child) => child.instanceId === panel.id
    )!;

    expect(card.capabilities.editSlots).toBe(true);
    expect(card.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'default' }),
        expect.objectContaining({ name: 'title' }),
      ])
    );
    expect(nested.slots[0]?.children).toEqual([
      expect.objectContaining({ componentId: panel.componentId }),
    ]);
    expect(empty.slotSources?.default?.start).toBe(empty.slotSources?.default?.end);
    expect(named.slots).toEqual([expect.objectContaining({ name: 'title' })]);

    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: nested.id,
          slotName: 'default',
          childInstanceId: panelChild.instanceId,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: empty.id,
          slotName: 'default',
          componentId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          instanceId: named.id,
          slotName: 'title',
          replacementSource: '<strong>New</strong>',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'planned' });
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: dynamic.id,
          slotName: 'default',
          componentId: badge.id,
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-slot' });

    const restricted = {
      ...index,
      components: index.components.map((item) =>
        item.id === card.id
          ? {
              ...item,
              slots: item.slots.map((slot) =>
                slot.name === 'default'
                  ? {
                      ...slot,
                      allowedComponentIds: [
                        index.components.find((candidate) => candidate.name === 'x-other')!.id,
                      ],
                    }
                  : slot
              ),
            }
          : item
      ),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: empty.id,
          slotName: 'default',
          componentId: badge.id,
        },
        restricted,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'unsupported' });
    const stale = {
      ...index,
      instances: index.instances.map((item) => {
        if (item.id !== nested.id || !item.slotSources?.default) return item;
        return {
          ...item,
          slotSources: {
            ...item.slotSources,
            default: { ...item.slotSources.default, contentHash: 'stale' },
          },
        };
      }),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'remove',
          instanceId: nested.id,
          slotName: 'default',
          childInstanceId: panelChild.instanceId,
        },
        stale,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });

  it('keeps Shopify block slots fail-closed when no authored body is available', () => {
    const source = snapshot({
      'sections/card.liquid': `{% schema %}
{"name":"Card","blocks":[{"type":"content"}]}
{% endschema %}
<section>{% content_for "blocks" %}</section>
`,
      'sections/badge.liquid': '{% schema %}{"name":"Badge"}{% endschema %}<strong>Badge</strong>',
      'templates/index.json': '{"sections":{"main":{"type":"card"}}}',
    });
    const index = buildComponentIndex(source, { projectType: 'shopifytheme' });
    const card = index.components.find((item) => item.name === 'card')!;
    const badge = index.components.find((item) => item.name === 'badge')!;
    const instance = index.instances.find((item) => item.componentId === card.id)!;

    expect(card.capabilities.editSlots).toBe(true);
    expect(card.slots).toEqual([expect.objectContaining({ name: 'blocks' })]);
    expect(instance.slots).toEqual([]);
    expect(instance.slotSources).toBeUndefined();
    for (const operation of ['insert', 'remove', 'reorder'] as const) {
      expect(
        planStaticSlotEdit(
          {
            kind: 'slot',
            operation,
            instanceId: instance.id,
            slotName: 'blocks',
            ...(operation === 'insert'
              ? { componentId: badge.id }
              : { childInstanceId: 'shopify:missing-child' }),
          },
          index,
          source
        )
      ).toMatchObject({ status: 'refused', code: 'missing-slot' });
    }
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          instanceId: instance.id,
          slotName: 'blocks',
          replacementSource: '<strong>New</strong>',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'missing-slot' });

    const stale = {
      ...index,
      instances: index.instances.map((item) =>
        item.id === instance.id
          ? {
              ...item,
              slots: [{ name: 'blocks', value: null }],
              slotSources: {
                blocks: {
                  ...item.invocation,
                  contentHash: 'stale',
                },
              },
            }
          : item
      ),
    };
    expect(
      planStaticSlotEdit(
        {
          kind: 'slot',
          operation: 'insert',
          instanceId: instance.id,
          slotName: 'blocks',
          componentId: badge.id,
        },
        stale,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });
});
