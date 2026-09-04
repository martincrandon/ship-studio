import { describe, expect, it } from 'vitest';
import { buildComponentIndex } from '../index';
import { collectNextServerComponentBoundaries } from './next-server-provenance';
import { sha256 } from '../ranges';
import type { ComponentSourceSnapshot, RawComponentTreeNode, SourceFileSnapshot } from '../types';

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

function projectSource() {
  return snapshot([
    file(
      'components/Header.tsx',
      `export default function Header() {
  return <header className="site-header"><nav className="site-nav" /></header>;
}
`
    ),
    file(
      'components/Footer.tsx',
      `export default function Footer() {
  return <footer className="site-footer"><div className="footer-inner" /></footer>;
}
`
    ),
    file(
      'app/layout.tsx',
      `import Header from '../components/Header';
import Footer from '../components/Footer';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <><Header />{children}<Footer /></>;
}
`
    ),
  ]);
}

const tree: RawComponentTreeNode = {
  id: 1,
  tag: 'body',
  cls: '',
  text: '',
  children: [
    {
      id: 2,
      tag: 'header',
      cls: 'site-header',
      text: '',
      children: [{ id: 3, tag: 'nav', cls: 'site-nav', text: '', children: [] }],
    },
    { id: 4, tag: 'main', cls: '', text: '', children: [] },
    {
      id: 5,
      tag: 'footer',
      cls: 'site-footer',
      text: '',
      children: [{ id: 6, tag: 'div', cls: 'footer-inner', text: '', children: [] }],
    },
  ],
};

describe('Next Server Component provenance', () => {
  it('binds unique static server roots to their single indexed invocation', () => {
    const index = buildComponentIndex(projectSource(), { projectType: 'nextjs' });
    const boundaries = collectNextServerComponentBoundaries(tree, index);

    expect(boundaries).toHaveLength(2);
    expect(boundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentId: 'react:components/Header.tsx#default',
          hostNodeIds: [2],
          confidence: 'exact',
        }),
        expect.objectContaining({
          componentId: 'react:components/Footer.tsx#default',
          hostNodeIds: [5],
          confidence: 'exact',
        }),
      ])
    );
  });

  it('refuses repeated or colliding root signatures instead of guessing', () => {
    const source = snapshot([
      ...projectSource().files,
      file(
        'components/AnotherHeader.tsx',
        `export default function AnotherHeader() {
  return <header className="site-header" />;
}
`
      ),
      file(
        'app/page.tsx',
        `import AnotherHeader from '../components/AnotherHeader';
export default function Page() {
  return <AnotherHeader />;
}
`
      ),
    ]);
    const index = buildComponentIndex(source, { projectType: 'nextjs' });
    const colliding = collectNextServerComponentBoundaries(tree, index);

    expect(colliding).toHaveLength(1);
    expect(colliding[0].componentId).toBe('react:components/Footer.tsx#default');
  });

  it('does not use the server-root fallback for client modules', () => {
    const source = snapshot([
      file(
        'components/Header.tsx',
        `'use client';
export default function Header() {
  return <header className="site-header" />;
}
`
      ),
      file(
        'app/layout.tsx',
        `import Header from '../components/Header';
export default function RootLayout() {
  return <Header />;
}
`
      ),
    ]);
    const index = buildComponentIndex(source, { projectType: 'nextjs' });

    expect(collectNextServerComponentBoundaries(tree, index)).toEqual([]);
  });
});
