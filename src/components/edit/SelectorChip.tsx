import { useId, useState } from 'react';
import { WRAP_ITEMS, searchStructures } from '../../lib/cssStructures';
import { CascadeChip } from './CascadeChip';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';

/** A top-level rule's selector as ONE intelligent field — just like writing real
 *  CSS. Type a selector (class names autocomplete from the project) to rename the
 *  rule; type `@…` and it suggests conditions (`@media`, `@container`, `@supports`)
 *  and wraps the rule to scope it. No separate "when" box — one field does both. */
export function SelectorChip({
  selector,
  suggestions,
  onCommit,
  onWrap,
}: {
  selector: string;
  suggestions: string[];
  onCommit: (newSelector: string) => void;
  /** Wrap the rule in a condition when the user types an `@`-rule. */
  onWrap?: (prelude: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(selector);
  const [active, setActive] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listId = useId();

  if (!editing) {
    return (
      <CascadeChip
        tone="selector"
        interactive
        title="Click to edit — type a selector, or @media (…) to scope this rule"
        role="button"
        tabIndex={0}
        onClick={() => {
          setText(selector);
          setActive(0);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setText(selector);
            setActive(0);
            setEditing(true);
          }
        }}
      >
        <span className="ss-cascade-chip__content">{selector}</span>
      </CascadeChip>
    );
  }

  const typed = text.trim();
  const isCondition = typed.startsWith('@');
  // Typing `@…` switches the field into condition mode (wrap the rule); otherwise
  // it autocompletes the project's class names (rename the rule).
  const matches: Suggestion[] = isCondition
    ? [
        ...(typed.length > 1 && !WRAP_ITEMS.some((w) => w.insert === typed)
          ? [{ label: typed, value: typed, hint: 'new condition' }]
          : []),
        ...searchStructures(WRAP_ITEMS, typed).map((w) => ({
          label: w.label,
          value: w.insert,
          hint: w.hint,
        })),
      ]
    : (typed
        ? suggestions.filter((s) => s.toLowerCase().includes(typed.toLowerCase()))
        : suggestions
      )
        .slice(0, 8)
        .map((s) => ({ label: s, value: s }));

  const commit = (value: string) => {
    const v = value.trim();
    if (!v) {
      setEditing(false);
      return;
    }
    if (v.startsWith('@'))
      onWrap?.(v); // scope the rule in a condition
    else if (v !== selector) onCommit(v); // rename the selector
    setEditing(false);
  };

  return (
    <CascadeChip tone="selector" editing className="ss-cascade-card__selector-edit">
      <input
        className="ss-cascade-chip__input"
        autoFocus
        value={text}
        size={Math.max(text.length, 1)}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={matches.length > 0 ? suggestionOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        aria-label="Rule selector"
        placeholder="selector, or @media (…) to scope it"
        onFocus={(e) => setAnchorEl(e.currentTarget)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(matches[active]?.value ?? text);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setText(selector);
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
      />
      <SuggestionPopover
        anchor={anchorEl}
        items={matches}
        active={active}
        onPick={commit}
        listId={listId}
      />
    </CascadeChip>
  );
}
