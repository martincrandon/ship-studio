import { describe, expect, it } from 'vitest';
import type { ComponentDescriptor, ComponentIndex } from './types';
import {
  addCanvasFrame,
  canvasFrameIdentity,
  COMPONENT_CANVAS_MAX_FRAMES,
  createComponentCanvasFrame,
  finiteVariantChoices,
  moveCanvasFrame,
  reconcileCanvasFrames,
  removeCanvasFrame,
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
