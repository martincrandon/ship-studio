import { describe, expect, it } from 'vitest';
import { sha256 } from './ranges';
import { packageSourceCandidates, resolvePackageModulePath } from './package-resolution';
import type { SourceFileSnapshot } from './types';

function file(fileName: string, content: string): SourceFileSnapshot {
  return { file: fileName, content, contentHash: sha256(content) };
}

describe('internal package resolution', () => {
  it('requests only a manifest-declared source entry, then resolves it when loaded', () => {
    const manifest = file(
      'packages/ui/package.json',
      JSON.stringify({ name: '@acme/ui', exports: { '.': { types: './src/index.ts' } } })
    );
    const page = file('apps/web/src/page.tsx', "import { Card } from '@acme/ui';\n<Card />");

    expect(packageSourceCandidates('@acme/ui', [manifest, page])).toEqual([
      'packages/ui/src/index.ts',
    ]);
    expect(resolvePackageModulePath('@acme/ui', [manifest, page])).toMatchObject({
      status: 'unresolved',
      file: null,
    });

    const entry = file('packages/ui/src/index.ts', 'export { default as Card } from "./Card";');
    expect(resolvePackageModulePath('@acme/ui', [manifest, page, entry])).toMatchObject({
      status: 'resolved',
      file: 'packages/ui/src/index.ts',
    });
  });

  it('does not interpret wildcard exports or ordinary external packages as internal', () => {
    const manifest = file(
      'packages/ui/package.json',
      JSON.stringify({ name: '@acme/ui', exports: { './*': './src/*.ts' } })
    );

    expect(packageSourceCandidates('@acme/ui/Button', [manifest])).toEqual([]);
    expect(resolvePackageModulePath('react', [manifest])).toEqual({
      status: 'external',
      file: null,
      diagnostics: [],
    });
  });
});
