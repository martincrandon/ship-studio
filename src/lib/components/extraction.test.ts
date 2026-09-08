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

  it('classifies direct selected values and supports reviewed rename decisions', () => {
    const source = snapshot({
      'components/Page.tsx': `export function Page({ title, url, image, hidden }: { title: string; url: string; image: string; hidden: boolean }) {
  return <main><a href={url}><img src={image} alt={title} hidden={hidden} /></a></main>;
}
`,
    });
    const selection = '<a href={url}><img src={image} alt={title} hidden={hidden} /></a>';
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const proposal = planExtractComponent(
      {
        source: selectedSource(source, 'components/Page.tsx', selection),
        componentName: 'CardLink',
        destinationFile: 'components/CardLink.tsx',
      },
      index,
      source
    );
    expect(proposal).toMatchObject({
      status: 'needs-approval',
      proposal: {
        requiredProps: [
          { sourceName: 'hidden', kind: 'visibility' },
          { sourceName: 'image', kind: 'image' },
          { sourceName: 'title', kind: 'attribute' },
          { sourceName: 'url', kind: 'link' },
        ],
      },
    });

    const approved = planExtractComponent(
      {
        source: selectedSource(source, 'components/Page.tsx', selection),
        componentName: 'CardLink',
        destinationFile: 'components/CardLink.tsx',
        approvedProps: [
          { sourceName: 'hidden', propName: 'isHidden' },
          { sourceName: 'image', propName: 'image' },
          { sourceName: 'title', propName: 'altText' },
          { sourceName: 'url', propName: 'href' },
        ],
      },
      index,
      source
    );
    expect(approved.status).toBe('planned');
    if (approved.status === 'planned') {
      const created = approved.plan.operations?.find((operation) => operation.kind === 'create');
      expect(created?.kind).toBe('create');
      if (created?.kind === 'create') {
        expect(created.contents).toContain('isHidden: boolean');
        expect(created.contents).toContain(
          '{ isHidden: hidden, image, altText: title, href: url }'
        );
      }
    }
    expect(
      planExtractComponent(
        {
          source: selectedSource(source, 'components/Page.tsx', selection),
          componentName: 'CardLink',
          destinationFile: 'components/CardLink.tsx',
          approvedProps: [],
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'missing-prop-approval' });
  });

  it('offers optional static literal suggestions and preserves rejected literals', () => {
    const source = snapshot({
      'components/Page.tsx': `export function Page() {
  return <main><a href="/docs"><img src="/hero.png" alt="Hero" hidden /><p>Hello</p></a></main>;
}
`,
    });
    const selection = '<a href="/docs"><img src="/hero.png" alt="Hero" hidden /><p>Hello</p></a>';
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const selected = selectedSource(source, 'components/Page.tsx', selection);
    const proposal = planExtractComponent(
      {
        source: selected,
        componentName: 'HeroLink',
        destinationFile: 'components/HeroLink.tsx',
      },
      index,
      source
    );
    expect(proposal).toMatchObject({
      status: 'needs-approval',
      proposal: {
        proposedPropNames: [],
        suggestedProps: [
          { kind: 'link', displayName: 'href', required: false },
          { kind: 'image', displayName: 'src', required: false },
          { kind: 'attribute', displayName: 'alt', required: false },
          { kind: 'visibility', displayName: 'hidden', required: false },
          { kind: 'text', displayName: 'Text', required: false },
        ],
      },
    });
    if (proposal.status !== 'needs-approval') return;
    const href = proposal.proposal.suggestedProps?.find(
      (suggestion) => suggestion.displayName === 'href'
    );
    expect(href).toBeDefined();
    const accepted = planExtractComponent(
      {
        source: selected,
        componentName: 'HeroLink',
        destinationFile: 'components/HeroLink.tsx',
        approvedProps: href ? [{ sourceName: href.sourceName, propName: 'url' }] : [],
      },
      index,
      source
    );
    expect(accepted.status).toBe('planned');
    if (accepted.status === 'planned') {
      const created = accepted.plan.operations?.find((operation) => operation.kind === 'create');
      const edited = accepted.plan.operations?.find((operation) => operation.kind === 'edit');
      expect(created?.kind).toBe('create');
      expect(edited?.kind).toBe('edit');
      if (created?.kind === 'create') {
        expect(created.contents).toContain('<a href={url}>');
        expect(created.contents).toContain('<img src="/hero.png" alt="Hero" hidden />');
        expect(created.contents).toContain('<p>Hello</p>');
      }
      if (edited?.kind === 'edit') {
        expect(edited.edits.some((edit) => edit.text === '<HeroLink url="/docs" />')).toBe(true);
      }
    }
    const rejected = planExtractComponent(
      {
        source: selected,
        componentName: 'HeroLink',
        destinationFile: 'components/HeroLink.tsx',
        approvedProps: [],
      },
      index,
      source
    );
    expect(rejected.status).toBe('planned');
    if (rejected.status === 'planned') {
      const created = rejected.plan.operations?.find((operation) => operation.kind === 'create');
      if (created?.kind === 'create') expect(created.contents).toContain('href="/docs"');
    }
  });

  it('infers numeric and non-visibility boolean literal types and refuses null literals', () => {
    const source = snapshot({
      'components/Page.tsx': `export function Page() {
  return <main><div data-count={3} data-enabled={true} data-null={null}>Copy</div></main>;
}
`,
    });
    const selection = '<div data-count={3} data-enabled={true} data-null={null}>Copy</div>';
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const result = planExtractComponent(
      {
        source: selectedSource(source, 'components/Page.tsx', selection),
        componentName: 'LiteralValues',
        destinationFile: 'components/LiteralValues.tsx',
      },
      index,
      source
    );
    expect(result).toMatchObject({
      status: 'needs-approval',
      proposal: {
        suggestedProps: [
          { displayName: 'data-count', typeText: 'number' },
          { displayName: 'data-enabled', typeText: 'boolean' },
          { displayName: 'Text', typeText: 'string' },
        ],
      },
    });
    if (result.status === 'needs-approval') {
      expect(
        result.proposal.suggestedProps?.some((suggestion) =>
          suggestion.sourceText?.includes('null')
        )
      ).toBe(false);
    }
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
