import { nestedRules, type RuleBody } from './cssBody';
import type { CascadeRow } from './cssCascade';

export type CascadeDisplayOrder = 'newest-top' | 'newest-bottom';

/** App-global localStorage key for the CSS cascade's presentation-only order. */
export const CASCADE_DISPLAY_ORDER_PREFERENCE_KEY = 'cssCascadeNewestBottom';

/** Put locally-created rules first by creation index, then optionally reverse the view. */
export function orderCascadeRowsForDisplay(
  rows: readonly CascadeRow[],
  order: CascadeDisplayOrder
): CascadeRow[] {
  const created: CascadeRow[] = [];
  const cascade: CascadeRow[] = [];

  for (const row of rows) {
    // The editor assigns line 0 and a monotonically increasing synthetic index to a
    // rule created from Add selector. Empty element-selector drafts use the same line
    // convention, but aren't user-created rules and remain in cascade position.
    if (row.editable && !row.draft && row.line === 0 && row.sourceOrder == null) {
      created.push(row);
    } else {
      cascade.push(row);
    }
  }

  created.sort((a, b) => b.index - a.index);
  const newestFirst = [...created, ...cascade];
  return order === 'newest-top' ? newestFirst : newestFirst.reverse();
}

export function cascadeRuleCollapseKey(selector: string, context = ''): string {
  return `${selector}|${context}`;
}

export function cascadeMediaCollapseKey(key: string): string {
  return `media:${key}`;
}

/** Stable path for a nested card, independent of declaration indices. */
export function nestedRuleCollapseKey(
  parentKey: string,
  selector: string,
  occurrence: number
): string {
  return `${parentKey}::nested:${selector}#${occurrence}`;
}

/** Collect nested card identities using the same keys as `CascadeRuleCard`. */
export function collectNestedCollapseKeys(body: RuleBody, parentKey: string): Set<string> {
  const keys = new Set<string>();
  const visit = (current: RuleBody, parent: string) => {
    const occurrences = new Map<string, number>();
    for (const nested of nestedRules(current)) {
      const occurrence = occurrences.get(nested.selector) ?? 0;
      occurrences.set(nested.selector, occurrence + 1);
      const key = nestedRuleCollapseKey(parent, nested.selector, occurrence);
      keys.add(key);
      visit(nested.body, key);
    }
  };
  visit(body, parentKey);
  return keys;
}
