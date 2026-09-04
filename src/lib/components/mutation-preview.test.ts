import { describe, expect, it } from 'vitest';
import { applyTextEdits, sha256, utf16OffsetToUtf8ByteOffset } from './ranges';
import { previewComponentMutation } from './mutation';
import type { ComponentMutationPlan, ComponentSourceSnapshot } from './types';

const source = `export function Page() {
  return <main>Welcome</main>;
}
`;

function snapshot(): ComponentSourceSnapshot {
  return {
    workspaceRoot: '.',
    revision: 'revision-1',
    files: [{ file: 'src/Page.tsx', content: source, contentHash: sha256(source) }],
    partial: false,
    diagnostics: [],
  };
}

function plan(): ComponentMutationPlan {
  const start = source.indexOf('<main>');
  const edit = {
    start: utf16OffsetToUtf8ByteOffset(source, start),
    end: utf16OffsetToUtf8ByteOffset(source, start),
    text: '<Card />',
  };
  const after = applyTextEdits(source, [edit])!;
  return {
    files: [
      {
        file: 'src/Page.tsx',
        expectedHash: sha256(source),
        expectedResultHash: sha256(after),
        edits: [edit],
      },
    ],
    expectedRevision: 'revision-1',
  };
}

describe('previewComponentMutation', () => {
  it('returns a compact exact diff without changing the snapshot', () => {
    const current = snapshot();
    const preview = previewComponentMutation(plan(), current);

    expect(preview?.files).toHaveLength(1);
    expect(preview?.files[0]).toMatchObject({
      file: 'src/Page.tsx',
      additions: 1,
      deletions: 1,
    });
    expect(preview?.files[0].diff).toContain('@@');
    expect(preview?.files[0].diff).toContain('+  return <Card /><main>Welcome</main>;');
    expect(current.files[0].content).toBe(source);
  });

  it('refuses a preview when the source hash is no longer current', () => {
    const current = snapshot();
    current.files[0].contentHash = 'stale';

    expect(previewComponentMutation(plan(), current)).toBeNull();
  });
});
