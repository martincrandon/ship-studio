import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementTree } from './useElementTree';
import type { EditableSurfaceTarget } from '../lib/components/editable-surface';
import type { ComponentIndex } from '../lib/components/types';

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

  it('keeps the projected tree identity stable across parent model rerenders', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const iframeRef = { current: iframe };
    const index = {
      revision: 'revision-1',
      partial: false,
      profile: { projectType: 'vite', workspaceRoot: '.' },
      components: [],
      instances: [],
      importEdges: [],
      diagnostics: [],
    } as unknown as ComponentIndex;
    const { result, rerender } = renderHook(() =>
      useElementTree({ iframeRef, enabled: true, componentIndex: index })
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:tree',
            tree: { i: 1, t: 'main', c: 'page', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });

    const firstProjection = result.current.componentTree;
    expect(firstProjection).toMatchObject({ kind: 'element', id: 1, tag: 'main' });
    rerender();
    expect(result.current.componentTree).toBe(firstProjection);
  });

  it('tracks same-source elements separately from the primary selection', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
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

  it('tracks hover messages from the preview separately from selection', () => {
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
          data: { type: 'ss:hover', nodeId: 12 },
        })
      );
    });
    expect(result.current.hoveredId).toBe(12);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: { type: 'ss:hover', nodeId: null },
        })
      );
    });
    expect(result.current.hoveredId).toBeNull();
  });

  it('starts empty for a negotiated target and clears all state when the target changes', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };
    const onSelectionChange = vi.fn();
    const target = (frameId: string): EditableSurfaceTarget => ({
      contentWindow: previewWindow,
      exactOrigin: 'http://127.0.0.1:4321',
      surfaceId: `surface-${frameId}`,
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      generation: 1,
      frameId,
      componentId: 'react:Card',
      componentRevision: 'revision-1',
      capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
    });
    const { result, rerender } = renderHook(
      ({ frameId }: { frameId: string | null }) =>
        useElementTree({
          iframeRef,
          enabled: true,
          surfaceTarget: frameId ? target(frameId) : null,
          onSelectionChange,
        }),
      { initialProps: { frameId: 'frame-a' } }
    );

    expect(result.current.tree).toBeNull();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: 'http://127.0.0.1:4321',
          data: {
            protocolVersion: 2,
            sessionId: 'session-1',
            capabilityToken: 'token-1',
            generation: 1,
            frameId: 'frame-a',
            componentId: 'react:Card',
            type: 'ss:tree',
            tree: { i: 1, t: 'article', c: 'card', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });
    expect(result.current.tree?.tag).toBe('article');
    expect(result.current.inspectionReady).toBe(true);

    rerender({ frameId: 'frame-b' });
    expect(result.current.tree).toBeNull();
    expect(result.current.inspectionReady).toBe(false);
    expect(result.current.selectedId).toBeNull();
    expect(result.current.hoveredId).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ss:treeOff', protocolVersion: 2, frameId: 'frame-a' }),
      'http://127.0.0.1:4321'
    );
  });

  it('uses only authenticated current-surface tree or selection activity as inspection readiness', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };
    const target = (frameId: string): EditableSurfaceTarget => ({
      contentWindow: previewWindow,
      exactOrigin: 'http://127.0.0.1:4321',
      surfaceId: `surface-${frameId}`,
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      generation: 1,
      frameId,
      componentId: 'react:Card',
      componentRevision: 'revision-1',
      capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
    });
    const { result, rerender } = renderHook(
      ({ frameId }: { frameId: string }) =>
        useElementTree({ iframeRef, enabled: true, surfaceTarget: target(frameId) }),
      { initialProps: { frameId: 'frame-a' } }
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: 'http://127.0.0.1:4321',
          data: {
            protocolVersion: 2,
            sessionId: 'session-1',
            capabilityToken: 'token-1',
            generation: 1,
            frameId: 'frame-b',
            componentId: 'react:Card',
            type: 'ss:tree',
            tree: { i: 1, t: 'article', c: 'card', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });
    expect(result.current.inspectionReady).toBe(false);
    expect(result.current.tree).toBeNull();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: 'http://127.0.0.1:4321',
          data: {
            protocolVersion: 2,
            sessionId: 'session-1',
            capabilityToken: 'token-1',
            generation: 1,
            frameId: 'frame-a',
            componentId: 'react:Card',
            type: 'ss:select',
            nodeId: 4,
            affectedNodeIds: [],
            signature: { tagName: 'h1', className: 'title', ancestorClasses: [] },
          },
        })
      );
    });
    expect(result.current.inspectionReady).toBe(true);

    rerender({ frameId: 'frame-b' });
    expect(result.current.inspectionReady).toBe(false);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: 'http://127.0.0.1:4321',
          data: {
            protocolVersion: 2,
            sessionId: 'session-1',
            capabilityToken: 'token-1',
            generation: 1,
            frameId: 'frame-b',
            componentId: 'react:Card',
            type: 'ss:tree',
            tree: { i: 2, t: 'article', c: 'card', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });
    expect(result.current.inspectionReady).toBe(true);
  });

  it('suppresses an identical renderer reselect acknowledgement but allows a new tree selection', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };
    const onSelectionChange = vi.fn();
    const target: EditableSurfaceTarget = {
      contentWindow: previewWindow,
      exactOrigin: 'http://127.0.0.1:4321',
      surfaceId: 'surface-a',
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      generation: 1,
      frameId: 'frame-a',
      componentId: 'react:Card',
      componentRevision: 'revision-1',
      capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
    };
    const { result } = renderHook(() =>
      useElementTree({
        iframeRef,
        enabled: true,
        surfaceTarget: target,
        onSelectionChange,
      })
    );
    onSelectionChange.mockClear();
    const selection = {
      protocolVersion: 2,
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      generation: 1,
      frameId: 'frame-a',
      componentId: 'react:Card',
      type: 'ss:select',
      nodeId: 4,
      affectedNodeIds: [],
      signature: {
        tagName: 'button',
        className: 'cta',
        ancestorClasses: ['card'],
        domPath: 'article:0>button:0',
      },
    };

    act(() => result.current.selectNode(selection.nodeId));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ss:selectNode', id: selection.nodeId }),
      target.exactOrigin
    );
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: target.exactOrigin,
          data: selection,
        })
      )
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(result.current.selectedId).toBe(4);

    // CSS mode's `ss:reselect` acknowledgement has the same identity and must
    // not re-enter the workspace-to-renderer selection handoff.
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: target.exactOrigin,
          data: selection,
        })
      )
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    act(() => result.current.selectNode(5));
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          origin: target.exactOrigin,
          data: {
            ...selection,
            nodeId: 5,
            signature: { ...selection.signature, domPath: 'article:0>span:1' },
          },
        })
      )
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed tree acknowledgement restore a superseded canvas selection', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };
    const onSelectionChange = vi.fn();
    const target: EditableSurfaceTarget = {
      contentWindow: previewWindow,
      exactOrigin: 'http://127.0.0.1:4321',
      surfaceId: 'surface-a',
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      generation: 1,
      frameId: 'frame-a',
      componentId: 'react:Card',
      componentRevision: 'revision-1',
      capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
    };
    const { result } = renderHook(() =>
      useElementTree({
        iframeRef,
        enabled: true,
        surfaceTarget: target,
        onSelectionChange,
      })
    );
    onSelectionChange.mockClear();

    const dispatchSelection = (nodeId: number, domPath: string, selectionRequestId?: string) => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: previewWindow,
            origin: target.exactOrigin,
            data: {
              protocolVersion: 2,
              sessionId: target.sessionId,
              capabilityToken: target.capabilityToken,
              generation: target.generation,
              frameId: target.frameId,
              componentId: target.componentId,
              type: 'ss:select',
              nodeId,
              affectedNodeIds: [],
              ...(selectionRequestId ? { selectionRequestId } : {}),
              signature: {
                tagName: 'button',
                className: nodeId === 5 ? 'secondary' : 'primary',
                ancestorClasses: ['card'],
                domPath,
              },
            },
          })
        );
      });
    };

    act(() => result.current.selectNode(4));
    const treeRequest =
      postMessage.mock.calls[postMessage.mock.calls.length - 1]?.[0] as Record<
        string,
        unknown
      >;
    const treeRequestId = treeRequest.selectionRequestId;
    expect(typeof treeRequestId).toBe('string');

    // A genuine canvas click supersedes the pending tree request.
    dispatchSelection(5, 'article:0>button:1');
    expect(result.current.selectedId).toBe(5);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    // The old tree ack is authenticated, but its request identity is cancelled;
    // it must not move the Elements panel or re-enter the workspace handoff.
    dispatchSelection(4, 'article:0>button:0', treeRequestId as string);
    expect(result.current.selectedId).toBe(5);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    // A new tree request still receives one genuine current ack, while a
    // duplicate acknowledgement is suppressed after that one callback.
    act(() => result.current.selectNode(6));
    const currentRequest =
      postMessage.mock.calls[postMessage.mock.calls.length - 1]?.[0] as Record<
        string,
        unknown
      >;
    dispatchSelection(6, 'article:0>button:2', currentRequest.selectionRequestId as string);
    expect(result.current.selectedId).toBe(6);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    dispatchSelection(6, 'article:0>button:2', currentRequest.selectionRequestId as string);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });
});
