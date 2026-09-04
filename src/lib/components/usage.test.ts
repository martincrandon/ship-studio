import { describe, expect, it } from 'vitest';
import { buildComponentIndex } from './index';
import { usageReportForResolution } from './usage';
import { sha256 } from './ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from './types';

function file(path: string, content: string): SourceFileSnapshot {
  return { file: path, content, contentHash: sha256(content) };
}

function fixture() {
  const card = file(
    'src/Card.tsx',
    `export function Card() {
  return <section className="card">Card</section>;
}
`
  );
  const page = file(
    'src/Page.tsx',
    `import { Card } from './Card';

export function Page() {
  return <main><Card /></main>;
}
`
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
  return { index, component };
}

describe('usageReportForResolution', () => {
  it('maps an indexed definition to the legacy UsageScope shape', () => {
    const { index, component } = fixture();
    const report = usageReportForResolution(index, {
      status: 'resolved',
      file: component.definition.file,
      line: component.definition.line + 1,
      column: 20,
      class_name: 'card',
      confidence: 'unique',
      source_start: component.definition.start + 1,
      source_end: component.definition.start + 6,
      source_hash: component.definition.contentHash,
    });

    expect(report).toEqual({
      component: 'Card',
      selfKind: 'component',
      sites: [expect.objectContaining({ file: 'src/Page.tsx', kind: 'page' })],
    });
  });

  it('refuses an indexed report when the resolver hash is stale', () => {
    const { index, component } = fixture();
    expect(
      usageReportForResolution(index, {
        status: 'resolved',
        file: component.definition.file,
        line: component.definition.line,
        column: component.definition.column,
        class_name: 'card',
        confidence: 'unique',
        source_start: component.definition.start + 1,
        source_end: component.definition.start + 6,
        source_hash: 'old-hash',
      })
    ).toBeNull();
  });
});
