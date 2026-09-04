import { describe, expect, it } from 'vitest';
import {
  COMPONENT_WORKER_PROTOCOL_VERSION,
  handleComponentWorkerRequest,
} from './component-worker';
import { sha256 } from './ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from './types';

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

describe('component worker protocol', () => {
  it('returns the protocol version and indexes Astro through the bundled parser', async () => {
    const result = await handleComponentWorkerRequest({
      id: 1,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'build',
      projectType: 'astro',
      snapshot: snapshot([
        file(
          'src/components/Card.astro',
          '---\ninterface Props { label: string }\n---\n<article>{label}</article>'
        ),
        file(
          'src/pages/index.astro',
          '---\nimport Card from \'../components/Card.astro\';\n---\n<Card label="One" />'
        ),
      ]),
    });

    expect(result).toMatchObject({ id: 1, protocol: COMPONENT_WORKER_PROTOCOL_VERSION, ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toMatchObject({
      components: [expect.objectContaining({ id: 'astro:src/components/Card.astro#default' })],
    });
  });

  it('rejects unsupported protocol versions before touching the catalog', async () => {
    const result = await handleComponentWorkerRequest({
      id: 2,
      protocol: 999 as typeof COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      cancelId: 1,
    });

    expect(result).toEqual({
      id: 2,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: 'Unsupported component worker protocol 999.',
    });
  });

  it('honours cancellation tombstones before an async build starts', async () => {
    const cancel = await handleComponentWorkerRequest({
      id: 4,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      cancelId: 3,
    });
    const result = await handleComponentWorkerRequest({
      id: 3,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'build',
      projectType: 'astro',
      snapshot: snapshot([file('src/components/Card.astro', '---\n---\n<article />')]),
    });

    expect(cancel).toMatchObject({ id: 4, protocol: COMPONENT_WORKER_PROTOCOL_VERSION, ok: true });
    expect(result).toEqual({
      id: 3,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: 'The component worker request was cancelled.',
    });
  });

  it('serializes overlapping builds before a bind observes the active catalog', async () => {
    const first = handleComponentWorkerRequest({
      id: 10,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'build',
      projectType: 'vite',
      snapshot: snapshot([
        file('src/Button.tsx', 'export function Button() { return <button>One</button>; }'),
        file(
          'src/Page.tsx',
          "import { Button } from './Button'; export function Page() { return <Button />; }"
        ),
      ]),
    });
    const second = handleComponentWorkerRequest({
      id: 11,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'build',
      projectType: 'vite',
      snapshot: snapshot([
        file('src/Card.tsx', 'export function Card() { return <article>Two</article>; }'),
        file(
          'src/Page.tsx',
          "import { Card } from './Card'; export function Page() { return <Card />; }"
        ),
      ]),
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ id: 10, ok: true });
    expect(secondResult).toMatchObject({ id: 11, ok: true });

    const binding = await handleComponentWorkerRequest({
      id: 12,
      protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
      type: 'bind',
      input: { file: 'src/Page.tsx', line: 1, symbolHint: 'Card' },
    });
    expect(binding).toMatchObject({ id: 12, ok: true });
    if (!binding.ok || binding.result === null || !('componentId' in binding.result)) {
      throw new Error('Expected the worker bind request to return a component binding.');
    }
    expect(binding.result.componentId).toContain('Card.tsx');
  });
});
