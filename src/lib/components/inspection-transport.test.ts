import { describe, expect, it, vi } from 'vitest';
import {
  boundInspectionMessage,
  createInspectionTransport,
  INSPECTION_TREE_MAX_DEPTH,
  type InspectionWireNode,
} from './inspection-transport';
import type { EditableSurfaceTarget } from './editable-surface';

function makeTarget(contentWindow: Window): EditableSurfaceTarget {
  return {
    contentWindow,
    exactOrigin: 'http://127.0.0.1:4321',
    surfaceId: 'frame-surface',
    sessionId: 'session-1',
    capabilityToken: 'token-1',
    generation: 4,
    frameId: 'frame-1',
    componentId: 'react:Card',
    componentRevision: 'revision-1',
    capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
  };
}

function node(id: number, children: InspectionWireNode[] = []): InspectionWireNode {
  return { i: id, t: 'div', c: '', x: '', k: children };
}

describe('inspection surface transport', () => {
  it('rejects hostile source/origin and accepts the complete negotiated identity', () => {
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    const target = makeTarget(source);
    const transport = createInspectionTransport({
      iframeRef: { current: null },
      surfaceTarget: target,
    });
    const message = {
      protocolVersion: 2,
      sessionId: 'session-1',
      capabilityToken: 'token-1',
      generation: 4,
      frameId: 'frame-1',
      componentId: 'react:Card',
      type: 'ss:treeDirty',
    };
    expect(transport.accepts({ source, origin: target.exactOrigin, data: message })).toBe(true);
    expect(transport.accepts({ source: null, origin: target.exactOrigin, data: message })).toBe(
      false
    );
    expect(transport.accepts({ source, origin: 'https://evil.test', data: message })).toBe(false);
    expect(
      transport.accepts({
        source,
        origin: target.exactOrigin,
        data: { ...message, frameId: 'other' },
      })
    ).toBe(false);
    expect(transport.post({ type: 'ss:requestTree' })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ protocolVersion: 2 }),
      target.exactOrigin
    );
  });

  it('bounds tree depth and every untrusted field before exposing a message', () => {
    let deep: InspectionWireNode = node(1);
    for (let index = 0; index <= INSPECTION_TREE_MAX_DEPTH; index += 1) {
      deep = node(index + 2, [deep]);
    }
    const bounded = boundInspectionMessage({ type: 'ss:tree', tree: deep, truncated: false });
    expect(bounded?.type).toBe('ss:tree');
    if (bounded?.type !== 'ss:tree') return;
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded).length).toBeLessThan(100_000);
    expect(
      boundInspectionMessage({
        type: 'ss:select',
        nodeId: 1,
        affectedNodeIds: Array.from({ length: 5_000 }, (_, index) => index),
        rect: { top: 0, left: 0, width: 10, height: 10 },
      })
    ).toMatchObject({ type: 'ss:select', affectedNodeIds: expect.any(Array) });
    const selection = boundInspectionMessage({
      type: 'ss:select',
      nodeId: 1,
      affectedNodeIds: [],
      rect: { top: 0, left: 0, width: 10, height: 10 },
      signature: { tagName: 'div', className: 'x'.repeat(10_000), ancestorClasses: [] },
    });
    expect(selection).toMatchObject({
      type: 'ss:select',
      signature: { className: 'x'.repeat(4096) },
    });
  });

  it('uses an inactive null model instead of falling back to the legacy iframe', () => {
    const previewWindow = { postMessage: vi.fn() } as unknown as Window;
    const transport = createInspectionTransport({
      iframeRef: { current: { contentWindow: previewWindow } as HTMLIFrameElement },
      surfaceTarget: null,
    });
    expect(transport.active).toBe(false);
    expect(transport.surfaceId).toBe('none');
    expect(transport.post({ type: 'ss:requestTree' })).toBe(false);
    expect(previewWindow.postMessage).not.toHaveBeenCalled();
  });
});
