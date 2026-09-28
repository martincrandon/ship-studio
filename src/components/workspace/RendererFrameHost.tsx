import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type {
  RendererFramePayload,
  RendererHostEvent,
  RendererSessionDescriptor,
} from '../../lib/components/renderer-session';
import { RendererEventGuard } from '../../lib/components/renderer-session';
import {
  COMPONENT_RENDERER_HEARTBEAT_TIMEOUT_MS,
  COMPONENT_RENDERER_PAINT_TIMEOUT_MS,
  COMPONENT_RENDERER_READY_TIMEOUT_MS,
} from '../../lib/components/renderer-session';
import {
  editableSurfaceFromIframe,
  type EditableSurfaceTarget,
} from '../../lib/components/editable-surface';

export interface RendererFrameHostProps {
  session: RendererSessionDescriptor;
  frame: RendererFramePayload;
  routeSegment: string;
  onEvent: (event: RendererHostEvent) => void;
  onTargetChange?: (target: EditableSurfaceTarget | null) => void;
  onFrameElementChange?: (frameId: string, frame: HTMLIFrameElement | null) => void;
  /** Root provenance is component-specific; frames without it stay read-only. */
  editingEnabled?: boolean;
  /** Unselected frames must leave canvas gestures (including wheel zoom) to the canvas. */
  canvasInputEnabled?: boolean;
  /** Explicit retries must start a fresh iframe handshake for the same payload. */
  retryNonce?: number;
  /** Paint scale is applied inside the renderer document, across the iframe boundary. */
  zoom?: number;
}

const MAX_PARKED_SCROLL_POSITIONS = 6;
const parkedScrollPositions = new Map<string, { left: number; top: number }>();

/** Builds a route URL that carries only opaque frame identity, never props. */
export function rendererFrameUrl(
  session: Pick<RendererSessionDescriptor, 'baseUrl'>,
  routeSegment: string,
  frameId: string
): string {
  const base = session.baseUrl.replace(/\/$/, '');
  return `${base}/${encodeURIComponent(routeSegment)}?frameId=${encodeURIComponent(frameId)}`;
}

/**
 * Identifies the renderer payload that requires a fresh runtime handshake.
 * Presentation measurements are intentionally excluded: resizing a frame
 * must not discard a completed handshake for the same rendered component.
 */
export function rendererFrameReloadKey(frame: RendererFramePayload): string {
  return JSON.stringify({
    protocolVersion: frame.protocolVersion,
    projectIdentity: frame.projectIdentity,
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    componentId: frame.componentId,
    componentRevision: frame.componentRevision,
    generation: frame.generation,
    props: frame.props,
    slots: frame.slots,
    presentation: {
      widthMode: frame.presentation.widthMode,
      background: frame.presentation.background,
      breakpoint: frame.presentation.breakpoint,
      locale: frame.presentation.locale,
    },
  });
}

/**
 * Hosts untrusted project rendering behind the negotiated v2 message boundary.
 * The sandbox grants scripts and same-origin inspection for the project runtime,
 * but no top navigation, popups, downloads, or Tauri privileges.
 */
export function RendererFrameHost({
  session,
  frame,
  routeSegment,
  onEvent,
  onTargetChange,
  onFrameElementChange,
  editingEnabled = false,
  canvasInputEnabled = true,
  retryNonce = 0,
  zoom = 1,
}: RendererFrameHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const eventGuardRef = useRef(new RendererEventGuard());
  // The canvas recreates the event callback whenever selection/inspection state
  // changes. Keep the message listener attached to the same iframe until its
  // actual frame/session identity changes; otherwise a harmless parent render
  // resets the local ready latch and can leave StyleTab showing "loading" until
  // the next heartbeat.
  const onEventRef = useRef(onEvent);
  const sessionRef = useRef(session);
  const frameRef = useRef(frame);
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
    sessionRef.current = session;
    frameRef.current = frame;
    zoomRef.current = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }, [frame, onEvent, session, zoom]);
  // Handshake and target lifecycles belong to the negotiated identity, not to
  // presentation telemetry. A measured width/height update recreates the
  // payload object, but it must not clear the ready latch or restart the
  // heartbeat timeout for the same frame/session.
  const sessionIdentity = JSON.stringify([
    session.protocolVersion,
    session.sessionId,
    session.capabilityToken,
    session.generation,
    session.allowedOrigin,
  ]);
  const frameIdentity = JSON.stringify([
    frame.protocolVersion,
    frame.sessionId,
    frame.generation,
    frame.frameId,
    frame.componentId,
    frame.componentRevision,
    retryNonce,
  ]);
  // The payload is rebuilt when the canvas rerenders (selection changes are a
  // common example), but an equivalent payload must not restart the project's
  // runtime. Comparing object identity here made every such rerender look like
  // a content change and caused all mounted cards to flash.
  const previousFrameKeyRef = useRef<string | null>(null);
  const url = useMemo(
    () => rendererFrameUrl(session, routeSegment, frame.frameId),
    [frame.frameId, routeSegment, session]
  );
  const frameKey = useMemo(
    () => JSON.stringify([rendererFrameReloadKey(frame), retryNonce]),
    [frame, retryNonce]
  );

  const postCameraZoom = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const currentSession = sessionRef.current;
    const currentFrame = frameRef.current;
    const currentZoom =
      Number.isFinite(zoomRef.current) && zoomRef.current > 0 ? zoomRef.current : 1;
    iframe.contentWindow?.postMessage(
      {
        protocolVersion: currentFrame.protocolVersion,
        sessionId: currentFrame.sessionId,
        capabilityToken: currentSession.capabilityToken,
        generation: currentFrame.generation,
        frameId: currentFrame.frameId,
        componentId: currentFrame.componentId,
        type: 'ss:set-camera',
        zoom: currentZoom,
      },
      currentSession.allowedOrigin
    );
  }, []);

  useEffect(() => {
    onFrameElementChange?.(frame.frameId, iframeRef.current);
    return () => onFrameElementChange?.(frame.frameId, null);
  }, [frame.frameId, onFrameElementChange]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const previousFrameKey = previousFrameKeyRef.current;
    previousFrameKeyRef.current = frameKey;
    if (previousFrameKey && previousFrameKey !== frameKey) {
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        // A cross-origin frame may refuse location access; assigning the same
        // opaque route still provides a bounded refresh fallback.
        iframe.src = url;
      }
    }
  }, [frameKey, url]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    postCameraZoom();
    iframe.addEventListener('load', postCameraZoom);
    return () => iframe.removeEventListener('load', postCameraZoom);
  }, [frameIdentity, postCameraZoom, sessionIdentity, zoom]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const eventGuard = eventGuardRef.current;
    if (!eventGuard) return;
    const boundFrameId = frameRef.current.frameId;
    let ready = false;
    let dimensionsReady = false;
    let paintTimedOut = false;
    let readyTimeout: number | null = window.setTimeout(() => {
      readyTimeout = null;
      if (ready) return;
      onEventRef.current({
        type: 'render-error',
        eventId: `renderer-timeout-${Date.now()}`,
        frameId: boundFrameId,
        code: 'renderer-timeout',
        message: 'The renderer did not complete its handshake in time.',
      });
    }, COMPONENT_RENDERER_READY_TIMEOUT_MS);
    let paintTimeout: number | null = null;
    let heartbeatTimeout: number | null = null;
    const clearReadyTimeout = () => {
      if (readyTimeout !== null) window.clearTimeout(readyTimeout);
      readyTimeout = null;
    };
    const clearPaintTimeout = () => {
      if (paintTimeout !== null) window.clearTimeout(paintTimeout);
      paintTimeout = null;
    };
    const clearHeartbeatTimeout = () => {
      if (heartbeatTimeout !== null) window.clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    };
    const armHeartbeatTimeout = () => {
      clearHeartbeatTimeout();
      heartbeatTimeout = window.setTimeout(() => {
        onEventRef.current({
          type: 'render-error',
          eventId: `renderer-heartbeat-${Date.now()}`,
          frameId: boundFrameId,
          code: 'renderer-heartbeat-lost',
          message: 'The renderer heartbeat stopped; the frame was isolated.',
        });
      }, COMPONENT_RENDERER_HEARTBEAT_TIMEOUT_MS);
    };
    const armPaintTimeout = () => {
      if (dimensionsReady || paintTimedOut || paintTimeout !== null) return;
      paintTimeout = window.setTimeout(() => {
        paintTimeout = null;
        paintTimedOut = true;
        clearHeartbeatTimeout();
        onEventRef.current({
          type: 'render-error',
          eventId: `renderer-paint-timeout-${Date.now()}`,
          frameId: boundFrameId,
          code: 'renderer-paint-timeout',
          message: 'The renderer did not report component dimensions in time.',
        });
      }, COMPONENT_RENDERER_PAINT_TIMEOUT_MS);
    };
    const restoreScrollPosition = () => {
      const position = parkedScrollPositions.get(boundFrameId);
      if (!position) return;
      try {
        iframe.contentWindow?.scrollTo(position.left, position.top);
      } catch {
        // Cross-origin runtimes may refuse inspection; the frame still renders.
      }
    };
    iframe.addEventListener('load', restoreScrollPosition);
    const handleMessage = (event: MessageEvent) => {
      const accepted = eventGuard.accept(event.data, {
        source: event.source,
        expectedSource: iframe.contentWindow,
        origin: event.origin,
        expectedOrigin: sessionRef.current.allowedOrigin,
        session: sessionRef.current,
        frame: frameRef.current,
      });
      if (!accepted) return;
      if (accepted.type === 'ready') {
        ready = true;
        clearReadyTimeout();
        armHeartbeatTimeout();
        armPaintTimeout();
        postCameraZoom();
      } else if (accepted.type === 'heartbeat') {
        ready = true;
        clearReadyTimeout();
        armHeartbeatTimeout();
        armPaintTimeout();
        postCameraZoom();
      } else if (accepted.type === 'rendered-dimensions') {
        const currentZoom =
          Number.isFinite(zoomRef.current) && zoomRef.current > 0 ? zoomRef.current : 1;
        if (
          typeof accepted.zoom === 'number' &&
          Math.abs(accepted.zoom - currentZoom) > Math.max(0.001, currentZoom * 0.001)
        ) {
          // The iframe may report its old viewport size during the same frame
          // in which the parent resized it. Re-send the current camera value
          // and wait for a measurement made in that coordinate space.
          postCameraZoom();
          return;
        }
        ready = true;
        dimensionsReady = true;
        clearReadyTimeout();
        clearPaintTimeout();
        armHeartbeatTimeout();
        postCameraZoom();
      } else if (accepted.type === 'render-error') {
        clearReadyTimeout();
        clearPaintTimeout();
        clearHeartbeatTimeout();
      }
      onEventRef.current(accepted);
    };
    window.addEventListener('message', handleMessage);
    return () => {
      try {
        const contentWindow = iframe.contentWindow;
        if (contentWindow) {
          parkedScrollPositions.delete(boundFrameId);
          parkedScrollPositions.set(boundFrameId, {
            left: contentWindow.scrollX,
            top: contentWindow.scrollY,
          });
          while (parkedScrollPositions.size > MAX_PARKED_SCROLL_POSITIONS) {
            const oldest = parkedScrollPositions.keys().next().value;
            if (oldest) parkedScrollPositions.delete(oldest);
          }
        }
      } catch {
        // Scroll state is an optimization and must never block frame cleanup.
      }
      iframe.removeEventListener('load', restoreScrollPosition);
      window.removeEventListener('message', handleMessage);
      clearReadyTimeout();
      clearPaintTimeout();
      clearHeartbeatTimeout();
    };
  }, [frameIdentity, postCameraZoom, sessionIdentity]);

  useEffect(() => {
    const currentSession = sessionRef.current;
    const currentFrame = frameRef.current;
    const target = editableSurfaceFromIframe(iframeRef.current, {
      exactOrigin: currentSession.allowedOrigin,
      surfaceId: `component-frame:${currentSession.sessionId}:${currentFrame.frameId}`,
      sessionId: currentSession.sessionId,
      capabilityToken: currentSession.capabilityToken,
      generation: currentSession.generation,
      frameId: currentFrame.frameId,
      componentId: currentFrame.componentId,
      componentRevision: currentFrame.componentRevision,
      capabilities: {
        ...currentSession.capabilities,
        editing: currentSession.capabilities.editing && editingEnabled,
      },
    });
    onTargetChange?.(target);
    return () => onTargetChange?.(null);
  }, [editingEnabled, frameIdentity, onTargetChange, sessionIdentity]);

  return (
    <iframe
      ref={iframeRef}
      className={`component-renderer-frame${canvasInputEnabled ? '' : ' component-renderer-frame--canvas-passive'}`}
      src={url}
      title={`Live ${frame.componentId} component frame`}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      loading="eager"
    />
  );
}
