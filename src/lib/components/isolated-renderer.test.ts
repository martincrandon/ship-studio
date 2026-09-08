import { describe, expect, it, vi } from 'vitest';
import { createComponentCanvasFrame } from './canvas';
import {
  createComponentIsolatedRenderRequest,
  createComponentIsolatedRendererCapability,
  COMPONENT_ISOLATED_RENDERER_PROTOCOL,
  type ComponentIsolatedRenderRequest,
  type ComponentIsolatedRenderResult,
} from './isolated-renderer';
import type { ComponentDescriptor } from './types';

const component: ComponentDescriptor = {
  id: 'react:src/Card.tsx#Card',
  dialect: 'react',
  kind: 'component',
  name: 'Card',
  localName: 'Card',
  exportName: 'Card',
  description: null,
  definition: { file: 'src/Card.tsx', start: 0, end: 1, line: 1, column: 1, contentHash: 'hash' },
  props: [],
  slots: [],
  variantProps: [],
  usageCount: 0,
  capabilities: { isolatedPreview: true } as ComponentDescriptor['capabilities'],
  diagnostics: [],
};

describe('isolated component renderer capability', () => {
  it('only sends an identity and explicit frame values to a proven host', async () => {
    const frame = createComponentCanvasFrame(component, 'revision-1');
    frame.props = { tone: { kind: 'string', value: 'accent' } };
    const renderFrame = vi.fn(
      (request: ComponentIsolatedRenderRequest): Promise<ComponentIsolatedRenderResult> =>
        Promise.resolve({
          protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
          projectIdentity: 'project-key',
          frameId: request.frameId,
          sourceRevision: request.sourceRevision,
          imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
          renderFingerprint: 'pixels-1',
          width: 320,
          height: 180,
          screenshotPath: '/tmp/card.png',
        })
    );
    const capability = createComponentIsolatedRendererCapability(
      {
        protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
        projectIdentity: 'project-key',
        renderFrame,
      },
      'project-key'
    );
    expect(capability).not.toBeNull();
    const request = createComponentIsolatedRenderRequest(
      frame,
      component,
      'revision-1',
      'project-key'
    );
    const result = await capability!.renderFrame(request);
    expect(renderFrame).toHaveBeenCalledWith(request);
    expect(result.renderFingerprint).toBe('pixels-1');
    expect(request).not.toHaveProperty('sourceText');
    expect(request).not.toHaveProperty('definition');
  });

  it('fails closed for project paths, stale responses, and invalid image results', async () => {
    const frame = createComponentCanvasFrame(component, 'revision-1');
    expect(
      createComponentIsolatedRendererCapability(
        {
          protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
          projectIdentity: '/Users/me/project',
          renderFrame: vi.fn(),
        },
        '/Users/me/project'
      )
    ).toBeNull();

    const capability = createComponentIsolatedRendererCapability(
      {
        protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
        projectIdentity: 'project-key',
        renderFrame: vi.fn(
          (): Promise<ComponentIsolatedRenderResult> =>
            Promise.resolve({
              protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
              projectIdentity: 'project-key',
              frameId: 'different-frame',
              sourceRevision: 'revision-1',
              imageDataUrl: 'not-an-image',
              renderFingerprint: '',
              width: 0,
              height: 180,
            })
        ),
      },
      'project-key'
    );
    await expect(
      capability!.renderFrame(
        createComponentIsolatedRenderRequest(frame, component, 'revision-1', 'project-key')
      )
    ).rejects.toThrow(/invalid or stale/i);
  });

  it('binds host pixel differences to the requested baseline fingerprint', async () => {
    const frame = createComponentCanvasFrame(component, 'revision-1');
    const renderFrame = vi.fn(
      (request: ComponentIsolatedRenderRequest): Promise<ComponentIsolatedRenderResult> =>
        Promise.resolve({
          protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
          projectIdentity: 'project-key',
          frameId: request.frameId,
          sourceRevision: request.sourceRevision,
          imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
          renderFingerprint: 'pixels-current',
          width: 320,
          height: 180,
          pixelDifference: 0.01,
          comparedBaselineFingerprint: request.baselineFingerprint,
        })
    );
    const capability = createComponentIsolatedRendererCapability(
      {
        protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
        projectIdentity: 'project-key',
        renderFrame,
      },
      'project-key'
    );
    const request = createComponentIsolatedRenderRequest(
      frame,
      component,
      'revision-1',
      'project-key',
      'baseline-1'
    );
    const result = await capability!.renderFrame(request);
    expect(request.baselineFingerprint).toBe('baseline-1');
    expect(result.comparedBaselineFingerprint).toBe('baseline-1');

    const mismatchedCapability = createComponentIsolatedRendererCapability(
      {
        protocolVersion: COMPONENT_ISOLATED_RENDERER_PROTOCOL,
        projectIdentity: 'project-key',
        renderFrame: vi.fn((currentRequest: ComponentIsolatedRenderRequest) =>
          Promise.resolve({
            ...result,
            frameId: currentRequest.frameId,
            sourceRevision: currentRequest.sourceRevision,
            comparedBaselineFingerprint: 'different-baseline',
          })
        ),
      },
      'project-key'
    );
    await expect(mismatchedCapability!.renderFrame(request)).rejects.toThrow(/invalid or stale/i);
  });
});
