import { declarations, nestedRules, type RuleBody } from './cssBody';
import type { CascadeRow } from './cssCascade';

export interface RuleBodySearchResult {
  /** Original `RuleBody.items` indices for matching declarations. */
  declarationIndexes: Set<number>;
  /** Original `RuleBody.items` indices for matching nested rules. */
  nestedRuleIndexes: Set<number>;
  nestedResults: Map<number, RuleBodySearchResult>;
  hasMatch: boolean;
}

export interface CascadeRowSearchResult {
  matches: boolean;
  /** A selector or enclosing at-rule matched, so every property belongs in the result. */
  matchesAll: boolean;
}

function includesQuery(value: string | null | undefined, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

/** Find declaration and nested-rule matches without changing the source body or its indices. */
export function searchRuleBody(body: RuleBody, query: string): RuleBodySearchResult {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const declarationIndexes = new Set<number>();
  const nestedRuleIndexes = new Set<number>();
  const nestedResults = new Map<number, RuleBodySearchResult>();

  if (!normalizedQuery) {
    return { declarationIndexes, nestedRuleIndexes, nestedResults, hasMatch: true };
  }

  for (const declaration of declarations(body)) {
    if (
      includesQuery(declaration.prop, normalizedQuery) ||
      includesQuery(declaration.value, normalizedQuery) ||
      (declaration.important && includesQuery('!important', normalizedQuery))
    ) {
      declarationIndexes.add(declaration.index);
    }
  }

  for (const nested of nestedRules(body)) {
    const nestedResult = searchRuleBody(nested.body, normalizedQuery);
    nestedResults.set(nested.index, nestedResult);
    if (includesQuery(nested.selector, normalizedQuery) || nestedResult.hasMatch) {
      nestedRuleIndexes.add(nested.index);
    }
  }

  return {
    declarationIndexes,
    nestedRuleIndexes,
    nestedResults,
    hasMatch: declarationIndexes.size > 0 || nestedRuleIndexes.size > 0,
  };
}

/** Match the selector, enclosing conditions, and declarations reported by the cascade. */
export function searchCascadeRow(
  row: CascadeRow,
  body: RuleBody | undefined,
  query: string
): CascadeRowSearchResult {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return { matches: true, matchesAll: false };

  const matchesAll = [row.selector, row.mediaText, row.layer, row.container, row.supports].some(
    (value) => includesQuery(value, normalizedQuery)
  );
  if (matchesAll) return { matches: true, matchesAll: true };

  const cascadeDeclarationMatch = row.declarations.some(
    (decl) =>
      includesQuery(decl.prop, normalizedQuery) ||
      includesQuery(decl.value, normalizedQuery) ||
      (decl.important && includesQuery('!important', normalizedQuery))
  );
  const bodyMatch = body ? searchRuleBody(body, normalizedQuery).hasMatch : false;

  return { matches: cascadeDeclarationMatch || bodyMatch, matchesAll: false };
}
