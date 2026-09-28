import { describe, expect, it } from 'vitest';
import {
  COMPONENT_RENDERER_SESSION_PROTOCOL,
  COMPONENT_RENDERER_MAX_MESSAGE_RATE,
  RendererSessionManager,
  RendererEventGuard,
  rendererComponentIsAllowed,
  rendererMessageWithinBounds,
  validateRendererHostEvent,
  type RendererMessageContext,
  type RendererSessionDescriptor,
} from './renderer-session';

const session: RendererSessionDescriptor = {
  protocolVersion: COMPONENT_RENDERER_SESSION_PROTOCOL,
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  allowedOrigin: 'http://127.0.0.1:4321',
  baseUrl: 'http://127.0.0.1:4321/component-renderer',
  generation: 2,
  projectIdentity: 'project-1',
  supportedComponentIds: ['react:Card'],
  sourceRevisions: { 'react:Card': 'revision-1' },
  capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: false },
};

const source = {};
const context: RendererMessageContext = {
  source,
  expectedSource: source,
  origin: session.allowedOrigin,
  expectedOrigin: session.allowedOrigin,
  session,
  frame: { frameId: 'frame-1', componentId: 'react:Card', componentRevision: 'revision-1' },
};

function event(
  overrides: Record<string, unknown> = {},
  targetSession: RendererSessionDescriptor = session
) {
  return {
    protocolVersion: COMPONENT_RENDERER_SESSION_PROTOCOL,
    sessionId: targetSession.sessionId,
    capabilityToken: targetSession.capabilityToken,
    generation: targetSession.generation,
    frameId: 'frame-1',
    componentId: 'react:Card',
    eventId: 'event-1',
    type: 'ready',
    ...overrides,
  };
}

describe('renderer session trust boundary', () => {
  it('accepts a current ready event and rejects wrong origin/source/token', () => {
    expect(validateRendererHostEvent(event(), context)?.type).toBe('ready');
    expect(validateRendererHostEvent(event({ type: 'heartbeat' }), context)?.type).toBe(
      'heartbeat'
    );
    expect(
      validateRendererHostEvent(event(), { ...context, origin: 'http://evil.test' })
    ).toBeNull();
    expect(validateRendererHostEvent(event({ capabilityToken: 'wrong' }), context)).toBeNull();
    expect(validateRendererHostEvent(event(), { ...context, source: {} })).toBeNull();
  });

  it('accepts only bounded accessibility results for the requested frame', () => {
    expect(
      validateRendererHostEvent(
        event({
          type: 'accessibility-result',
          requestId: 'a11y-1',
          findings: [
            {
              id: 'image-alt',
              impact: 'serious',
              message: 'Image is missing an alt attribute.',
              elementRef: 'body>img:nth-child(1)',
            },
          ],
        }),
        context
      )
    ).toMatchObject({ type: 'accessibility-result', requestId: 'a11y-1' });
    expect(
      validateRendererHostEvent(
        event({ type: 'accessibility-result', requestId: 'a11y-1', findings: [] }),
        { ...context, origin: 'http://evil.test' }
      )
    ).toBeNull();
    expect(
      validateRendererHostEvent(
        event({
          type: 'accessibility-result',
          requestId: 'a11y-1',
          findings: [{ id: 'x', impact: 'serious', message: 'x'.repeat(4097) }],
        }),
        context
      )
    ).toBeNull();
  });

  it('accepts a bounded element selection only with its renderer-proof signature', () => {
    const accepted = validateRendererHostEvent(
      event({
        type: 'element-selection',
        sourceRange: {
          file: 'src/Card.tsx',
          start: 12,
          end: 42,
          contentHash: 'hash-1',
        },
        signature: {
          tagName: 'article',
          className: 'card',
          ancestorClasses: [],
          sourceFile: 'src/Card.tsx',
          sourceLine: 4,
          sourceColumn: 3,
          domPath: 'body:0>article:0',
        },
      }),
      context
    );
    expect(accepted).toMatchObject({ type: 'element-selection', sourceRange: { start: 12 } });
    expect(
      validateRendererHostEvent(
        event({
          type: 'element-selection',
          sourceRange: { file: 'src/Card.tsx', start: 12, end: 42, contentHash: 'hash-1' },
          signature: { tagName: 'article', className: 'card', ancestorClasses: ['x'.repeat(513)] },
        }),
        context
      )
    ).toBeNull();
  });

  it('rejects stale revisions and oversized diagnostics', () => {
    expect(
      validateRendererHostEvent(
        event({ type: 'revision-change', componentRevision: 'old' }),
        context
      )
    ).toBeNull();
    expect(
      validateRendererHostEvent(
        event({ type: 'console-diagnostic', level: 'error', message: 'x'.repeat(4097) }),
        context
      )
    ).toBeNull();
  });

  it('requires the session allowlist and current source revision', () => {
    expect(rendererComponentIsAllowed(session, 'react:Card', 'revision-1')).toBe(true);
    expect(rendererComponentIsAllowed(session, 'react:Other', 'revision-1')).toBe(false);
    expect(rendererComponentIsAllowed(session, 'react:Card', 'revision-2')).toBe(false);
  });

  it('deduplicates events, enforces a rate bound, and invalidates sessions', () => {
    let now = 10_000;
    const manager = new RendererSessionManager({
      now: () => now,
      idFactory: () => 'managed-session',
      tokenFactory: () => 'managed-token',
    });
    const managed = manager.prepare({
      projectIdentity: 'project-1',
      allowedOrigin: session.allowedOrigin,
      baseUrl: session.baseUrl,
      supportedComponentIds: ['react:Card'],
      sourceRevisions: { 'react:Card': 'revision-1' },
      capabilities: session.capabilities,
    });
    const managedContext = { ...context, session: managed };
    expect(
      manager.acceptEvent(event({ eventId: 'unique' }, managed), managedContext)?.eventId
    ).toBe('unique');
    expect(manager.acceptEvent(event({ eventId: 'unique' }, managed), managedContext)).toBeNull();
    for (let index = 0; index < 29; index += 1) {
      expect(
        manager.acceptEvent(event({ eventId: `event-${index}` }, managed), managedContext)
      ).not.toBeNull();
    }
    expect(
      manager.acceptEvent(event({ eventId: 'rate-limited' }, managed), managedContext)
    ).toBeNull();
    now += 1_001;
    expect(
      manager.acceptEvent(event({ eventId: 'after-window' }, managed), managedContext)
    ).not.toBeNull();
    now = Number.MAX_SAFE_INTEGER;
    expect(manager.get(managed.sessionId)).toEqual(managed);
    expect(manager.invalidateProject('project-1')).toBe(1);
    expect(manager.get(managed.sessionId)).toBeNull();
  });

  it('rejects cyclic, deeply nested, and oversized messages', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(rendererMessageWithinBounds(cyclic)).toBe(false);
    let nested: unknown = 'value';
    for (let index = 0; index < 10; index += 1) nested = { nested };
    expect(rendererMessageWithinBounds(nested)).toBe(false);
    expect(rendererMessageWithinBounds({ message: 'x'.repeat(128 * 1024) })).toBe(false);
    expect(rendererMessageWithinBounds({ message: 'é'.repeat(65_536) })).toBe(false);
  });

  it('bounds one production message stream, rejects replay, and resets for a new generation', () => {
    let now = Date.now();
    const guard = new RendererEventGuard({ now: () => now });
    expect(guard.accept(event({ eventId: 'valid' }), context)?.type).toBe('ready');
    expect(guard.accept(event({ eventId: 'valid' }), context)).toBeNull();
    expect(
      guard.accept(event({ eventId: 'oversized', padding: 'x'.repeat(128 * 1024) }), context)
    ).toBeNull();

    for (let index = 0; index < COMPONENT_RENDERER_MAX_MESSAGE_RATE - 1; index += 1) {
      expect(guard.accept(event({ eventId: `event-${index}` }), context)?.type).toBe('ready');
    }
    expect(guard.accept(event({ eventId: 'rate-limited' }), context)).toBeNull();

    now += 1_001;
    expect(guard.accept(event({ eventId: 'after-window' }), context)?.type).toBe('ready');

    const nextSession = { ...session, sessionId: 'session-2', generation: 3 };
    const nextContext = { ...context, session: nextSession };
    expect(guard.accept(event({ eventId: 'valid' }, nextSession), nextContext)?.type).toBe('ready');
  });
});
