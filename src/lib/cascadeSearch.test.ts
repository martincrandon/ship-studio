import { describe, expect, it } from 'vitest';
import type { CascadeRow } from './cssCascade';
import { parseRuleBody } from './cssBody';
import { searchCascadeRow, searchRuleBody } from './cascadeSearch';

describe('cascade search', () => {
  it('matches declarations case-insensitively and retains original body indices', () => {
    const body = parseRuleBody(`
      display: grid;
      font-family: Inter, sans-serif;
      @media (prefers-reduced-motion: reduce) {
        animation: none !important;
      }
    `);

    const result = searchRuleBody(body, 'FoNt-FaMiLy');

    expect(result.declarationIndexes).toEqual(new Set([1]));
    expect(result.nestedRuleIndexes).toEqual(new Set());
    expect(result.hasMatch).toBe(true);
  });

  it('matches nested at-rules and important declarations', () => {
    const body = parseRuleBody(`
      display: grid;
      @media (prefers-reduced-motion: reduce) {
        animation: none !important;
      }
    `);

    const nestedMatch = searchRuleBody(body, 'PREFERS-REDUCED-MOTION');
    const importantMatch = searchRuleBody(body, 'important');

    expect(nestedMatch.nestedRuleIndexes).toEqual(new Set([1]));
    expect(nestedMatch.nestedResults.get(1)?.declarationIndexes).toEqual(new Set());
    expect(importantMatch.nestedRuleIndexes).toEqual(new Set([1]));
    expect(importantMatch.nestedResults.get(1)?.declarationIndexes).toEqual(new Set([0]));
  });

  it('matches selector and cascade declaration content', () => {
    const row: CascadeRow = {
      index: 0,
      selector: '.hero-title',
      declarations: [
        {
          prop: 'font-family',
          value: 'Inter',
          important: false,
          active: true,
        },
      ],
      specificity: [0, 1, 0],
      sourceOrder: 1,
      mediaText: null,
      mediaMinPx: null,
      inactiveMedia: false,
      layer: null,
      origin: 'author',
      editable: true,
    };

    expect(searchCascadeRow(row, undefined, 'HERO')).toEqual({
      matches: true,
      matchesAll: true,
    });
    expect(searchCascadeRow(row, undefined, 'inter')).toEqual({
      matches: true,
      matchesAll: false,
    });
  });
});
