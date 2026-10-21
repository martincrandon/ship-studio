import { describe, expect, it } from 'vitest';
import type { CascadeRow } from './cssCascade';
import { orderCascadeRowsForDisplay } from './cascadePresentation';

function row(
  selector: string,
  index: number,
  sourceOrder?: number,
  line?: number,
  draft = false
): CascadeRow {
  return {
    index,
    selector,
    declarations: [],
    specificity: [0, 0, 0],
    sourceOrder,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    origin: 'author',
    editable: true,
    line,
    draft,
  };
}

describe('cascade presentation order', () => {
  it('places newest locally-created selectors at either display edge without mutating rows', () => {
    const oldestCreated = row('.created-first', 1_000_001, undefined, 0);
    const newestCreated = row('.created-last', 1_000_002, undefined, 0);
    const existing = row('.existing', 0, 4, 12);
    const draft = row('.draft', 1, undefined, 0, true);
    const original = [existing, oldestCreated, draft, newestCreated];

    expect(orderCascadeRowsForDisplay(original, 'newest-top')).toEqual([
      newestCreated,
      oldestCreated,
      existing,
      draft,
    ]);
    expect(orderCascadeRowsForDisplay(original, 'newest-bottom')).toEqual([
      draft,
      existing,
      oldestCreated,
      newestCreated,
    ]);
    expect(original).toEqual([existing, oldestCreated, draft, newestCreated]);
  });
});
