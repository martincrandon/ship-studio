import { describe, expect, it } from 'vitest';
import { ComponentIndexStore } from './index-store';
import { sha256 } from './ranges';
import type { ComponentSourceSnapshot, SourceFileChange, SourceFileSnapshot } from './types';

function file(fileName: string, content: string): SourceFileSnapshot {
  return { file: fileName, content, contentHash: sha256(content) };
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

describe('ComponentIndexStore', () => {
  it('reuses unchanged parsed files during an incremental update', () => {
    const firstButton = file(
      'src/Button.tsx',
      'export function Button() { return <button>One</button>; }'
    );
    const page = file(
      'src/Page.tsx',
      "import { Button } from './Button'; export function Page() { return <Button />; }"
    );
    const store = new ComponentIndexStore();
    store.build(snapshot([firstButton, page]), { projectType: 'vite' });
    const parsedAfterBuild = store.totalParseCount;

    const secondButton = file(
      'src/Button.tsx',
      'export function Button() { return <button>Two</button>; }'
    );
    const nextSnapshot = snapshot([secondButton, page]);
    const changes: SourceFileChange[] = [
      {
        file: secondButton.file,
        content: secondButton.content,
        contentHash: secondButton.contentHash,
        kind: 'changed',
      },
    ];
    const index = store.update(nextSnapshot, changes, { projectType: 'vite' });

    expect(store.totalParseCount).toBe(parsedAfterBuild + 1);
    expect(index.revision).toBe(nextSnapshot.revision);
    expect(index.components.some((component) => component.name === 'Button')).toBe(true);
  });
});
