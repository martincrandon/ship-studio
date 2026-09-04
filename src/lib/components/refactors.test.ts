import { describe, expect, it } from 'vitest';
import { buildComponentIndex } from './index';
import { applyTextEdits, sha256 } from './ranges';
import { planDeleteComponent, planDuplicateComponent, planRenameComponent } from './refactors';
import type { ComponentFileOperation, ComponentSourceSnapshot, SourceFileSnapshot } from './types';

function snapshot(contents: Record<string, string>): ComponentSourceSnapshot {
  const files: SourceFileSnapshot[] = Object.entries(contents).map(([file, content]) => ({
    file,
    content,
    contentHash: sha256(content),
  }));
  return {
    workspaceRoot: '.',
    revision: 'revision-1',
    files,
    partial: false,
    diagnostics: [],
  };
}

function plannedEdits(
  operations: ComponentFileOperation[] | undefined
): Extract<ComponentFileOperation, { kind: 'edit' }>[] {
  return (
    operations?.filter(
      (operation): operation is Extract<ComponentFileOperation, { kind: 'edit' }> =>
        operation.kind === 'edit'
    ) ?? []
  );
}

describe('React definition refactors', () => {
  it('plans a same-directory duplicate with a guarded create operation', () => {
    const source = snapshot({
      'components/Header.tsx':
        'export default function Header() {\n  return <header className="site-header">Northwind</header>;\n}\n',
    });
    const index = buildComponentIndex(source, { projectType: null });
    const component = index.components.find((candidate) => candidate.id.endsWith('#default'));
    expect(component).toBeDefined();

    const result = planDuplicateComponent(
      {
        componentId: component!.id,
        newName: 'NavWrap',
        destinationFile: 'components/NavWrap.tsx',
      },
      index,
      source
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.operations).toEqual([
      expect.objectContaining({
        kind: 'create',
        file: 'components/NavWrap.tsx',
        expectedAbsent: true,
      }),
    ]);
    const createOperation = result.plan.operations?.find(
      (operation) => operation.kind === 'create'
    );
    expect(createOperation?.kind).toBe('create');
    if (createOperation?.kind === 'create') {
      expect(createOperation.contents).toContain('function NavWrap()');
    }
    expect(result.plan.expectedGraphDelta).toEqual(
      expect.objectContaining({
        componentId: component!.id,
        usagesBefore: 0,
        usagesAfter: 0,
        delta: 0,
        createdComponentId: 'react:components/NavWrap.tsx#default',
        createdUsages: 0,
      })
    );
    expect(result.plan.preview.files[0]).toEqual(
      expect.objectContaining({ file: 'components/NavWrap.tsx', beforeHash: null })
    );
  });

  it('refuses destinations that would make copied relative imports unsafe', () => {
    const source = snapshot({
      'components/Header.tsx': 'export default function Header() { return <header />; }',
    });
    const index = buildComponentIndex(source, { projectType: null });
    const component = index.components.find((candidate) => candidate.id.endsWith('#default'))!;

    const result = planDuplicateComponent(
      {
        componentId: component.id,
        newName: 'NavWrap',
        destinationFile: 'features/NavWrap.tsx',
      },
      index,
      source
    );

    expect(result).toMatchObject({ status: 'refused', code: 'unsafe-dependency-closure' });
  });

  it('refuses shared definition files and collisions before creating a plan', () => {
    const source = snapshot({
      'components/Controls.tsx':
        'export function Header() { return <header />; }\nexport function Footer() { return <footer />; }',
    });
    const index = buildComponentIndex(source, { projectType: null });
    const component = index.components.find((candidate) => candidate.name === 'Header')!;

    expect(
      planDuplicateComponent(
        {
          componentId: component.id,
          newName: 'NavWrap',
          destinationFile: 'components/NavWrap.tsx',
        },
        index,
        source
      )
    ).toMatchObject({ status: 'refused', code: 'shared-file' });

    const collisionSource = snapshot({
      'components/Header.tsx': 'export default function Header() { return <header />; }',
      'components/NavWrap.tsx': 'export default function NavWrap() { return <nav />; }',
    });
    const collisionIndex = buildComponentIndex(collisionSource, { projectType: null });
    const collisionComponent = collisionIndex.components.find((candidate) =>
      candidate.id.endsWith('#default')
    )!;
    expect(
      planDuplicateComponent(
        {
          componentId: collisionComponent.id,
          newName: 'NavWrap',
          destinationFile: 'components/NavWrap.tsx',
        },
        collisionIndex,
        collisionSource
      )
    ).toMatchObject({ status: 'refused', code: 'path-collision' });
  });

  it('plans a graph-aware named export rename across imports and namespace usages', () => {
    const source = snapshot({
      'components/Button.tsx': `export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
`,
      'app/page.tsx': `import { Button } from '../components/Button';
import { Button as CTA } from '../components/Button';
import * as Controls from '../components/Button';

export function Page() {
  return <main><Button label="one" /><CTA label="two" /><Controls.Button label="three" /></main>;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const component = index.components.find((candidate) => candidate.name === 'Button')!;

    const result = planRenameComponent(
      { componentId: component.id, newName: 'ActionButton' },
      index,
      source
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const edits = plannedEdits(result.plan.operations);
    expect(edits.map((file) => file.file)).toEqual(['app/page.tsx', 'components/Button.tsx']);
    const page = edits.find((file) => file.file === 'app/page.tsx')!;
    const pageAfter = source.files[1].content;
    const updatedPage = applyTextEdits(pageAfter, page.edits)!;
    expect(updatedPage).toContain("import { ActionButton } from '../components/Button';");
    expect(updatedPage).toContain('<Controls.ActionButton label="three" />');
    expect(updatedPage).toContain('<CTA label="two" />');
    expect(result.plan.expectedGraphDelta).toEqual(
      expect.objectContaining({
        componentId: component.id,
        usagesBefore: 3,
        usagesAfter: 0,
        delta: -3,
        createdComponentId: 'react:components/Button.tsx#ActionButton',
        createdUsages: 3,
        removedComponentId: component.id,
      })
    );
  });

  it('refuses rename when the component is exposed through a re-export chain', () => {
    const source = snapshot({
      'components/Button.tsx': 'export function Button() { return <button>Button</button>; }\n',
      'components/index.ts': "export { Button } from './Button';\n",
      'app/page.tsx': `import { Button } from '../components';

export function Page() {
  return <Button />;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const component = index.components.find((candidate) => candidate.name === 'Button')!;

    expect(
      planRenameComponent({ componentId: component.id, newName: 'ActionButton' }, index, source)
    ).toMatchObject({ status: 'refused', code: 'unsafe-dependency-closure' });
  });

  it('refuses default exports until their file identity can move with the symbol', () => {
    const source = snapshot({
      'components/Button.tsx':
        'export default function Button() { return <button>Button</button>; }\n',
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const component = index.components.find((candidate) => candidate.name === 'Button')!;

    expect(
      planRenameComponent({ componentId: component.id, newName: 'ActionButton' }, index, source)
    ).toMatchObject({ status: 'refused', code: 'public-api' });
  });

  it('plans a reviewed delete across direct, aliased, and namespace JSX usages', () => {
    const source = snapshot({
      'components/Button.tsx': 'export function Button() { return <button>Button</button>; }\n',
      'app/page.tsx': `import { Button, Other } from '../components/Button';
import { Button as CTA } from '../components/Button';
import * as Controls from '../components/Button';

export function Page() {
  return <main><Button /><CTA /><Controls.Button /></main>;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const component = index.components.find((candidate) => candidate.name === 'Button')!;

    expect(component.usageCount).toBe(3);
    const result = planDeleteComponent(
      { componentId: component.id, removeAllUsages: true },
      index,
      source
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const edits = plannedEdits(result.plan.operations);
    const pageMutation = edits.find((file) => file.file === 'app/page.tsx')!;
    const pageAfter = applyTextEdits(
      source.files.find((file) => file.file === 'app/page.tsx')!.content,
      pageMutation.edits
    )!;
    expect(pageAfter).not.toContain('<Button');
    expect(pageAfter).not.toContain('<CTA');
    expect(pageAfter).not.toContain('Controls.Button');
    expect(pageAfter).toContain("import { Other } from '../components/Button';");
    expect(pageAfter).toContain("import * as Controls from '../components/Button';");

    const definitionMutation = edits.find((file) => file.file === 'components/Button.tsx')!;
    expect(
      applyTextEdits(
        source.files.find((file) => file.file === 'components/Button.tsx')!.content,
        definitionMutation.edits
      )
    ).toBe('\n');
    expect(result.plan.expectedGraphDelta).toEqual({
      componentId: component.id,
      usagesBefore: 3,
      usagesAfter: 0,
      delta: -3,
      removedComponentId: component.id,
    });
  });

  it('refuses delete without confirmation or when an import binding has a value reference', () => {
    const source = snapshot({
      'components/Button.tsx': 'export function Button() { return <button />; }\n',
      'app/page.tsx': `import { Button } from '../components/Button';
const buttonFactory = Button;
export function Page() {
  return <Button />;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const component = index.components.find((candidate) => candidate.name === 'Button')!;

    expect(planDeleteComponent({ componentId: component.id }, index, source)).toMatchObject({
      status: 'refused',
      code: 'usages-remain',
    });
    expect(
      planDeleteComponent({ componentId: component.id, removeAllUsages: true }, index, source)
    ).toMatchObject({ status: 'refused', code: 'unsafe-dependency-closure' });
  });

  it('refuses a delete that would leave an invalid expression', () => {
    const source = snapshot({
      'components/Button.tsx': 'export function Button() { return <button />; }\n',
      'app/page.tsx': `import { Button } from '../components/Button';
export function Page() {
  const child = <Button />;
  return <main />;
}
`,
    });
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const component = index.components.find((candidate) => candidate.name === 'Button')!;

    expect(
      planDeleteComponent({ componentId: component.id, removeAllUsages: true }, index, source)
    ).toMatchObject({ status: 'refused', code: 'syntax-error' });
  });
});
