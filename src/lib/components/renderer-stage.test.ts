import { describe, expect, it } from 'vitest';
import {
  COMPONENT_RENDERER_STAGE_CONTRACT,
  COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION,
  createRendererStageSyncCommand,
  rendererStageMessageWithinBounds,
  rendererStageUrl,
  validateRendererStageEvent,
  RendererStageEventGuard,
  type RendererStageFrame,
  type RendererStageCamera,
} from './renderer-stage';
import type { RendererSessionDescriptor } from './renderer-session';

const session: RendererSessionDescriptor = {
  protocolVersion: 2,
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  allowedOrigin: 'http://127.0.0.1:4312',
  baseUrl: 'http://127.0.0.1:4312/',
  generation: 4,
  projectIdentity: 'project-1',
  supportedComponentIds: ['react:Button'],
  sourceRevisions: { 'react:Button': 'revision-1' },
  capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: true },
};

const camera: RendererStageCamera = { x: 10, y: 20, zoom: 1, owner: 'parent' };

const frame: RendererStageFrame = {
  protocolVersion: 2,
  projectIdentity: 'project-1',
  sessionId: 'session-1',
  frameId: 'node-1',
  componentId: 'react:Button',
  componentRevision: 'revision-1',
  generation: 4,
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
  layout: { x: 40, y: 50, width: 240, height: 240 },
};

function event(type: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: COMPONENT_RENDERER_STAGE_PROTOCOL_VERSION,
    contract: COMPONENT_RENDERER_STAGE_CONTRACT,
    sessionId: session.sessionId,
    capabilityToken: session.capabilityToken,
    generation: session.generation,
    stageId: 'stage-1',
    eventId: `event-${type}`,
    type,
    ...extra,
  };
}

describe('renderer stage contract', () => {
  it('uses a routable stage URL and keeps credentials out of the URL', () => {
    expect(rendererStageUrl(session, 'shipstudio_canvas_stage', 'stage 1')).toBe(
      'http://127.0.0.1:4312/shipstudio_canvas_stage?stageId=stage%201'
    );
  });

  it('builds a parent-controlled sync with atomic retain/reveal handoff IDs', () => {
    const command = createRendererStageSyncCommand({
      session,
      stageId: 'stage-1',
      frames: [frame],
      camera,
      selectedFrameId: 'node-1',
      inputFrameId: 'node-1',
      retainFrameIds: ['node-1', 'stale-node'],
      revealFrameIds: ['node-1'],
    });

    expect(command).toMatchObject({
      protocolVersion: 3,
      contract: 'next-host-v2',
      camera: { owner: 'parent' },
      selectedFrameId: 'node-1',
      retainFrameIds: ['node-1'],
      revealFrameIds: ['node-1'],
    });
    expect(rendererStageMessageWithinBounds(command)).toBe(true);
  });

  it('fails closed for a frame outside the session allowlist or with a stale revision', () => {
    expect(
      createRendererStageSyncCommand({
        session,
        stageId: 'stage-1',
        frames: [{ ...frame, componentRevision: 'stale' }],
        camera,
        selectedFrameId: null,
        inputFrameId: null,
      })
    ).toBeNull();
  });

  it('validates exact origin, source, stage identity, and current frame revision', () => {
    const frames = new Map([[frame.frameId, frame]]);
    const context = {
      source: 'child-window',
      expectedSource: 'child-window',
      origin: session.allowedOrigin,
      expectedOrigin: session.allowedOrigin,
      session,
      stageId: 'stage-1',
      frames,
    };

    expect(
      validateRendererStageEvent(event('stage-ready', { frameIds: ['node-1'] }), context)
    ).toMatchObject({
      type: 'stage-ready',
    });
    expect(
      validateRendererStageEvent(
        event('frame-ready', {
          frameId: 'node-1',
          componentId: 'react:Button',
          componentRevision: 'revision-1',
        }),
        context
      )
    ).toMatchObject({ type: 'frame-ready', frameId: 'node-1' });
    expect(
      validateRendererStageEvent(
        event('frame-ready', {
          frameId: 'node-1',
          componentId: 'react:Button',
          componentRevision: 'stale',
        }),
        context
      )
    ).toBeNull();
    expect(
      validateRendererStageEvent(event('heartbeat'), { ...context, origin: 'https://evil.test' })
    ).toBeNull();
  });

  it('rejects replayed events on the shared stage stream', () => {
    const guard = new RendererStageEventGuard({ now: () => 100 });
    const context = {
      source: 'child-window',
      expectedSource: 'child-window',
      origin: session.allowedOrigin,
      expectedOrigin: session.allowedOrigin,
      session,
      stageId: 'stage-1',
      frames: new Map([[frame.frameId, frame]]),
    };
    const heartbeat = event('heartbeat');
    expect(guard.accept(heartbeat, context)).not.toBeNull();
    expect(guard.accept(heartbeat, context)).toBeNull();
  });
});
