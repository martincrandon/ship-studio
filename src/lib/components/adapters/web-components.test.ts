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

describe('Web Component adapter', () => {
  it('requires customElements.define and resolves custom-element tags from HTML', () => {
    const source = snapshot([
      file(
        'src/x-card.js',
        `class XCard extends HTMLElement {
  static observedAttributes = ['label'];
}
customElements.define('x-card', XCard);
`
      ),
      file('index.html', '<main><x-card label="Hello"></x-card></main>'),
    ]);

    const index = buildComponentIndex(source, { projectType: 'statichtml' });
    const card = index.components.find((component) => component.name === 'x-card');
    const instance = index.instances.find((candidate) => candidate.componentId === card?.id);

    expect(index.profile.dialects).toEqual(['web-component']);
    expect(card).toMatchObject({
      dialect: 'web-component',
      kind: 'custom-element',
      usageCount: 1,
      props: [expect.objectContaining({ name: 'label' })],
    });
    expect(
      bindComponentSelection(
        { file: instance?.invocation.file, line: instance?.invocation.line, symbolHint: 'x-card' },
        index
      )
    ).toMatchObject({ confidence: 'sourceAnchored', componentId: card?.id });
  });

  it('edits a static observed attribute but does not infer components from an unregistered tag', () => {
    const html = '<x-card label="Old"></x-card><x-unknown></x-unknown>';
    const source = snapshot([
      file(
        'src/x-card.js',
        "customElements.define('x-card', class extends HTMLElement { static observedAttributes = ['label']; });"
      ),
      file('index.html', html),
    ]);
    const index = buildComponentIndex(source, { projectType: 'statichtml' });
    const card = index.components[0];
    const instance = index.instances[0];
    const planned = planStaticPropEdit(
      {
        kind: 'prop',
        instanceId: instance.id,
        propName: 'label',
        value: { kind: 'string', value: 'New' },
      },
      index,
      source
    );

    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      expect(applyTextEdits(html, planned.plan.files[0].edits)).toContain('label="New"');
    }
    expect(index.instances).toHaveLength(1);
    expect(card.name).toBe('x-card');
  });
});
