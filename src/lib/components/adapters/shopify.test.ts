import { describe, expect, it } from 'vitest';
import { applyTextEdits, sha256 } from '../ranges';
import { bindComponentSelection, buildComponentIndex, planInsertComponent } from '../index';
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

describe('Shopify component adapter', () => {
  it('catalogs section schema settings and resolves Liquid/JSON render sites', () => {
    const source = snapshot([
      file(
        'sections/hero.liquid',
        `{% schema %}
{
  "name": "Hero",
  "settings": [
    { "type": "text", "id": "title", "default": "Launch" },
    { "type": "select", "id": "tone", "options": [{ "value": "neutral" }, { "value": "accent" }] }
  ],
  "blocks": [{ "type": "content" }]
}
{% endschema %}
<section><h1>{{ section.settings.title }}</h1>{% content_for 'blocks' %}</section>
`
      ),
      file('snippets/card.liquid', '<article>{{ title }}</article>'),
      file('layout/theme.liquid', `{% render 'card', title: "Hello" %}`),
      file('templates/index.json', '{"sections":{"main":{"type":"hero"}}}'),
    ]);

    const index = buildComponentIndex(source, { projectType: 'shopifytheme' });
    const hero = index.components.find((component) => component.name === 'hero');
    const card = index.components.find((component) => component.name === 'card');
    const heroUsage = index.instances.find((instance) => instance.componentId === hero?.id);
    const cardUsage = index.instances.find((instance) => instance.componentId === card?.id);

    expect(index.profile.dialects).toEqual(['shopify']);
    expect(hero).toMatchObject({
      dialect: 'shopify',
      kind: 'section',
      usageCount: 1,
      props: [
        expect.objectContaining({ name: 'title', control: 'text' }),
        expect.objectContaining({ name: 'tone', control: 'select' }),
      ],
      slots: [expect.objectContaining({ name: 'blocks' })],
    });
    expect(cardUsage?.props.title).toMatchObject({
      kind: 'static',
      value: { kind: 'string', value: 'Hello' },
    });
    expect(
      bindComponentSelection(
        { file: heroUsage?.invocation.file, line: heroUsage?.invocation.line, symbolHint: 'hero' },
        index
      )
    ).toMatchObject({ confidence: 'sourceAnchored', componentId: hero?.id });
  });

  it('places a section without inventing an import or evaluating Liquid', () => {
    const source = snapshot([
      file(
        'sections/hero.liquid',
        '{% schema %}{"settings": []}{% endschema %}<section></section>'
      ),
      file('templates/index.json', '{"sections":{"main":{"type":"hero"}}}'),
    ]);
    const index = buildComponentIndex(source, { projectType: 'shopifytheme' });
    const hero = index.components[0];
    const planned = planInsertComponent(
      {
        kind: 'insert',
        componentId: hero.id,
        anchor: { file: 'templates/index.json', line: 1, html: '{"sections"', position: 'after' },
      },
      index,
      source
    );

    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      expect(applyTextEdits(source.files[1].content, planned.plan.files[0].edits)).toContain(
        "{% section 'hero' %}"
      );
    }
  });

  it('reports invalid schema JSON as a partial catalog diagnostic', () => {
    const index = buildComponentIndex(
      snapshot([
        file('sections/broken.liquid', '{% schema %}{ invalid {% endschema %}<section />'),
      ]),
      { projectType: 'shopifytheme' }
    );
    expect(index.partial).toBe(true);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'shopify-invalid-schema' })])
    );
  });
});
