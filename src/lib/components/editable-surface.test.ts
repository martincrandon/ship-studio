import { describe, expect, it, vi } from 'vitest';
import {
  isEditableSurfaceMessage,
  isSameEditableSurface,
  deactivateEditableSurface,
  postToEditableSurface,
  validateRendererFrameEditContext,
  type EditableSurfaceTarget,
  type RendererFrameEditContext,
} from './editable-surface';

const target: EditableSurfaceTarget = {
  contentWindow: null,
  exactOrigin: 'http://127.0.0.1:4312',
  surfaceId: 'component-frame',
  sessionId: 'session-1',
  capabilityToken: 'capability-token',
  generation: 1,
  frameId: 'frame-1',
  componentId: 'react:Card',
  componentRevision: 'revision-1',
  capabilities: { liveFrame: true, snapshots: true, accessibility: true, editing: true },
};

const context: RendererFrameEditContext = {
  componentId: 'react:Card',
  indexedRevision: 'revision-1',
  definition: {
    file: 'src/components/Card.tsx',
    start: 10,
    end: 200,
    line: 1,
    column: 1,
    contentHash: 'file-hash',
  },
  descendant: {
    file: 'src/components/Card.tsx',
    start: 40,
    end: 80,
    contentHash: 'file-hash',
  },
  confidence: 'exact',
  proof: { sessionId: 'session-1', frameId: 'frame-1', componentRevision: 'revision-1' },
};

describe('editable component surfaces', () => {
  it('requires the same negotiated surface before binding an editor', () => {
    expect(isSameEditableSurface(target, { ...target })).toBe(true);
    expect(isSameEditableSurface(target, { ...target, frameId: 'frame-2' })).toBe(false);
    expect(isSameEditableSurface(null, target)).toBe(false);
  });

  it('posts editor messages only to the negotiated exact origin', () => {
    const postMessage = vi.fn();
    const targetWithWindow = {
      ...target,
      contentWindow: { postMessage } as unknown as Window,
    };
    expect(postToEditableSurface(targetWithWindow, { type: 'ss:activate' })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'ss:activate',
        protocolVersion: 2,
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
        generation: 1,
        frameId: 'frame-1',
        componentId: 'react:Card',
      },
      target.exactOrigin
    );
  });

  it('requires the v2 identity envelope for component-frame replies', () => {
    const securedTarget = {
      ...target,
      capabilityToken: 'capability-token',
      generation: 3,
    };
    const message = {
      protocolVersion: 2,
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      generation: 3,
      frameId: 'frame-1',
      componentId: 'react:Card',
    };
    expect(isEditableSurfaceMessage(securedTarget, message)).toBe(true);
    expect(isEditableSurfaceMessage(securedTarget, { ...message, generation: 4 })).toBe(false);
    expect(
      isEditableSurfaceMessage(securedTarget, { ...message, componentId: 'react:Other' })
    ).toBe(false);
  });

  it('adds the complete v2 identity while preserving the negotiated origin', () => {
    const postMessage = vi.fn();
    const securedTarget = {
      ...target,
      capabilityToken: 'capability-token',
      generation: 7,
      contentWindow: { postMessage } as unknown as Window,
    };
    expect(postToEditableSurface(securedTarget, { type: 'ss:requestTree' })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'ss:requestTree',
        protocolVersion: 2,
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
        generation: 7,
        frameId: 'frame-1',
        componentId: 'react:Card',
      },
      'http://127.0.0.1:4312'
    );
  });

  it('deactivates the previous surface before switching frames', () => {
    const postMessage = vi.fn();
    deactivateEditableSurface({
      ...target,
      contentWindow: { postMessage } as unknown as Window,
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'ss:deactivate',
        protocolVersion: 2,
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
        generation: 1,
        frameId: 'frame-1',
        componentId: 'react:Card',
      },
      target.exactOrigin
    );
    deactivateEditableSurface(null);
  });

  it('accepts an exact definition-contained range', () => {
    expect(validateRendererFrameEditContext(target, context)).toEqual({
      status: 'valid',
      source: context.descendant,
    });
  });

  it('refuses stale revisions and ranges outside the definition', () => {
    expect(
      validateRendererFrameEditContext({ ...target, componentRevision: 'revision-2' }, context)
        .status
    ).toBe('refused');
    expect(
      validateRendererFrameEditContext(
        { ...target },
        { ...context, descendant: { ...context.descendant, end: 201 } }
      ).status
    ).toBe('refused');
  });
});
