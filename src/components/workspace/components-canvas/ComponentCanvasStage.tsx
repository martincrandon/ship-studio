import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  RendererStageEvent,
  RendererStageFrame,
  RendererStageCamera,
  RendererStageMessageContext,
} from '../../../lib/components/renderer-stage';
import {
  COMPONENT_RENDERER_STAGE_CONTRACT,
  COMPONENT_RENDERER_STAGE_HEARTBEAT_TIMEOUT_MS,
  COMPONENT_RENDERER_STAGE_READY_TIMEOUT_MS,
  createRendererStageSyncCommand,
  rendererStageMessageWithinBounds,
  rendererStageUrl,
  RendererStageEventGuard,
} from '../../../lib/components/renderer-stage';
import type { RendererSessionDescriptor } from '../../../lib/components/renderer-session';

export type ComponentCanvasStageState = 'loading' | 'ready' | 'error';

export interface ComponentCanvasStageProps {
  session: RendererSessionDescriptor;
  /** Stable per-canvas identity. It is part of every authenticated message. */
  stageId: string;
  routeSegment: string;
  frames: readonly RendererStageFrame[];
  /** Camera and node geometry remain controlled by the Ship Studio parent. */
  camera: RendererStageCamera;
  selectedFrameId: string | null;
  inputFrameId?: string | null;
  /** The initial reveal barrier; later updates retain already-painted frames. */
  revealFrameIds?: readonly string[];
  /** Frame IDs whose current pixels may be retained while a new payload paints. */
  retainFrameIds?: readonly string[];
  onEvent?: (event: RendererStageEvent) => void;
  onStateChange?: (state: ComponentCanvasStageState) => void;
  onFrameElementChange?: (frame: HTMLIFrameElement | null) => void;
  className?: string;
  title?: string;
}

function frameIdentity(frame: RendererStageFrame): string {
  return JSON.stringify([
    frame.frameId,
    frame.componentId,
    frame.componentRevision,
    frame.generation,
    frame.props,
    frame.slots,
    frame.presentation,
    frame.layout,
    frame.visible ?? true,
  ]);
}

function frameIdentityMap(frames: readonly RendererStageFrame[]): Map<string, string> {
  return new Map(frames.map((frame) => [frame.frameId, frameIdentity(frame)]));
}

function stageErrorEvent(
  session: RendererSessionDescriptor,
  stageId: string,
  code: string,
  message: string,
  frameId?: string
): RendererStageEvent {
  return {
    protocolVersion: 3,
    contract: 'next-host-v2',
    type: 'stage-error',
    sessionId: session.sessionId,
    capabilityToken: session.capabilityToken,
    generation: session.generation,
    stageId,
    eventId: `stage-host-${code}-${Date.now()}`,
    code,
    message,
    ...(frameId ? { frameId } : {}),
  };
}

/**
 * One project-runtime iframe for the complete component canvas.
 *
 * The child owns framework execution and component interactivity. The parent
 * owns scene layout, camera, selection, persistence, and source authority.
 * The iframe remains hidden until the authenticated stage handshake and the
 * requested first-paint frame barrier complete; subsequent syncs retain the
 * old child paint until each changed frame reports `frame-rendered-dimensions`,
 * which is the generated-host proof that the component has painted measurable
 * pixels. `frame-ready` remains a lifecycle notification but is not enough to
 * reveal the stage on its own.
 */
export function ComponentCanvasStage({
  session,
  stageId,
  routeSegment,
  frames,
  camera,
  selectedFrameId,
  inputFrameId = selectedFrameId,
  revealFrameIds,
  retainFrameIds,
  onEvent,
  onStateChange,
  onFrameElementChange,
  className = 'component-canvas-stage',
  title = 'Interactive component canvas',
}: ComponentCanvasStageProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const eventGuardRef = useRef(new RendererStageEventGuard());
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const stageIdRef = useRef(stageId);
  stageIdRef.current = stageId;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const [state, setState] = useState<ComponentCanvasStageState>('loading');
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [stageReady, setStageReady] = useState(false);
  const stageReadyRef = useRef(false);
  const [readyFrameKeys, setReadyFrameKeys] = useState<Map<string, string>>(new Map());
  const [heartbeatSeen, setHeartbeatSeen] = useState(false);
  const identity = useMemo(
    () =>
      JSON.stringify([
        session.protocolVersion,
        session.sessionId,
        session.capabilityToken,
        session.generation,
        session.allowedOrigin,
        stageId,
      ]),
    [
      session.allowedOrigin,
      session.capabilityToken,
      session.generation,
      session.protocolVersion,
      session.sessionId,
      stageId,
    ]
  );
  const url = useMemo(
    () => rendererStageUrl(session, routeSegment, stageId),
    [routeSegment, session, stageId]
  );
  const currentFrameKeys = useMemo(() => frameIdentityMap(frames), [frames]);
  const frameMap = useMemo(() => new Map(frames.map((frame) => [frame.frameId, frame])), [frames]);
  const requiredRevealIds = useMemo(
    () =>
      [...new Set(revealFrameIds ?? frames.map((frame) => frame.frameId))].filter((id) =>
        frameMap.has(id)
      ),
    [frameMap, frames, revealFrameIds]
  );

  const updateState = useCallback((next: ComponentCanvasStageState) => {
    setState((current) => {
      if (current === next) return current;
      onStateChangeRef.current?.(next);
      return next;
    });
  }, []);

  const revealSatisfied = useMemo(
    () =>
      stageReady &&
      requiredRevealIds.every(
        (frameId) => readyFrameKeys.get(frameId) === currentFrameKeys.get(frameId)
      ),
    [currentFrameKeys, readyFrameKeys, requiredRevealIds, stageReady]
  );

  useEffect(() => {
    stageReadyRef.current = stageReady;
  }, [stageReady]);

  useEffect(() => {
    if (revealSatisfied) updateState('ready');
  }, [revealSatisfied, updateState]);

  useEffect(() => {
    // Presentation/layout updates should invalidate only the affected frame's
    // first-paint latch. The iframe itself remains mounted and visible while
    // the generated host performs its atomic old-paint → new-paint handoff.
    setReadyFrameKeys((current) => {
      const next = new Map<string, string>();
      for (const [frameId, key] of current) {
        if (currentFrameKeys.get(frameId) === key) next.set(frameId, key);
      }
      return next;
    });
  }, [currentFrameKeys]);

  useEffect(() => {
    setStageReady(false);
    setIframeLoaded(false);
    setHeartbeatSeen(false);
    setReadyFrameKeys(new Map());
    updateState('loading');
  }, [identity, updateState]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const guard = eventGuardRef.current;
    let readyTimeout: number | null = window.setTimeout(() => {
      if (stageReadyRef.current) return;
      const error = stageErrorEvent(
        sessionRef.current,
        stageIdRef.current,
        'stage-timeout',
        'The component canvas host did not complete its handshake in time.'
      );
      updateState('error');
      onEventRef.current?.(error);
    }, COMPONENT_RENDERER_STAGE_READY_TIMEOUT_MS);
    let heartbeatTimeout: number | null = null;
    const clearHeartbeat = () => {
      if (heartbeatTimeout !== null) window.clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    };
    const armHeartbeat = () => {
      clearHeartbeat();
      heartbeatTimeout = window.setTimeout(() => {
        const error = stageErrorEvent(
          sessionRef.current,
          stageIdRef.current,
          'stage-heartbeat-lost',
          'The component canvas host heartbeat stopped.'
        );
        updateState('error');
        onEventRef.current?.(error);
      }, COMPONENT_RENDERER_STAGE_HEARTBEAT_TIMEOUT_MS);
    };
    const handleMessage = (message: MessageEvent) => {
      const currentIframe = iframeRef.current;
      const accepted = guard.accept(message.data, {
        source: message.source,
        expectedSource: currentIframe?.contentWindow,
        origin: message.origin,
        expectedOrigin: sessionRef.current.allowedOrigin,
        session: sessionRef.current,
        stageId: stageIdRef.current,
        frames: new Map(
          framesRef.current.map((frame) => [
            frame.frameId,
            {
              componentId: frame.componentId,
              componentRevision: frame.componentRevision,
            },
          ])
        ),
      } satisfies RendererStageMessageContext);
      if (!accepted) return;
      if (accepted.type === 'stage-ready') {
        setStageReady(true);
        if (readyTimeout !== null) window.clearTimeout(readyTimeout);
        readyTimeout = null;
        armHeartbeat();
      } else if (accepted.type === 'heartbeat') {
        setHeartbeatSeen(true);
        if (readyTimeout !== null) window.clearTimeout(readyTimeout);
        readyTimeout = null;
        armHeartbeat();
      } else if (accepted.type === 'frame-rendered-dimensions') {
        setReadyFrameKeys((current) => {
          const next = new Map(current);
          next.set(accepted.frameId, currentFrameKeys.get(accepted.frameId) ?? '');
          return next;
        });
      } else if (accepted.type === 'frame-error' || accepted.type === 'stage-error') {
        if (accepted.type === 'stage-error' || requiredRevealIds.includes(accepted.frameId)) {
          updateState('error');
        }
      }
      onEventRef.current?.(accepted);
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      if (readyTimeout !== null) window.clearTimeout(readyTimeout);
      clearHeartbeat();
    };
  }, [currentFrameKeys, identity, requiredRevealIds, updateState]);

  const postSync = useCallback(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target || !iframeLoaded) return;
    const command = createRendererStageSyncCommand({
      session: sessionRef.current,
      stageId: stageIdRef.current,
      frames: framesRef.current,
      camera,
      selectedFrameId,
      inputFrameId,
      retainFrameIds,
      revealFrameIds: requiredRevealIds,
    });
    if (!command || !rendererStageMessageWithinBounds(command)) {
      updateState('error');
      onEventRef.current?.(
        stageErrorEvent(
          sessionRef.current,
          stageIdRef.current,
          'stage-sync-invalid',
          'The component canvas update exceeded the bounded stage contract.'
        )
      );
      return;
    }
    target.postMessage(command, sessionRef.current.allowedOrigin);
  }, [
    camera,
    iframeLoaded,
    inputFrameId,
    requiredRevealIds,
    retainFrameIds,
    selectedFrameId,
    updateState,
  ]);

  useEffect(() => {
    postSync();
  }, [postSync]);

  const handleLoad = useCallback(() => {
    setIframeLoaded(true);
    postSync();
  }, [postSync]);

  const setIframeElement = useCallback(
    (element: HTMLIFrameElement | null) => {
      iframeRef.current = element;
      onFrameElementChange?.(element);
    },
    [onFrameElementChange]
  );

  const visible = state === 'ready';
  const iframeStyle = {
    width: '100%',
    height: '100%',
    border: 0,
    visibility: visible ? ('visible' as const) : ('hidden' as const),
  };

  return (
    <iframe
      ref={setIframeElement}
      src={url}
      className={className}
      title={title}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      style={iframeStyle}
      data-stage-protocol={COMPONENT_RENDERER_STAGE_CONTRACT}
      data-stage-state={state}
      data-stage-visible={visible ? 'true' : 'false'}
      data-stage-camera-owner="parent"
      data-stage-heartbeat-seen={heartbeatSeen ? 'true' : undefined}
      onLoad={handleLoad}
    />
  );
}
