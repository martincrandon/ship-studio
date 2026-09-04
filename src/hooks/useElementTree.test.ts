import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementTree } from './useElementTree';
import { buildComponentIndex } from '../lib/components';
import { sha256 } from '../lib/components/ranges';
import type { ComponentSourceSnapshot, SourceFileSnapshot } from '../lib/components/types';

function sourceFile(file: string, content: string): SourceFileSnapshot {
  return { file, content, contentHash: sha256(content) };
}

describe('useElementTree', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('retries the initial request with backoff until the preview returns a tree', async () => {
    vi.useFakeTimers();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:requestTree' }, '*');
    expect(postMessage).toHaveBeenCalledTimes(1);
    // Unanswered requests back off (retries at ~1s, ~3s, ~7s) rather than repeating
    // on a fixed 500ms interval for as long as the panel stays open.
    const tick = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 500) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
      }
    };
    await tick(1_000);
    expect(postMessage).toHaveBeenCalledTimes(2);
    await tick(1_000);
    expect(postMessage).toHaveBeenCalledTimes(2); // still backing off
    await tick(1_000);
    expect(postMessage).toHaveBeenCalledTimes(3);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:tree',
            tree: { i: 1, t: 'body', c: '', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });

    expect(result.current.tree).toEqual({
      id: 1,
      tag: 'body',
      cls: '',
      text: '',
      children: [],
    });
    // The snapshot arrived — retrying stops entirely.
    const settled = postMessage.mock.calls.length;
    await tick(10_000);
    expect(postMessage).toHaveBeenCalledTimes(settled);
  });

  it('tracks same-source elements separately from the primary selection', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: { type: 'ss:select', nodeId: 7, affectedNodeIds: [8, 9] },
        })
      );
    });

    expect(result.current.selectedId).toBe(7);
    expect(result.current.affectedIds).toEqual([8, 9]);
  });

  it('promotes a validated canvas boundary to component selection', () => {
    const files = [
      sourceFile('src/Card.tsx', 'export function Card() { return <div />; }'),
      sourceFile(
        'src/Page.tsx',
        `import { Card } from './Card';
export function Page() {
  return <main><Card /></main>;
}
`
      ),
    ];
    const snapshot: ComponentSourceSnapshot = {
      workspaceRoot: '.',
      revision: sha256(files.map((file) => `${file.file}:${file.contentHash}`).join('\n')),
      files,
      partial: false,
      diagnostics: [],
    };
    const index = buildComponentIndex(snapshot, { projectType: 'vite' });
    const card = index.components.find((component) => component.name === 'Card');
    const instance = index.instances.find((candidate) => candidate.componentId === card?.id);
    expect(card).toBeDefined();
    expect(instance).toBeDefined();

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };
    const { result } = renderHook(() =>
      useElementTree({
        iframeRef,
        enabled: true,
        componentIndex: index,
        projectPath: '/tmp/project',
      })
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:tree',
            tree: {
              i: 1,
              t: 'body',
              c: '',
              x: '',
              k: [
                {
                  i: 2,
                  t: 'main',
                  c: '',
                  x: '',
                  k: [],
                  o: [
                    {
                      renderer: 'react',
                      file: 'http://localhost:5173/src/Page.tsx',
                      line: instance!.invocation.line,
                      column: instance!.invocation.column,
                      symbolHint: 'Card',
                      runtimeKey: null,
                    },
                  ],
                },
              ],
            },
            truncated: false,
          },
        })
      );
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:select',
            nodeId: 2,
            rect: { top: 10, left: 20, width: 100, height: 40 },
          },
        })
      );
    });

    expect(result.current.selectionKind).toBe('component');
    expect(result.current.selectedComponent).toMatchObject({
      componentId: card!.id,
      instanceId: instance!.id,
      rect: { top: 10, left: 20, width: 100, height: 40 },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ss:selectComponent', hostNodeIds: [2] }),
      '*'
    );
  });

  it('projects unambiguous Next Server Component roots without owner hints', () => {
    const files = [
      sourceFile(
        'components/Header.tsx',
        `export default function Header() {
  return <header className="site-header" />;
}
`
      ),
      sourceFile(
        'app/layout.tsx',
        `import Header from '../components/Header';
export default function RootLayout() {
  return <Header />;
}
`
      ),
    ];
    const snapshot: ComponentSourceSnapshot = {
      workspaceRoot: '.',
      revision: sha256(files.map((file) => `${file.file}:${file.contentHash}`).join('\n')),
      files,
      partial: false,
      diagnostics: [],
    };
    const index = buildComponentIndex(snapshot, { projectType: 'nextjs' });
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };
    const { result } = renderHook(() =>
      useElementTree({
        iframeRef,
        enabled: true,
        componentIndex: index,
        projectPath: '/tmp/project',
      })
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:tree',
            tree: {
              i: 1,
              t: 'body',
              c: '',
              x: '',
              k: [{ i: 2, t: 'header', c: 'site-header', x: '', k: [] }],
            },
            truncated: false,
          },
        })
      );
    });

    expect(result.current.componentTree?.children).toMatchObject([
      {
        kind: 'component',
        name: 'Header',
        hostNodeIds: [2],
      },
    ]);
  });
});
