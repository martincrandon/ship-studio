import { describe, expect, it } from 'vitest';
import {
  adaptCanvasDocument,
  canApplyRendererMeasurement,
  createCanvasDocumentV2,
  readCanvasDocumentGuides,
  readCanvasNodeSceneExtension,
  serializeCanvasDocument,
} from './canvas-document';

describe('canvas document v2 adapter', () => {
  it('round-trips unknown root, node, scope, and presentation fields', () => {
    const source = {
      version: 2,
      futureRoot: { enabled: true },
      nodes: [
        {
          id: 'one',
          scope: 'all',
          componentId: 'react:Card',
          presetId: null,
          x: 10,
          y: 20,
          width: 100,
          height: 80,
          order: 0,
          collapsed: false,
          generated: false,
          futureNode: ['kept'],
          presentation: {
            background: 'surface',
            breakpoint: null,
            locale: null,
            futurePresentation: 'kept',
          },
        },
      ],
      scopes: {
        focus: {
          camera: { x: 0, y: 0, zoom: 1, futureCamera: 'kept' },
          expandedComponentIds: [],
          futureScope: 7,
        },
        variants: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        all: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
      },
    };
    const result = adaptCanvasDocument(source);
    expect(serializeCanvasDocument(result.document)).toEqual(source);
    expect(source.nodes[0]).not.toBe(result.document.nodes[0]);
  });

  it('returns a clean extension-ready v2 document', () => {
    const document = createCanvasDocumentV2({ futureRoot: 'available' });
    expect(document.version).toBe(2);
    expect(document.futureRoot).toBe('available');
  });

  it('validates and round-trips rotation, hierarchy, and guide extensions', () => {
    const source = {
      version: 2,
      nodes: [
        {
          id: 'parent',
          scope: 'all',
          componentId: 'react:Parent',
          presetId: null,
          x: 10,
          y: 20,
          width: 100,
          height: 80,
          order: 0,
          collapsed: false,
          generated: false,
          parentId: null,
          rotation: 15,
          sizeMode: 'fixed',
          futureNode: { keep: true },
          presentation: { background: 'surface', breakpoint: null, locale: null },
        },
        {
          id: 'child',
          scope: 'all',
          componentId: 'react:Child',
          presetId: null,
          x: 5,
          y: 6,
          width: 40,
          height: 30,
          order: 1,
          collapsed: false,
          generated: false,
          parentId: 'parent',
          rotation: -30,
          presentation: { background: 'surface', breakpoint: null, locale: null },
        },
      ],
      guides: [
        {
          id: 'guide-x',
          orientation: 'vertical',
          position: 120,
          locked: true,
          futureGuide: 'keep',
        },
      ],
      scopes: {
        focus: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        variants: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        all: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
      },
    };
    const result = adaptCanvasDocument(source).document;
    expect(serializeCanvasDocument(result)).toEqual(source);
    expect(readCanvasNodeSceneExtension(result.nodes[1]!)).toEqual({
      parentId: 'parent',
      rotation: -30,
    });
    expect(readCanvasNodeSceneExtension(result.nodes[0]!)).toMatchObject({ sizeMode: 'fixed' });
    expect(readCanvasDocumentGuides(result)[0]).toMatchObject({
      id: 'guide-x',
      position: 120,
      locked: true,
      futureGuide: 'keep',
    });
  });

  it('treats omitted sizing as auto and blocks late renderer measurements for fixed nodes', () => {
    const source = {
      version: 2,
      nodes: [
        {
          id: 'auto',
          scope: 'all',
          componentId: 'react:Auto',
          presetId: null,
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          order: 0,
          collapsed: false,
          generated: false,
          futureNode: 'preserve-me',
          presentation: { background: 'surface', breakpoint: null, locale: null },
        },
        {
          id: 'fixed',
          scope: 'all',
          componentId: 'react:Fixed',
          presetId: null,
          x: 120,
          y: 0,
          width: 240,
          height: 160,
          order: 1,
          collapsed: false,
          generated: false,
          sizeMode: 'fixed',
          presentation: { background: 'surface', breakpoint: null, locale: null },
        },
      ],
      scopes: {
        focus: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        variants: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        all: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
      },
    };
    const document = adaptCanvasDocument(source).document;
    expect(document.nodes[0]).not.toHaveProperty('sizeMode');
    expect(document.nodes[1]).toHaveProperty('sizeMode', 'fixed');
    expect(document.nodes[0]).toHaveProperty('futureNode', 'preserve-me');
    expect(serializeCanvasDocument(document)).toEqual(source);
    expect(canApplyRendererMeasurement(document.nodes[0])).toBe(true);
    expect(canApplyRendererMeasurement(document.nodes[0], { activeResize: true })).toBe(false);
    expect(canApplyRendererMeasurement(document.nodes[1])).toBe(false);
    expect(canApplyRendererMeasurement(undefined)).toBe(true);
  });

  it('drops malformed known extensions while retaining valid scene data', () => {
    const source = {
      version: 2,
      nodes: [
        {
          id: 'node',
          scope: 'all',
          componentId: 'react:Card',
          presetId: null,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          order: 0,
          collapsed: false,
          generated: false,
          parentId: 'node',
          rotation: 'not-a-number',
          sizeMode: 'manual',
          presentation: { background: 'surface', breakpoint: null, locale: null },
        },
      ],
      guides: [
        { id: 'bad', orientation: 'diagonal', position: 1 },
        { id: 'good', orientation: 'horizontal', position: 20 },
      ],
      scopes: {
        focus: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        variants: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
        all: { camera: { x: 0, y: 0, zoom: 1 }, expandedComponentIds: [] },
      },
    };
    const node = adaptCanvasDocument(source).document.nodes[0]!;
    expect(node).not.toHaveProperty('parentId');
    expect(node).not.toHaveProperty('rotation');
    expect(node).not.toHaveProperty('sizeMode');
    expect(readCanvasDocumentGuides(adaptCanvasDocument(source).document)).toEqual([
      { id: 'good', orientation: 'horizontal', position: 20 },
    ]);
  });
});
