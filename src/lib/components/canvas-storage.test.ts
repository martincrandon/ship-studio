import { mockIPC } from '@tauri-apps/api/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPONENT_RENDERER_INTEGRATION_VERSION,
  flushComponentCanvasWrites,
  getComponentRendererConsent,
  grantComponentRendererConsent,
  installComponentRendererRegistry,
  readAdaptedComponentCanvasDocument,
  revokeComponentRendererConsent,
  writeComponentCanvasDocument,
} from './canvas-storage';
import { createEmptyCanvasDocument } from './canvas';

describe('component renderer consent persistence', () => {
  const invokeMock = vi.fn();

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    invokeMock.mockReset();
    mockIPC((command, args) => invokeMock(command, args));
  });

  it('reads and writes consent through project-scoped backend commands', async () => {
    const consent = {
      integrationVersion: COMPONENT_RENDERER_INTEGRATION_VERSION,
      approvedAt: 123,
    };
    invokeMock.mockResolvedValueOnce(consent).mockResolvedValueOnce(consent);

    await expect(getComponentRendererConsent('/project')).resolves.toEqual(consent);
    await expect(grantComponentRendererConsent('/project')).resolves.toEqual(consent);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_component_renderer_consent', {
      projectPath: '/project',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'grant_component_renderer_consent', {
      projectPath: '/project',
    });
  });

  it('revokes consent and never uses the old frontend boolean confirmation', async () => {
    await revokeComponentRendererConsent('/project');
    await installComponentRendererRegistry('/project', {
      consentVersion: COMPONENT_RENDERER_INTEGRATION_VERSION,
      sourceRevision: 'revision-1',
      componentRevisions: { 'react:Card': 'revision-1' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'revoke_component_renderer_consent', {
      projectPath: '/project',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'install_component_renderer_registry', {
      projectPath: '/project',
      request: {
        consentVersion: COMPONENT_RENDERER_INTEGRATION_VERSION,
        sourceRevision: 'revision-1',
        componentRevisions: { 'react:Card': 'revision-1' },
      },
    });
  });

  it('adapts scene extensions at the project-settings storage boundary', async () => {
    const source = {
      version: 2 as const,
      nodes: [],
      scopes: {
        focus: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        variants: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        all: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
      },
    };
    invokeMock.mockResolvedValueOnce(source);
    await expect(readAdaptedComponentCanvasDocument('/project')).resolves.toMatchObject({
      document: { version: 2, nodes: [] },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_component_canvas_document', {
      projectPath: '/project',
    });

    await writeComponentCanvasDocument('/project', {
      ...source,
      guides: [{ id: 'guide', orientation: 'vertical', position: 10, locked: true }],
    });
    const writtenArgs = invokeMock.mock.calls[1]?.[1] as unknown;
    expect(writtenArgs).toMatchObject({
      projectPath: '/project',
      document: {
        guides: [{ id: 'guide', orientation: 'vertical', position: 10, locked: true }],
      },
    });
  });

  it('treats a null backend canvas as fresh and allows the first edit to persist', async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);

    const read = await readAdaptedComponentCanvasDocument('/project-fresh');
    expect(read.unreadablePayload).toBeUndefined();
    expect(read.document).toEqual(createEmptyCanvasDocument());

    const edited = {
      ...read.document,
      nodes: [
        {
          id: 'first-node',
          scope: 'all' as const,
          componentId: 'react:Card',
          presetId: null,
          x: 24,
          y: 32,
          width: 320,
          height: 480,
          order: 0,
          collapsed: false,
          generated: true,
          presentation: { background: 'surface' as const, breakpoint: null, locale: null },
        },
      ],
    };
    await writeComponentCanvasDocument('/project-fresh', edited);

    expect(invokeMock).toHaveBeenLastCalledWith('set_component_canvas_document', {
      projectPath: '/project-fresh',
      document: edited,
    });
  });

  it('flushes a committed resize before the debounce window and keeps writes ordered', async () => {
    const firstWrite = deferred<void>();
    const calls: Array<{ projectPath: string; document: { nodes: Array<{ width: number }> } }> = [];
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command !== 'set_component_canvas_document') return Promise.resolve(undefined);
      calls.push(args as (typeof calls)[number]);
      return calls.length === 1 ? firstWrite.promise : Promise.resolve(undefined);
    });
    const initial = createEmptyCanvasDocument();
    const resized = {
      ...initial,
      nodes: [
        {
          id: 'resize-node',
          scope: 'all' as const,
          componentId: 'react:Card',
          presetId: null,
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          order: 0,
          collapsed: false,
          generated: true,
          presentation: { background: 'surface' as const, breakpoint: null, locale: null },
          sizeMode: 'fixed' as const,
        },
      ],
    };
    const later = { ...resized, nodes: [{ ...resized.nodes[0], width: 760 }] };

    const first = writeComponentCanvasDocument('/project-resize', resized);
    const second = writeComponentCanvasDocument('/project-resize', later);
    const flushed = flushComponentCanvasWrites('/project-resize');
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0].document.nodes[0].width).toBe(640);

    firstWrite.resolve();
    await expect(Promise.all([first, second, flushed])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].document.nodes[0].width).toBe(760);
  });

  it('does not let a previous project queue cross-write into the next project', async () => {
    const firstWrite = deferred<void>();
    const calls: Array<{ projectPath: string }> = [];
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command !== 'set_component_canvas_document') return Promise.resolve(undefined);
      calls.push(args as (typeof calls)[number]);
      return calls.length === 1 ? firstWrite.promise : Promise.resolve(undefined);
    });
    const document = createEmptyCanvasDocument();

    const oldProjectWrite = writeComponentCanvasDocument('/project-old', document);
    const newProjectWrite = writeComponentCanvasDocument('/project-new', document);
    await Promise.resolve();
    expect(calls.map((call) => call.projectPath)).toEqual(['/project-old', '/project-new']);
    firstWrite.resolve();
    await Promise.all([oldProjectWrite, newProjectWrite]);
  });

  it('preserves the committed undo/redo write sequence', async () => {
    const widths: number[] = [];
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command === 'set_component_canvas_document') {
        const payload = args as { document: { nodes: Array<{ width: number }> } };
        widths.push(payload.document.nodes[0]?.width ?? 0);
      }
      return Promise.resolve(undefined);
    });
    const initial = createEmptyCanvasDocument();
    const resize = {
      ...initial,
      nodes: [
        {
          id: 'resize-node',
          scope: 'all' as const,
          componentId: 'react:Card',
          presetId: null,
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          order: 0,
          collapsed: false,
          generated: true,
          presentation: { background: 'surface' as const, breakpoint: null, locale: null },
          sizeMode: 'fixed' as const,
        },
      ],
    };
    await writeComponentCanvasDocument('/project-history', resize);
    await writeComponentCanvasDocument('/project-history', initial);
    await writeComponentCanvasDocument('/project-history', resize);
    expect(widths).toEqual([640, 0, 640]);
  });
});
