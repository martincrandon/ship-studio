import { describe, expect, it } from 'vitest';
import { buildComponentIndex, planExtractComponent } from './index';
import { applyTextEdits, sha256, sourceRefFromUtf16Range } from './ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from './types';

function snapshot(contents: Record<string, string>): ComponentSourceSnapshot {
  const files: SourceFileSnapshot[] = Object.entries(contents).map(([file, content]) => ({
    file,
    content,
    contentHash: sha256(content),
  }));
  return {
    workspaceRoot: '.',
    revision: 'revision-extraction',
    files,
    partial: false,
    diagnostics: [],
  };
}

function selectedSource(source: ComponentSourceSnapshot, file: string, text: string) {
  const target = source.files.find((candidate) => candidate.file === file)!;
  const start = target.content.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  return sourceRefFromUtf16Range(
    target.file,
    target.content,
    target.contentHash,
    start,
    start + text.length
  );
}

describe('React component extraction', () => {
  it('returns a free-variable proposal before requiring prop approval', () => {
    const source = snapshot({
      'components/Badge.tsx': 'export function Badge() { return <span>Badge</span>; }\n',
      'components/Page.tsx': `import { Badge } from './Badge';
export function Page({ title }: { title: string }) {
  return <main><div className="card">{title}<Badge /></div></main>;
}
`,
    });
    const selection = '<div className="card">{title}<Badge /></div>';
    const index = buildComponentIndex(source, { projectType: 'nextjs' });

    const result = planExtractComponent(
      {
        source: selectedSource(source, 'components/Page.tsx', selection),
        componentName: 'CardContent',
        destinationFile: 'components/CardContent.tsx',
      },
      index,
      source
    );

    expect(result).toMatchObject({
      status: 'needs-approval',
      proposal: {
        componentName: 'CardContent',
        destinationFile: 'components/CardContent.tsx',
        proposedPropNames: ['title'],
        preservedImports: ['./Badge'],
      },
    });
  });

  it('plans a lossless create plus replacement import and invocation after approval', () => {
    const source = snapshot({
      'components/Badge.tsx': 'export function Badge() { return <span>Badge</span>; }\n',
      'components/Page.tsx': `import { Badge } from './Badge';
export function Page({ title }: { title: string }) {
  return <main><div className="card">{title}<Badge /></div></main>;
}
`,
    });
    const selection = '<div className="card">{title}<Badge /></div>';
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const result = planExtractComponent(
      {
        source: selectedSource(source, 'components/Page.tsx', selection),
        componentName: 'CardContent',
        destinationFile: 'components/CardContent.tsx',
        approvedPropNames: ['title'],
      },
      index,
      source
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.operations).toHaveLength(2);
    const created = result.plan.operations?.find((operation) => operation.kind === 'create');
    const edited = result.plan.operations?.find((operation) => operation.kind === 'edit');
    expect(created).toMatchObject({
      kind: 'create',
      file: 'components/CardContent.tsx',
      expectedAbsent: true,
    });
    if (created?.kind === 'create') {
      expect(created.contents).toContain("import { Badge } from './Badge';");
      expect(created.contents).toContain('{title}');
      expect(created.contents).toContain('CardContentProps');
    }
    expect(edited).toMatchObject({ kind: 'edit', file: 'components/Page.tsx' });
    if (edited?.kind === 'edit') {
      expect(edited.edits.some((edit) => edit.text.includes("from './CardContent'"))).toBe(true);
      expect(edited.edits.some((edit) => edit.text === '<CardContent title={title} />')).toBe(true);
    }
    expect(result.plan.expectedGraphDelta?.componentId).toContain('react:components/Page.tsx#Page');
    expect(result.plan.expectedGraphDelta?.createdComponentId).toBe(
      'react:components/CardContent.tsx#CardContent'
    );
    expect(result.plan.expectedGraphDelta?.createdUsages).toBe(1);
  });

  it('refuses stale, control-flow, incomplete-approval, and destination-collision selections', () => {
    const source = snapshot({
      'components/Page.tsx': `export function Page({ title, visible, items }: { title: string; visible: boolean; items: string[] }) {
  return <main>{visible && <div className="card">{title}</div>}{items.map((item) => <span key={item}>{item}</span>)}<footer>Footer</footer></main>;
}
`,
      'components/Existing.tsx': 'export function Existing() { return <div />; }\n',
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const conditional = '<div className="card">{title}</div>';
    expect(
      planExtractComponent(
        {
          source: selectedSource(source, 'components/Page.tsx', conditional),
          componentName: 'CardContent',
          destinationFile: 'components/CardContent.tsx',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-scope' });

    const safe = '<footer>Footer</footer>';
    const safeSource = selectedSource(source, 'components/Page.tsx', safe);
    expect(
      planExtractComponent(
        {
          source: safeSource,
          componentName: 'Existing',
          destinationFile: 'components/Existing.tsx',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'path-collision' });

    const clean = '<span key={item}>{item}</span>';
    expect(
      planExtractComponent(
        {
          source: selectedSource(source, 'components/Page.tsx', clean),
          componentName: 'ItemRow',
          destinationFile: 'components/ItemRow.tsx',
          approvedPropNames: [],
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'dynamic-scope' });

    const stale = selectedSource(source, 'components/Page.tsx', conditional);
    expect(
      planExtractComponent(
        {
          source: { ...stale, contentHash: 'stale' },
          componentName: 'CardContent',
          destinationFile: 'components/CardContent.tsx',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'stale-source' });
  });

  it('plans the conservative inline-simple transform for a local static component', () => {
    const page = `export const Tiny = () => <span className="tiny">Hello</span>;
export function Screen() { return <main><Tiny /></main>; }
`;
    const source = snapshot({ 'components/Screen.tsx': page });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const tiny = index.components.find((component) => component.name === 'Tiny')!;
    const instance = index.instances.find((candidate) => candidate.componentId === tiny.id)!;

    const result = planExtractComponent({ kind: 'inline', instanceId: instance.id }, index, source);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const edit = result.plan.files[0];
    expect(applyTextEdits(page, edit.edits)).toContain('<span className="tiny">Hello</span>');
    expect(result.plan.expectedGraphDelta).toMatchObject({
      componentId: tiny.id,
      usagesBefore: 1,
      usagesAfter: 0,
      delta: -1,
    });
  });
});
