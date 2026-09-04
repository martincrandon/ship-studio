import { describe, expect, it } from 'vitest';
import { applyTextEdits, sha256 } from './ranges';
import {
  bindComponentSelection,
  buildComponentIndex,
  planInsertComponent,
  planStaticPropEdit,
  REACT_COMPONENT_PLAN_PARSER_TOKEN,
} from './index';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from './types';
import { normalizeRuntimeSourcePath } from './adapters/react-helpers';

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

const buttonSource = `export interface ButtonProps {
  label: string;
  tone?: 'neutral' | 'accent';
  disabled?: boolean;
}

export function Button({ label, tone = 'neutral' }: ButtonProps) {
  return <button data-tone={tone}>{label}</button>;
}
`;

const badgeSource = `export interface BadgeProps {
  tone?: 'neutral' | 'accent';
}

export function Badge({ tone = 'neutral' }: BadgeProps) {
  return <span data-tone={tone}>Badge</span>;
}
`;

const pageSource = `import { Button } from './Button';

export function Page() {
  const copy = 'Launch';
  return (
    <main className="page">
      <Button label={copy} tone="accent" />
    </main>
  );
}
`;

function reactProject() {
  return snapshot([
    file('src/Button.tsx', buttonSource),
    file('src/Badge.tsx', badgeSource),
    file('src/Page.tsx', pageSource),
  ]);
}

describe('React component index', () => {
  it('returns a bounded needSources request for an unloaded internal package entry', () => {
    const source = snapshot([
      file(
        'packages/ui/package.json',
        JSON.stringify({ name: '@acme/ui', exports: { '.': { types: './src/index.ts' } } })
      ),
      file(
        'apps/web/src/page.tsx',
        `import { Card } from '@acme/ui';

export function Page() {
  return <Card />;
}
`
      ),
    ]);

    const index = buildComponentIndex(source, { projectType: 'vite' });

    expect(index.needSources).toEqual(['packages/ui/src/index.ts']);
    expect(
      index.importEdges.some((edge) =>
        edge.diagnostics.some((diagnostic) => diagnostic.code === 'package-source-not-loaded')
      )
    ).toBe(true);
  });

  it('normalizes Vite development stack URLs to indexed project paths', () => {
    expect(
      normalizeRuntimeSourcePath('http://localhost:5173/src/Card.tsx?t=123', '/projects/site', '.')
    ).toBe('src/Card.tsx');
    expect(
      normalizeRuntimeSourcePath(
        'file:///projects/site/apps/web/src/Card.tsx',
        '/projects/site',
        'apps/web'
      )
    ).toBe('apps/web/src/Card.tsx');
  });

  it('catalogs exported definitions, resolves usages, props, and exact source bindings', () => {
    const source = reactProject();
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const button = index.components.find((component) => component.name === 'Button');
    const usage = index.instances.find((instance) => instance.componentId === button?.id);

    expect(index.profile.primaryDialect).toBe('react');
    expect(button).toMatchObject({
      exportName: 'Button',
      usageCount: 1,
      capabilities: { catalog: true, place: true, editStaticProps: true },
    });
    expect(button?.props.map((prop) => [prop.name, prop.control])).toEqual([
      ['label', 'text'],
      ['tone', 'select'],
      ['disabled', 'boolean'],
    ]);
    expect(usage?.props.tone).toMatchObject({
      kind: 'static',
      value: { kind: 'string', value: 'accent' },
    });

    const binding = bindComponentSelection(
      {
        file: usage?.invocation.file,
        line: usage?.invocation.line,
        column: usage?.invocation.column,
        symbolHint: button?.name,
        sourceHash: usage?.invocation.contentHash,
      },
      index
    );
    expect(binding).toMatchObject({
      confidence: 'exact',
      componentId: button?.id,
      instanceId: usage?.id,
    });
  });

  it('records stable intrinsic roots for Next Server Component provenance', () => {
    const source = snapshot([
      file(
        'components/Header.tsx',
        `export default function Header() {
  return <header className="site-header" />;
}
`
      ),
      file(
        'app/layout.tsx',
        `import Header from '../components/Header';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <><Header />{children}</>;
}
`
      ),
    ]);
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const header = index.components.find((component) => component.name === 'Header');

    expect(header).toMatchObject({
      isClientModule: false,
      renderRoot: {
        tag: 'header',
        classTokens: ['site-header'],
        id: null,
      },
    });
  });

  it('keeps an unverified runtime source line source-anchored', () => {
    const source = reactProject();
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const button = index.components.find((component) => component.name === 'Button');
    const usage = index.instances.find((instance) => instance.componentId === button?.id);

    const binding = bindComponentSelection(
      { file: usage?.invocation.file, line: usage?.invocation.line, column: 1 },
      index
    );

    expect(binding).toMatchObject({
      confidence: 'sourceAnchored',
      componentId: button?.id,
    });
    expect(binding).not.toHaveProperty('instanceId');
  });

  it('does not treat external package components as unresolved project usages', () => {
    const source = snapshot([
      file(
        'app/page.tsx',
        `import Link from 'next/link';

export default function Page() {
  return <><Link href="/">Home</Link><Link href="/about">About</Link></>;
}
`
      ),
    ]);

    const index = buildComponentIndex(source, { projectType: 'nextjs' });

    expect(index.partial).toBe(false);
    expect(index.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'react-unresolved-usage' })])
    );
    expect(index.importEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ importedName: 'default', status: 'external' }),
      ])
    );
  });

  it('still reports genuinely unresolved project component imports', () => {
    const source = snapshot([
      file(
        'src/Page.tsx',
        `import { Missing } from './Missing';

export function Page() {
  return <Missing />;
}
`
      ),
    ]);

    const index = buildComponentIndex(source, { projectType: 'vite' });

    expect(index.partial).toBe(true);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'react-unresolved-usage' })])
    );
  });

  it('plans minimal static prop edits and refuses dynamic expressions', () => {
    const source = reactProject();
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const usage = index.instances.find(
      (instance) =>
        index.components.find((component) => component.id === instance.componentId)?.name ===
        'Button'
    );
    expect(usage).toBeDefined();

    const planned = planStaticPropEdit(
      {
        kind: 'prop',
        instanceId: usage!.id,
        propName: 'tone',
        value: { kind: 'string', value: 'neutral' },
      },
      index,
      source
    );
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      const result = applyTextEdits(pageSource, planned.plan.files[0].edits);
      expect(result).toContain('tone="neutral"');
      expect(result).toContain('label={copy}');
      expect(sha256(result ?? '')).toBe(planned.plan.files[0].expectedResultHash);
    }

    const refused = planStaticPropEdit(
      {
        kind: 'prop',
        instanceId: usage!.id,
        propName: 'label',
        value: { kind: 'string', value: 'Changed' },
      },
      index,
      source
    );
    expect(refused).toMatchObject({ status: 'refused', code: 'dynamic-expression' });

    const insertedBoolean = planStaticPropEdit(
      {
        kind: 'prop',
        instanceId: usage!.id,
        propName: 'disabled',
        value: { kind: 'boolean', value: false },
      },
      index,
      source
    );
    expect(insertedBoolean.status).toBe('planned');
    if (insertedBoolean.status === 'planned') {
      const result = applyTextEdits(pageSource, insertedBoolean.plan.files[0].edits);
      expect(result).toContain('disabled={false}');
    }
  });

  it('adds a missing import and places a no-required-prop component beside an exact JSX anchor', () => {
    const source = reactProject();
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const badge = index.components.find((component) => component.name === 'Badge');
    expect(badge).toBeDefined();

    const planned = planInsertComponent(
      {
        kind: 'insert',
        componentId: badge!.id,
        anchor: {
          file: 'src/Page.tsx',
          line: 7,
          html: '<Button label={copy} tone="accent" />',
          position: 'after',
        },
      },
      index,
      source
    );
    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      const result = applyTextEdits(pageSource, planned.plan.files[0].edits);
      expect(result).toContain("import { Badge } from './Badge';");
      expect(result).toContain('<Badge />');
      expect(result).toContain('<Button label={copy} tone="accent" />');
      expect(planned.plan).toMatchObject({
        dialect: 'react',
        parserToken: REACT_COMPONENT_PLAN_PARSER_TOKEN,
        expectedGraphDelta: {
          componentId: badge!.id,
          usagesBefore: 0,
          usagesAfter: 1,
          delta: 1,
        },
      });
    }

    const withExplicitProp = planInsertComponent(
      {
        kind: 'insert',
        componentId: badge!.id,
        anchor: {
          file: 'src/Page.tsx',
          line: 7,
          html: '<Button label={copy} tone="accent" />',
          position: 'after',
        },
        props: { tone: { kind: 'string', value: 'accent' } },
      },
      index,
      source
    );
    expect(withExplicitProp.status).toBe('planned');
    if (withExplicitProp.status === 'planned') {
      const result = applyTextEdits(pageSource, withExplicitProp.plan.files[0].edits);
      expect(result).toContain('<Badge tone="accent" />');
    }

    const recursive = planInsertComponent(
      {
        kind: 'insert',
        componentId: badge!.id,
        anchor: {
          file: 'src/Badge.tsx',
          line: 6,
          html: '<span data-tone={tone}>Badge</span>',
          position: 'inside',
        },
      },
      index,
      source
    );
    expect(recursive).toMatchObject({ status: 'refused', code: 'dependency-cycle' });
  });

  it('matches a JSX anchor when its class attribute is on a later line', () => {
    const multilinePageSource = `import { Button } from './Button';

export function Page() {
  return (
    <main className="page">
      <Button
        label="Launch"
        className="selected"
      />
    </main>
  );
}
`;
    const source = snapshot([
      file('src/Button.tsx', buttonSource),
      file('src/Badge.tsx', badgeSource),
      file('src/Page.tsx', multilinePageSource),
    ]);
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const badge = index.components.find((component) => component.name === 'Badge');
    expect(badge).toBeDefined();

    const planned = planInsertComponent(
      {
        kind: 'insert',
        componentId: badge!.id,
        anchor: {
          file: 'src/Page.tsx',
          line: 8,
          html: `<Button
        label="Launch"
        className="selected"
      />`,
          position: 'after',
        },
      },
      index,
      source
    );

    expect(planned.status).toBe('planned');
    if (planned.status === 'planned') {
      const result = applyTextEdits(multilinePageSource, planned.plan.files[0].edits);
      expect(result).toContain('<Badge />');
    }
  });

  it('does not reuse type-only default or named imports as runtime bindings', () => {
    const cardSource = `export default function Card() {
  return <article>Card</article>;
}
`;
    const defaultImportPage = `import type CardType from './Card';

export function Page() {
  return <main className="page">Target</main>;
}
`;
    const namedImportPage = `import { type Card as CardType } from './Card';

export function OtherPage() {
  return <main className="page">Target</main>;
}
`;
    const source = snapshot([
      file('src/Card.tsx', cardSource),
      file('src/DefaultImportPage.tsx', defaultImportPage),
      file('src/NamedImportPage.tsx', namedImportPage),
    ]);
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const card = index.components.find((component) => component.name === 'Card');
    expect(card).toBeDefined();

    const cases = [
      {
        file: 'src/DefaultImportPage.tsx',
        content: defaultImportPage,
        importText: `import Card from './Card';`,
      },
      {
        file: 'src/NamedImportPage.tsx',
        content: namedImportPage,
        importText: `import Card from './Card';`,
      },
    ];
    for (const testCase of cases) {
      const planned = planInsertComponent(
        {
          kind: 'insert',
          componentId: card!.id,
          anchor: {
            file: testCase.file,
            line: 4,
            html: '<main className="page">Target</main>',
            position: 'after',
          },
        },
        index,
        source
      );

      expect(planned.status).toBe('planned');
      if (planned.status === 'planned') {
        const result = applyTextEdits(testCase.content, planned.plan.files[0].edits);
        expect(result).toContain(testCase.importText);
        expect(result).toContain('<Card />');
        expect(result).not.toContain('<CardType />');
      }
    }
  });

  it('marks components with untyped destructured props as non-placeable', () => {
    const source = snapshot([
      file(
        'src/Untyped.tsx',
        `export function Untyped({ label }) {
  return <span>{label}</span>;
}
`
      ),
    ]);
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const untyped = index.components.find((component) => component.name === 'Untyped');

    expect(untyped?.capabilities).toMatchObject({ place: false, editStaticProps: false });
    expect(untyped?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'react-props-unresolved' })])
    );
  });

  it('returns an honest empty profile when React is not detected', () => {
    const source = snapshot([file('src/config.ts', 'export const port = 3000;\n')]);
    const index = buildComponentIndex(source, { projectType: 'vite' });
    expect(index.components).toEqual([]);
    expect(index.profile.primaryDialect).toBeNull();
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'react-no-jsx' })])
    );
  });

  it('uses authored prop names and disables unsafe placement when a prop contract is unresolved', () => {
    const source = snapshot([
      file(
        'src/Renamed.tsx',
        `interface RenamedProps { label: string }
export function Renamed({ label: text }: RenamedProps) {
  return <span>{text}</span>;
}

export async function LoadData() {
  return 'not a component';
}
`
      ),
      file(
        'src/Unsafe.tsx',
        `import type { ExternalProps } from './types';
export function Unsafe(props: ExternalProps) {
  return <div>{props.label}</div>;
}
`
      ),
      file('src/types.ts', 'export interface ExternalProps { label: string }\n'),
    ]);
    const index = buildComponentIndex(source, { projectType: 'vite' });
    const renamed = index.components.find((component) => component.name === 'Renamed');
    const unsafe = index.components.find((component) => component.name === 'Unsafe');

    expect(renamed?.props.map((prop) => prop.name)).toEqual(['label']);
    expect(index.components.some((component) => component.name === 'LoadData')).toBe(false);
    expect(unsafe?.capabilities.place).toBe(false);
    expect(unsafe?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'react-props-unresolved' })])
    );
  });
});
