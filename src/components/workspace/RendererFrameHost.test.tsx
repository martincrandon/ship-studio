import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { rendererFrameUrl } from './RendererFrameHost';
import { RendererFrameHost } from './RendererFrameHost';
import type {
  RendererFramePayload,
  RendererHostEvent,
  RendererSessionDescriptor,
} from '../../lib/components/renderer-session';
import { COMPONENT_RENDERER_PAINT_TIMEOUT_MS } from '../../lib/components/renderer-session';

const session: RendererSessionDescriptor = {
  protocolVersion: 2,
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  allowedOrigin: 'http://127.0.0.1:4312',
  baseUrl: 'http://127.0.0.1:4312/component-renderer',
  generation: 1,
  projectIdentity: '/project',
  supportedComponentIds: ['react:Card'],
  sourceRevisions: { 'react:Card': 'revision-1' },
  capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
};

const frame: RendererFramePayload = {
  protocolVersion: 2,
  projectIdentity: '/project',
  sessionId: 'session-1',
  frameId: 'frame-1',
  componentId: 'react:Card',
  componentRevision: 'revision-1',
  generation: 1,
  props: {},
  slots: {},
  presentation: {
    widthMode: 'fixed',
    width: 320,
    height: 480,
    background: 'surface',
    breakpoint: null,
    locale: null,
  },
};

describe('RendererFrameHost', () => {
  it('keeps frame URLs opaque and excludes serialized props', () => {
    const url = rendererFrameUrl(
      { baseUrl: 'http://127.0.0.1:4312/component-renderer/' },
      '__shipstudio_renderer_session',
      'frame 1'
    );
    expect(url).toBe(
      'http://127.0.0.1:4312/component-renderer/__shipstudio_renderer_session?frameId=frame%201'
    );
    expect(url).not.toContain('props');
  });

  it('sandboxes the project frame and rejects hostile-origin messages', () => {
    const onEvent = vi.fn();
    render(
      <RendererFrameHost
        session={session}
        frame={frame}
        routeSegment="shipstudio_renderer_session"
        onEvent={onEvent}
      />
    );

    const iframe = screen.getByTitle('Live react:Card component frame');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');

    window.dispatchEvent(
      new MessageEvent('message', {
        source: (iframe as HTMLIFrameElement).contentWindow,
        origin: 'http://evil.example',
        data: {
          type: 'ready',
          protocolVersion: 2,
          sessionId: session.sessionId,
          capabilityToken: session.capabilityToken,
          generation: session.generation,
          frameId: frame.frameId,
          componentId: frame.componentId,
          componentRevision: frame.componentRevision,
          eventId: 'event-1',
        },
      })
    );

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('can leave canvas input to the owning node for unselected frames', () => {
    render(
      <RendererFrameHost
        session={session}
        frame={frame}
        routeSegment="shipstudio_renderer_session"
        onEvent={vi.fn()}
        canvasInputEnabled={false}
      />
    );

    expect(screen.getByTitle('Live react:Card component frame')).toHaveClass(
      'component-renderer-frame--canvas-passive'
    );
  });

  it('accepts valid events once and rejects replayed frame messages', () => {
    const onEvent = vi.fn();
    render(
      <RendererFrameHost
        session={session}
        frame={frame}
        routeSegment="shipstudio_renderer_session"
        onEvent={onEvent}
      />
    );

    const iframe = screen.getByTitle('Live react:Card component frame');
    const ready = {
      type: 'ready',
      protocolVersion: 2,
      sessionId: session.sessionId,
      capabilityToken: session.capabilityToken,
      generation: session.generation,
      frameId: frame.frameId,
      componentId: frame.componentId,
      eventId: 'event-valid',
    };
    const dispatch = () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (iframe as HTMLIFrameElement).contentWindow,
          origin: session.allowedOrigin,
          data: ready,
        })
      );

    dispatch();
    dispatch();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'ready',
      eventId: 'event-valid',
      frameId: frame.frameId,
    });
  });

  it('does not promote a measurement reported in the previous camera space', () => {
    const onEvent = vi.fn();
    render(
      <RendererFrameHost
        session={session}
        frame={frame}
        routeSegment="shipstudio_renderer_session"
        onEvent={onEvent}
        zoom={2}
      />
    );

    const iframe = screen.getByTitle('Live react:Card component frame');
    const dispatchDimensions = (eventId: string, zoom: number) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (iframe as HTMLIFrameElement).contentWindow,
          origin: session.allowedOrigin,
          data: {
            type: 'rendered-dimensions',
            protocolVersion: 2,
            sessionId: session.sessionId,
            capabilityToken: session.capabilityToken,
            generation: session.generation,
            frameId: frame.frameId,
            componentId: frame.componentId,
            width: 320,
            height: 480,
            zoom,
            eventId,
          },
        })
      );

    dispatchDimensions('event-old-camera', 1);
    expect(onEvent).not.toHaveBeenCalled();

    dispatchDimensions('event-current-camera', 2);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'rendered-dimensions',
        eventId: 'event-current-camera',
        zoom: 2,
      })
    );
  });

  it('keeps a rendered frame ready across parent callback rerenders', async () => {
    vi.useFakeTimers();
    try {
      const firstOnEvent = vi.fn();
      const nextOnEvent = vi.fn();
      const { rerender } = render(
        <RendererFrameHost
          session={session}
          frame={frame}
          routeSegment="shipstudio_renderer_session"
          onEvent={firstOnEvent}
        />
      );
      const iframe = screen.getByTitle('Live react:Card component frame');
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (iframe as HTMLIFrameElement).contentWindow,
          origin: session.allowedOrigin,
          data: {
            type: 'ready',
            protocolVersion: 2,
            sessionId: session.sessionId,
            capabilityToken: session.capabilityToken,
            generation: session.generation,
            frameId: frame.frameId,
            componentId: frame.componentId,
            eventId: 'event-ready-before-rerender',
          },
        })
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (iframe as HTMLIFrameElement).contentWindow,
          origin: session.allowedOrigin,
          data: {
            type: 'rendered-dimensions',
            protocolVersion: 2,
            sessionId: session.sessionId,
            capabilityToken: session.capabilityToken,
            generation: session.generation,
            frameId: frame.frameId,
            componentId: frame.componentId,
            width: 320,
            height: 480,
            eventId: 'event-dimensions-before-rerender',
          },
        })
      );

      // Selection state changes recreate ComponentsWorkspace's callback. That
      // parent render must not make an already-ready frame look loading again.
      rerender(
        <RendererFrameHost
          session={session}
          frame={frame}
          routeSegment="shipstudio_renderer_session"
          onEvent={nextOnEvent}
        />
      );
      rerender(
        <RendererFrameHost
          session={session}
          frame={{
            ...frame,
            presentation: { ...frame.presentation, width: 640, height: 640 },
          }}
          routeSegment="shipstudio_renderer_session"
          onEvent={nextOnEvent}
        />
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (iframe as HTMLIFrameElement).contentWindow,
          origin: session.allowedOrigin,
          data: {
            type: 'heartbeat',
            protocolVersion: 2,
            sessionId: session.sessionId,
            capabilityToken: session.capabilityToken,
            generation: session.generation,
            frameId: frame.frameId,
            componentId: frame.componentId,
            eventId: 'event-heartbeat-after-rerender',
          },
        })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_001);
      });

      expect(nextOnEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat', eventId: 'event-heartbeat-after-rerender' })
      );
      expect(nextOnEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'render-error', code: 'renderer-timeout' })
      );
      expect(nextOnEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'render-error', code: 'renderer-paint-timeout' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a frame that handshakes but never reports rendered dimensions', async () => {
    vi.useFakeTimers();
    try {
      const onEvent = vi.fn<(event: RendererHostEvent) => void>();
      render(
        <RendererFrameHost
          session={session}
          frame={frame}
          routeSegment="shipstudio_renderer_session"
          onEvent={onEvent}
        />
      );
      const iframe = screen.getByTitle('Live react:Card component frame');
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (iframe as HTMLIFrameElement).contentWindow,
          origin: session.allowedOrigin,
          data: {
            type: 'ready',
            protocolVersion: 2,
            sessionId: session.sessionId,
            capabilityToken: session.capabilityToken,
            generation: session.generation,
            frameId: frame.frameId,
            componentId: frame.componentId,
            eventId: 'event-ready-without-dimensions',
          },
        })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPONENT_RENDERER_PAINT_TIMEOUT_MS);
      });

      const timeoutEvent = onEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'render-error' && event.code === 'renderer-paint-timeout');
      expect(timeoutEvent).toBeDefined();
      if (timeoutEvent?.type !== 'render-error') return;
      expect(timeoutEvent.eventId).toMatch(/^renderer-paint-timeout-/);
      expect(timeoutEvent.frameId).toBe(frame.frameId);
      expect(timeoutEvent.message).toBe(
        'The renderer did not report component dimensions in time.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reload an iframe when an equivalent frame payload is recreated', () => {
    const onEvent = vi.fn();
    const { rerender } = render(
      <RendererFrameHost
        session={session}
        frame={frame}
        routeSegment="shipstudio_renderer_session"
        onEvent={onEvent}
      />
    );

    const iframe = screen.getByTitle('Live react:Card component frame');
    const reload = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { location: { reload }, scrollX: 0, scrollY: 0 },
    });

    rerender(
      <RendererFrameHost
        session={session}
        frame={{ ...frame, presentation: { ...frame.presentation } }}
        routeSegment="shipstudio_renderer_session"
        onEvent={onEvent}
      />
    );

    expect(reload).not.toHaveBeenCalled();

    rerender(
      <RendererFrameHost
        session={session}
        frame={{
          ...frame,
          presentation: { ...frame.presentation, width: 640, height: 640 },
        }}
        routeSegment="shipstudio_renderer_session"
        onEvent={onEvent}
      />
    );

    expect(reload).not.toHaveBeenCalled();
  });
});
