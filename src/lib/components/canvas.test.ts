import { describe, expect, it } from 'vitest';
import type { ComponentDescriptor, ComponentIndex } from './types';
import {
  addCanvasFrame,
  arrangeCanvasNodes,
  autoLayoutCanvasNodes,
  CANVAS_LAYOUT_LABEL_CLEARANCE,
  canvasFrameIdentity,
  componentCanvasNodeId,
  createEmptyCanvasDocument,
  COMPONENT_CANVAS_MAX_FRAMES,
  createComponentCanvasFrame,
  deleteCanvasNode,
  duplicateCanvasNode,
  expandFiniteVariantMatrix,
  finiteVariantChoices,
  resolveGeneratedCanvasVariant,
  resolveGeneratedCanvasVariantForComponent,
  moveCanvasFrame,
  reconcileCanvasFrames,
  removeCanvasFrame,
  parseComponentCanvasDocument,
} from './canvas';

const source = {
  file: 'src/Card.tsx',
  start: 0,
  end: 1,
  line: 1,
  column: 1,
  contentHash: 'card-hash',
};

const component: ComponentDescriptor = {
  id: 'react:src/Card.tsx#Card',
  dialect: 'react',
  kind: 'component',
  name: 'Card',
  localName: 'Card',
  exportName: 'Card',
  description: null,
  definition: source,
  props: [
    {
      name: 'tone',
      required: false,
      typeText: "'neutral' | 'accent'",
      defaultValue: { kind: 'string', value: 'neutral' },
      choices: [
        { kind: 'string', value: 'neutral' },
        { kind: 'string', value: 'accent' },
      ],
      control: 'select',
      source,
      diagnostics: [],
    },
  ],
  slots: [],
  variantProps: ['tone'],
  usageCount: 0,
  capabilities: {} as ComponentDescriptor['capabilities'],
  diagnostics: [],
};

const index: ComponentIndex = {
  revision: 'revision-1',
  partial: false,
  profile: {
    projectType: null,
    primaryDialect: 'react',
    dialects: ['react'],
    workspaceRoot: '.',
    capabilities: {} as ComponentIndex['profile']['capabilities'],
    diagnostics: [],
  },
  components: [component],
  instances: [],
  importEdges: [],
  diagnostics: [],
};

describe('component canvas frame model', () => {
  it('creates explicit frames without copying component defaults', () => {
    const frame = createComponentCanvasFrame(component, index.revision);
    expect(frame.props).toEqual({});
    expect(frame.widthMode).toBe('fit');
    expect(frame.height).toBe(480);
  });

  it('only exposes parser-proven finite variant choices', () => {
    expect(finiteVariantChoices(component)).toEqual([
      {
        name: 'tone',
        choices: [
          { kind: 'string', value: 'neutral' },
          { kind: 'string', value: 'accent' },
        ],
      },
    ]);
  });

  it('previews a bounded finite matrix with separate generated test cases', () => {
    const result = expandFiniteVariantMatrix(component, {
      componentId: component.id,
      presentation: { background: 'surface', breakpoint: null, locale: null },
    });
    expect(result.prospectiveCount).toBe(2);
    expect(result.variants.map((variant) => variant.props.tone)).toEqual([
      { kind: 'string', value: 'neutral' },
      { kind: 'string', value: 'accent' },
    ]);
    expect(result.nodes.map((node) => node.presetId)).toEqual(
      result.variants.map((variant) => variant.id)
    );
    expect(
      resolveGeneratedCanvasVariant(
        { [component.id]: result.variants },
        result.nodes[1]?.presetId ?? null
      )
    ).toMatchObject({ props: { tone: { kind: 'string', value: 'accent' } } });
    expect(
      resolveGeneratedCanvasVariantForComponent(component, result.nodes[1]?.presetId ?? null)
    ).toMatchObject({ props: { tone: { kind: 'string', value: 'accent' } } });
  });

  it('bounds frames and supports explicit reorder/remove operations', () => {
    const first = createComponentCanvasFrame(component, index.revision);
    const second = { ...first, id: 'second', name: 'Second' };
    expect(addCanvasFrame([first], second).frames).toHaveLength(2);
    expect(moveCanvasFrame([first, second], first.id, 'down').map((item) => item.id)).toEqual([
      'second',
      first.id,
    ]);
    expect(removeCanvasFrame([first, second], second.id)).toEqual([first]);

    const atLimit = Array.from({ length: COMPONENT_CANVAS_MAX_FRAMES }, (_, position) => ({
      ...first,
      id: `frame-${position}`,
    }));
    expect(addCanvasFrame(atLimit, { ...first, id: 'overflow' }).refused).toBe(true);
  });

  it('keeps stale source identities and missing definitions orphaned', () => {
    const frame = createComponentCanvasFrame(component, index.revision);
    const renamed = { ...frame, componentId: 'react:src/Removed.tsx#Removed' };
    const result = reconcileCanvasFrames([renamed], index);
    expect(result.active).toEqual([]);
    expect(result.orphaned[0]).toMatchObject({ reason: 'missing-component' });
    expect(canvasFrameIdentity(frame, 'revision-2')).not.toBe(
      canvasFrameIdentity(frame, index.revision)
    );
  });
});

describe('component canvas document model', () => {
  it.each([null, undefined])('treats %s as a fresh project document', (payload) => {
    const parsed = parseComponentCanvasDocument(payload);
    expect(parsed.document).toEqual(createEmptyCanvasDocument());
    expect(parsed.unreadablePayload).toBeUndefined();
  });

  it('preserves malformed saved payloads for diagnostics', () => {
    const parsed = parseComponentCanvasDocument({ version: 1, nodes: 'broken' });
    expect(parsed.document.version).toBe(2);
    expect(parsed.unreadablePayload).toEqual({ version: 1, nodes: 'broken' });
  });

  it('uses stable opaque node ids and deterministic layout', () => {
    const first = {
      id: componentCanvasNodeId(component.id, null, 'all'),
      scope: 'all' as const,
      componentId: component.id,
      presetId: null,
      x: 100,
      y: 100,
      width: 320,
      height: 480,
      order: 4,
      collapsed: false,
      generated: true,
      presentation: { background: 'surface' as const, breakpoint: null, locale: null },
    };
    const second = { ...first, id: 'another-node', componentId: 'react:src/Other.tsx#Other' };
    expect(componentCanvasNodeId(component.id, null, 'all')).toBe(first.id);
    expect(autoLayoutCanvasNodes([second, first])).toEqual(autoLayoutCanvasNodes([first, second]));
    expect(createEmptyCanvasDocument().scopes.focus.camera.zoom).toBe(1);
  });

  it('lays out each canvas scope independently', () => {
    const makeNode = (id: string, scope: 'all' | 'focus') => ({
      id,
      scope,
      componentId: 'react:Card',
      presetId: null,
      x: 900,
      y: 900,
      width: 320,
      height: 480,
      order: 0,
      collapsed: false,
      generated: true,
      presentation: { background: 'surface' as const, breakpoint: null, locale: null },
    });
    const arranged = autoLayoutCanvasNodes(
      [makeNode('focus', 'focus'), makeNode('all-second', 'all'), makeNode('all-first', 'all')],
      2,
      24
    );

    expect(arranged.find((node) => node.id === 'all-first')).toMatchObject({ x: 32, y: 32 });
    expect(arranged.find((node) => node.id === 'all-second')).toMatchObject({ x: 376, y: 32 });
    expect(arranged.find((node) => node.id === 'focus')).toMatchObject({ x: 32, y: 32 });
  });

  it('arranges a selection without moving unrelated frames', () => {
    const first = {
      id: 'first',
      scope: 'all' as const,
      componentId: component.id,
      presetId: null,
      x: 20,
      y: 30,
      width: 320,
      height: 480,
      order: 0,
      collapsed: false,
      generated: true,
      presentation: { background: 'surface' as const, breakpoint: null, locale: null },
    };
    const second = { ...first, id: 'second', x: 800, y: 900, order: 1 };
    const result = arrangeCanvasNodes([first, second], ['first']);
    expect(result.find((node) => node.id === 'second')).toMatchObject({ x: 800, y: 900 });
    expect(result.find((node) => node.id === 'first')).toMatchObject({ x: 20, y: 30 });
    expect(duplicateCanvasNode([first], 'first', 'copy').nodes[1]?.id).toBe('copy');
    expect(deleteCanvasNode([first], 'first').refused).toBe(true);
  });

  it('packs mixed-size layouts by advancing the shortest column', () => {
    const makeNode = (id: string, componentId: string, width: number, height: number) => ({
      id,
      scope: 'all' as const,
      componentId,
      presetId: null,
      x: 0,
      y: 0,
      width,
      height,
      order: 0,
      collapsed: false,
      generated: true,
      presentation: { background: 'surface' as const, breakpoint: null, locale: null },
    });
    const first = makeNode('first', 'react:A', 800, 200);
    const second = makeNode('second', 'react:B', 320, 600);
    const third = makeNode('third', 'react:C', 240, 180);

    const arranged = autoLayoutCanvasNodes([third, second, first], 2, 24);
    expect(arranged.find((node) => node.id === 'first')).toMatchObject({
      x: CANVAS_LAYOUT_LABEL_CLEARANCE,
      y: CANVAS_LAYOUT_LABEL_CLEARANCE,
    });
    expect(arranged.find((node) => node.id === 'second')).toMatchObject({
      x: CANVAS_LAYOUT_LABEL_CLEARANCE + 824,
      y: CANVAS_LAYOUT_LABEL_CLEARANCE,
    });
    expect(arranged.find((node) => node.id === 'third')).toMatchObject({
      x: CANVAS_LAYOUT_LABEL_CLEARANCE,
      y: CANVAS_LAYOUT_LABEL_CLEARANCE + 224,
    });

    const selected = arrangeCanvasNodes(
      [
        { ...first, x: 100, y: 200, order: 0 },
        { ...second, x: 700, y: 800, order: 1 },
      ],
      ['first', 'second'],
      2,
      24
    );
    expect(selected.find((node) => node.id === 'second')).toMatchObject({ x: 924, y: 200 });
  });

  it('reserves label clearance when arranging the whole canvas', () => {
    const arranged = arrangeCanvasNodes([
      {
        id: 'first',
        scope: 'all',
        componentId: 'react:A',
        presetId: null,
        x: 800,
        y: 900,
        width: 320,
        height: 480,
        order: 0,
        collapsed: false,
        generated: true,
        presentation: { background: 'surface', breakpoint: null, locale: null },
      },
    ]);
    expect(arranged[0]).toMatchObject({
      x: CANVAS_LAYOUT_LABEL_CLEARANCE,
      y: CANVAS_LAYOUT_LABEL_CLEARANCE,
    });
  });
});
