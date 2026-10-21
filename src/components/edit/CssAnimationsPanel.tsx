/**
 * Animations editor — the project's `@keyframes` rules. Each renders as a keyframes
 * card (steps as nested cards, properties inside each step), reusing the cascade card.
 * From an element you wire one up with `animation: <name>`. Project-scoped, not tied to
 * the selected element.
 */

import { useState } from 'react';
import { PlusIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import { CascadeRuleCard } from './CascadeRuleCard';
import { cascadeRuleCollapseKey, type CascadeDisplayOrder } from '../../lib/cascadePresentation';
import { searchRuleBody } from '../../lib/cascadeSearch';
import type { RuleBody } from '../../lib/cssBody';
import type { AnimationRow } from '../../hooks/useCssAnimations';

interface Props {
  animations: AnimationRow[];
  loading: boolean;
  selectorSuggestions: string[];
  variables: string[];
  onChangeBody: (selector: string, body: RuleBody) => void;
  onDelete: (selector: string) => void;
  onCreate: (name: string) => void;
  onRename: (selector: string, newName: string) => void;
  searchTerm: string;
  displayOrder: CascadeDisplayOrder;
  collapseControl: {
    collapsedKeys: ReadonlySet<string>;
    searchCollapsedOverrides: ReadonlyMap<string, boolean>;
    toggle: (key: string) => void;
    toggleSearch: (key: string, collapsed: boolean) => void;
  };
  onClearSearch: () => void;
}

export function CssAnimationsPanel({
  animations,
  loading,
  selectorSuggestions,
  variables,
  onChangeBody,
  onDelete,
  onCreate,
  onRename,
  searchTerm,
  displayOrder,
  collapseControl,
  onClearSearch,
}: Props) {
  if (loading && animations.length === 0) {
    return (
      <div className="ss-cascade-loading">
        <Spinner size="sm" />
      </div>
    );
  }

  const query = searchTerm.trim();
  const normalizedQuery = query.toLocaleLowerCase();
  const searchActive = normalizedQuery.length > 0;
  const orderedAnimations = displayOrder === 'newest-top' ? [...animations].reverse() : animations;
  const visibleAnimations = orderedAnimations.filter(
    (animation) =>
      !searchActive ||
      animation.name.toLocaleLowerCase().includes(normalizedQuery) ||
      animation.selector.toLocaleLowerCase().includes(normalizedQuery) ||
      searchRuleBody(animation.body, normalizedQuery).hasMatch
  );
  const addAnimation = (
    <AddAnimation
      existing={new Set(animations.map((animation) => animation.name))}
      onCreate={onCreate}
    />
  );

  return (
    <div className="ss-anims">
      <div className="ss-cascade-cards">
        {displayOrder === 'newest-top' && addAnimation}
        {animations.length === 0 && !searchActive && (
          <p className="ss-cascade-empty">
            No animations yet. Create one, then reference it from an element with{' '}
            <code>animation</code>.
          </p>
        )}
        {visibleAnimations.map((animation) => {
          const collapseKey = cascadeRuleCollapseKey(animation.selector);
          const matchesSearch =
            searchActive &&
            (animation.name.toLocaleLowerCase().includes(normalizedQuery) ||
              animation.selector.toLocaleLowerCase().includes(normalizedQuery) ||
              searchRuleBody(animation.body, normalizedQuery).hasMatch);
          const searchCollapseOverride = matchesSearch
            ? collapseControl.searchCollapsedOverrides.get(collapseKey)
            : undefined;
          const collapsed = matchesSearch
            ? (searchCollapseOverride ?? false)
            : collapseControl.collapsedKeys.has(collapseKey);

          return (
            <CascadeRuleCard
              key={animation.selector}
              editable
              selector={animation.selector}
              file={animation.file}
              overridden={EMPTY}
              body={animation.body}
              variables={variables}
              selectorSuggestions={selectorSuggestions}
              searchTerm={query}
              searchCollapseOverride={searchCollapseOverride}
              collapseKey={collapseKey}
              collapseControl={collapseControl}
              collapsed={collapsed}
              onToggleCollapse={() => {
                if (matchesSearch) {
                  collapseControl.toggleSearch(collapseKey, !collapsed);
                } else {
                  collapseControl.toggle(collapseKey);
                }
              }}
              onChange={(body) => onChangeBody(animation.selector, body)}
              onDelete={() => onDelete(animation.selector)}
              onRenameKeyframes={(newName) => onRename(animation.selector, newName)}
            />
          );
        })}
        {searchActive && visibleAnimations.length === 0 && (
          <p className="ss-cascade-empty" role="status">
            No CSS animations match “{query}”.{' '}
            <TextButton onClick={onClearSearch}>Clear search</TextButton>
          </p>
        )}
        {displayOrder === 'newest-bottom' && addAnimation}
      </div>
    </div>
  );
}

const EMPTY = new Map<string, string>();

/** "+ New animation": expands to a name input that creates `@keyframes <name>`. */
function AddAnimation({
  existing,
  onCreate,
}: {
  existing: Set<string>;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const submit = () => {
    const n = name.trim().replace(/^@(-[a-z]+-)?keyframes\s+/i, '');
    if (n && !existing.has(n)) onCreate(n);
    setName('');
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="ss-cascade-action">
        <Button
          variant="default"
          width="fill"
          leftIcon={<PlusIcon size={11} />}
          onClick={() => setOpen(true)}
        >
          New animation
        </Button>
      </div>
    );
  }

  return (
    <div className="ss-anims__add">
      <span className="ss-anims__add-at">@keyframes</span>
      <input
        className="ss-var-input"
        autoFocus
        value={name}
        spellCheck={false}
        autoComplete="off"
        placeholder="name (e.g. reveal)"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={submit}
      />
    </div>
  );
}
