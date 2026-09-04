import { describe, expect, it } from 'vitest';
import { applyTextEdits, sha256 } from '../ranges';
import {
  bindComponentSelection,
  buildComponentIndex,
  planInsertComponent,
  planStaticPropEdit,
} from '../index';
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

const heroSource = `---
interface Props {
  title: string;
}
const { title } = Astro.props;
---
<section class="hero"><h1>{title}</h1></section>
`;

const layoutSource = `---
---
<html><body><slot /></body></html>
`;

const pageSource = `---
import Hero from '../components/Hero.astro';
import Layout from '../layouts/Layout.astro';
---
<Layout><Hero title="Launch" /></Layout>
`;

describe('Astro component adapter', () => {
  it('catalogs native definitions and resolves source usage without claiming an exact instance', () => {
    const source = snapshot([
      file('src/components/Hero.astro', heroSource),
      file('src/layouts/Layout.astro', layoutSource),
      file('src/pages/index.astro', pageSource),
    ]);
    const index = buildComponentIndex(source, { projectType: 'astro' });
    const hero = index.components.find((component) => component.name === 'Hero');
    const layout = index.components.find((component) => component.name === 'Layout');

    expect(index.profile.primaryDialect).toBe('astro');
    expect(index.components.map((component) => component.name)).toEqual(['Hero', 'Layout']);
    expect(layout?.kind).toBe('layout');
    expect(hero?.capabilities).toMatchObject({
      catalog: true,
      usageGraph: true,
      definitionBinding: true,
      instanceBinding: false,
      focusedVisualEditing: false,
    });
    expect(index.instances).toHaveLength(2);
    expect(
      index.instances.find((instance) => instance.componentId === hero?.id)?.props.title
    ).toEqual(
      expect.objectContaining({
        kind: 'static',
        value: { kind: 'string', value: 'Launch' },
      })
    );

    const heroUsage = index.instances.find((instance) => instance.componentId === hero?.id);
    const binding = bindComponentSelection(
      {
        file: 'src/pages/index.astro',
        line: heroUsage?.invocation.line,
        symbolHint: 'Hero',
        sourceHash: sha256(pageSource),
      },
      index
    );

    expect(binding).toMatchObject({
      confidence: 'sourceAnchored',
      componentId: hero?.id,
    });
    expect(binding).not.toHaveProperty('instanceId');
  });

  it('plans native placement into an Astro template and preserves frontmatter imports', () => {
    const source = snapshot([
      file('src/components/Hero.astro', heroSource),
      file('src/layouts/Layout.astro', layoutSource),
      file('src/pages/index.astro', pageSource),
    ]);
    const index = buildComponentIndex(source, { projectType: 'astro' });
    const hero = index.components.find((component) => component.name === 'Hero');

    expect(
      bindComponentSelection(
        {
          file: 'src/components/Hero.astro',
          line: 7,
          symbolHint: 'Hero',
          sourceHash: 'stale-hash',
        },
        index
      )
    ).toMatchObject({ confidence: 'none' });

    const planned = planInsertComponent(
      {
        kind: 'insert',
        componentId: hero!.id,
        anchor: {
          file: 'src/pages/index.astro',
          line: 5,
          html: '<Layout>',
          position: 'inside',
        },
        props: { title: { kind: 'string', value: 'Second' } },
      },
      index,
      source
    );
    expect(planned).toMatchObject({
      status: 'planned',
      plan: {
        dialect: 'astro',
        parserToken: 'astro-component-plan-v1',
        expectedGraphDelta: { delta: 1 },
      },
    });
    if (planned.status === 'planned') {
      const mutation = planned.plan.files[0];
      expect(applyTextEdits(pageSource, mutation.edits)).toContain('<Hero title="Second" />');
      expect(applyTextEdits(pageSource, mutation.edits)).toContain(
        "import Hero from '../components/Hero.astro';"
      );
    }
  });

  it('creates a minimal frontmatter fence when placement needs a new Astro import', () => {
    const componentSource = file(
      'src/components/Card.astro',
      '---\ninterface Props { label: string }\n---\n<article>{Astro.props.label}</article>\n'
    );
    const page = '<main>\n  <section></section>\n</main>\n';
    const source = snapshot([componentSource, file('src/pages/index.astro', page)]);
    const index = buildComponentIndex(source, { projectType: 'astro' });
    const card = index.components.find((component) => component.name === 'Card');
    const planned = planInsertComponent(
      {
        kind: 'insert',
        componentId: card!.id,
        anchor: { file: 'src/pages/index.astro', line: 2, html: '<section>', position: 'inside' },
        props: { label: { kind: 'string', value: 'Card' } },
      },
      index,
      source
    );
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      const result = applyTextEdits(page, planned.plan.files[0].edits);
      expect(result).toContain('import Card from "../components/Card.astro";');
      expect(result).toContain('<Card label="Card" />');
      expect(result).toMatch(/^---\nimport Card/);
    }
  });

  it('edits a statically authored Astro usage and refuses dynamic values', () => {
    const staticPage = `---\nimport Hero from '../components/Hero.astro';\n---\n<Hero title="Launch" />\n`;
    const source = snapshot([
      file('src/components/Hero.astro', heroSource),
      file('src/pages/index.astro', staticPage),
    ]);
    const index = buildComponentIndex(source, { projectType: 'astro' });
    const hero = index.components.find((component) => component.name === 'Hero')!;
    const instance = index.instances.find((item) => item.componentId === hero.id)!;
    const planned = planStaticPropEdit(
      {
        kind: 'prop',
        instanceId: instance.id,
        propName: 'title',
        value: { kind: 'string', value: 'Updated' },
      },
      index,
      source
    );
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      expect(applyTextEdits(staticPage, planned.plan.files[0].edits)).toContain(
        '<Hero title="Updated" />'
      );
    }

    const dynamicPage = `---\nimport Hero from '../components/Hero.astro';\nconst title = 'Launch';\n---\n<Hero title={title} />\n`;
    const dynamicSource = snapshot([
      file('src/components/Hero.astro', heroSource),
      file('src/pages/index.astro', dynamicPage),
    ]);
    const dynamicIndex = buildComponentIndex(dynamicSource, { projectType: 'astro' });
    const dynamicInstance = dynamicIndex.instances[0];
    expect(
      planStaticPropEdit(
        {
          kind: 'prop',
          instanceId: dynamicInstance.id,
          propName: 'title',
          value: { kind: 'string', value: 'Updated' },
        },
        dynamicIndex,
        dynamicSource
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-expression' });
  });
});
