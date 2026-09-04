import { describe, expect, it } from 'vitest';
import { REACT_COMPONENT_PLAN_PARSER_TOKEN, validateReactMutation } from './mutation';
import { sha256 } from './ranges';
import type { ComponentMutationPlan, ComponentSourceSnapshot, SourceFileSnapshot } from './types';

const source = `export default function Card() {
  return <article />;
}
`;

function file(): SourceFileSnapshot {
  return { file: 'src/Card.tsx', content: source, contentHash: sha256(source) };
}

function snapshot(): ComponentSourceSnapshot {
  return {
    workspaceRoot: '.',
    revision: 'revision',
    files: [file()],
    partial: false,
    diagnostics: [],
  };
}

function plan(overrides: Partial<ComponentMutationPlan> = {}): ComponentMutationPlan {
  return {
    files: [
      {
        file: 'src/Card.tsx',
        expectedHash: sha256(source),
        expectedResultHash: sha256(source),
        edits: [],
      },
    ],
    dialect: 'react',
    parserToken: REACT_COMPONENT_PLAN_PARSER_TOKEN,
    expectedRevision: 'revision',
    expectedGraphDelta: {
      componentId: 'react:src/Card.tsx#default',
      usagesBefore: 0,
      usagesAfter: 0,
      delta: 0,
    },
    ...overrides,
  };
}

describe('React mutation protocol', () => {
  it('accepts a complete parser-backed edit plan', () => {
    expect(validateReactMutation({ plan: plan(), snapshot: snapshot() })).toEqual({
      status: 'valid',
      diagnostics: [],
    });
  });

  it('refuses a graph delta whose arithmetic is inconsistent', () => {
    const result = validateReactMutation({
      plan: plan({
        expectedGraphDelta: {
          componentId: 'react:src/Card.tsx#default',
          usagesBefore: 0,
          usagesAfter: 1,
          delta: 0,
        },
      }),
      snapshot: snapshot(),
    });
    expect(result).toMatchObject({
      status: 'invalid',
      diagnostics: [expect.objectContaining({ code: 'mutation-graph-delta' })],
    });
  });
});
