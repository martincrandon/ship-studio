import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComponentCanvasStage } from './ComponentCanvasStage';
import type { RendererStageFrame } from '../../../lib/components/renderer-stage';
import type { RendererSessionDescriptor } from '../../../lib/components/renderer-session';

const session: RendererSessionDescriptor = {
  protocolVersion: 2,
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  allowedOrigin: 'http://127.0.0.1:4312',
  baseUrl: 'http://127.0.0.1:4312',
  generation: 1,
  projectIdentity: 'project-1',
  supportedComponentIds: ['react:Button'],
  sourceRevisions: { 'react:Button': 'revision-1' },
  capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: true },
};

const frame: RendererStageFrame = {
  protocolVersion: 2,
  projectIdentity: 'project-1',
  sessionId: 'session-1',
  frameId: 'node-1',
  componentId: 'react:Button',
  componentRevision: 'revision-1',
  generation: 1,
  props: { label: { kind: 'string', value: 'Ship' } },
  slots: {},
  presentation: {
    widthMode: 'fixed',
    width: 240,
    height: 240,
    background: 'surface',
    breakpoint: null,
    locale: null,
  },
  layout: { x: 0, y: 0, width: 240, height: 240 },
};

function message(type: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 3,
    contract: 'next-host-v2',
    sessionId: session.sessionId,
    capabilityToken: session.capabilityToken,
    generation: session.generation,
    stageId: 'stage-1',
    eventId: `${type}-1`,
    type,
    ...extra,
  };
}

describe('ComponentCanvasStage', () => {
  it('keeps the single iframe hidden until the authenticated stage and frame are ready', async () => {
    const onEvent = vi.fn();
    render(
      <ComponentCanvasStage
        session={session}
        stageId="stage-1"
        routeSegment="shipstudio_canvas_stage"
        frames={[frame]}
        camera={{ x: 0, y: 0, zoom: 1, owner: 'parent' }}
        selectedFrameId={frame.frameId}
        onEvent={onEvent}
      />
    );
    const iframe = screen.getByTitle('Interactive component canvas');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    expect(iframe).toHaveAttribute('data-stage-state', 'loading');
    expect(iframe).toHaveAttribute('data-stage-visible', 'false');
    expect(iframe).toHaveAttribute(
      'src',
      'http://127.0.0.1:4312/shipstudio_canvas_stage?stageId=stage-1'
    );

    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: window });
    act(() => {
      fireEvent.load(iframe);
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: session.allowedOrigin,
          data: message('stage-ready', { frameIds: ['node-1'] }),
        })
      );
    });
    expect(iframe).toHaveAttribute('data-stage-visible', 'false');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: session.allowedOrigin,
          data: message('frame-ready', {
            frameId: frame.frameId,
            componentId: frame.componentId,
            componentRevision: frame.componentRevision,
          }),
        })
      );
    });
    expect(iframe).toHaveAttribute('data-stage-visible', 'false');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: session.allowedOrigin,
          data: message('frame-rendered-dimensions', {
            frameId: frame.frameId,
            componentId: frame.componentId,
            componentRevision: frame.componentRevision,
            width: 240,
            height: 240,
          }),
        })
      );
    });
    await waitFor(() => expect(iframe).toHaveAttribute('data-stage-state', 'ready'));
    expect(iframe).toHaveAttribute('data-stage-visible', 'true');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'stage-ready' }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'frame-ready' }));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frame-rendered-dimensions' })
    );
  });

  it('rejects a hostile-origin event before it can reveal the stage', () => {
    const onEvent = vi.fn();
    render(
      <ComponentCanvasStage
        session={session}
        stageId="stage-1"
        routeSegment="shipstudio_canvas_stage"
        frames={[frame]}
        camera={{ x: 0, y: 0, zoom: 1, owner: 'parent' }}
        selectedFrameId={null}
        onEvent={onEvent}
      />
    );
    const iframe = screen.getByTitle('Interactive component canvas');
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: window });
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: 'https://evil.test',
        data: message('stage-ready', { frameIds: ['node-1'] }),
      })
    );
    expect(iframe).toHaveAttribute('data-stage-visible', 'false');
    expect(onEvent).not.toHaveBeenCalled();
  });
});
