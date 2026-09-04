import { describe, expect, it } from 'vitest';
import type { ComponentDescriptor } from './types';
import { createComponentCanvasFrame } from './canvas';
import {
  buildComponentQAAgentPayload,
  compareComponentQABaseline,
  COMPONENT_QA_MAX_MATRIX_CASES,
  createComponentQABaseline,
  planComponentQAMatrix,
  parseComponentQABaselineStore,
  uncoveredFiniteVariantChoices,
} from './qa';

const component: ComponentDescriptor = {
  id: 'react:src/Card.tsx#Card',
  dialect: 'react',
  kind: 'component',
  name: 'Card',
  localName: 'Card',
  exportName: 'Card',
  description: null,
  definition: { file: 'src/Card.tsx', start: 0, end: 1, line: 4, column: 1, contentHash: 'hash' },
  props: [
    {
      name: 'tone',
      required: false,
      typeText: "'neutral' | 'accent'",
      defaultValue: null,
      choices: [
        { kind: 'string', value: 'neutral' },
        { kind: 'string', value: 'accent' },
      ],
      control: 'select',
      source: { file: 'src/Card.tsx', start: 1, end: 2, line: 5, column: 1, contentHash: 'hash' },
      diagnostics: [],
    },
  ],
  slots: [],
  variantProps: ['tone'],
  usageCount: 0,
  capabilities: {} as ComponentDescriptor['capabilities'],
  diagnostics: [],
};

describe('component QA model', () => {
  it('distinguishes missing, stale, unavailable and matching baselines', () => {
    const frame = createComponentCanvasFrame(component, 'revision-1');
    expect(
      compareComponentQABaseline(null, { frameIdentity: 'frame', sourceRevision: 'revision-1' })
        .state
    ).toBe('baseline-missing');
    const baseline = createComponentQABaseline(frame, '/tmp/card.png', 'revision-1', 'frame');
    expect(
      compareComponentQABaseline(baseline, {
        frameIdentity: 'changed',
        sourceRevision: 'revision-1',
      }).state
    ).toBe('stale');
    expect(
      compareComponentQABaseline(baseline, { frameIdentity: 'frame', sourceRevision: 'revision-1' })
        .state
    ).toBe('unavailable');
    expect(
      compareComponentQABaseline(baseline, {
        frameIdentity: 'frame',
        sourceRevision: 'revision-1',
        currentFingerprint: 'frame',
      }).state
    ).toBe('match');
  });

  it('refuses an oversized breakpoint/locale matrix', () => {
    const result = planComponentQAMatrix({
      breakpoints: Array.from({ length: COMPONENT_QA_MAX_MATRIX_CASES }, (_, index) =>
        String(index)
      ),
      locales: ['en', 'fr'],
    });
    expect(result.refused).toBe(true);
    expect(result.cases).toEqual([]);
  });

  it('reports uncovered finite choices without inventing requirements', () => {
    const frame = createComponentCanvasFrame(component, 'revision-1');
    frame.props = { tone: { kind: 'string', value: 'neutral' } };
    expect(uncoveredFiniteVariantChoices(component, [frame])).toEqual([
      { prop: 'tone', choice: { kind: 'string', value: 'accent' } },
    ]);
  });

  it('keeps sensitive QA material out of analytics metadata while preserving explicit agent context', () => {
    const frame = createComponentCanvasFrame(component, 'revision-1');
    frame.props = { tone: { kind: 'string', value: 'accent' } };
    const payload = buildComponentQAAgentPayload({
      component,
      frame,
      sourceRevision: 'revision-1',
      screenshotPath: '/private/card.png',
      diff: { state: 'changed', threshold: 0.1, message: 'Changed.' },
    });
    expect(payload.prompt).toContain('accent');
    expect(payload.prompt).toContain('/private/card.png');
    expect(payload.metadata).toEqual({
      dialect: 'react',
      hasScreenshot: true,
      hasA11yFindings: false,
      diffState: 'changed',
    });
    expect(JSON.stringify(payload.metadata)).not.toContain('/private/card.png');
  });

  it('drops malformed persisted baselines', () => {
    expect(
      parseComponentQABaselineStore({ version: 1, baselines: [{ frameId: 'x' }] }).baselines
    ).toEqual([]);
  });
});
