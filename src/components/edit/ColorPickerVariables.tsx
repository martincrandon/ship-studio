import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { resolveColorVariable } from '../../lib/colorContrast';
import { toCss } from '../../lib/color';
import { SearchIcon } from '@/components/icons';
import { TextField } from '../primitives/TextField';

interface PickerVariable {
  name: string;
  value?: string;
}

interface Props {
  variables: readonly PickerVariable[];
  authoredValue?: string;
  onSelect: (name: string, resolvedColor: string | null) => void;
}

function selectedName(value: string | undefined): string | null {
  const match = value?.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/i);
  return match?.[1] ?? null;
}

export function ColorPickerVariables({ variables, authoredValue, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [activeSelection, setActiveSelection] = useState({ query: '', index: 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = selectedName(authoredValue);
  const activeIndex = activeSelection.query === query ? activeSelection.index : 0;
  const setActiveIndex = (index: number) => setActiveSelection({ query, index });

  const { selectedOption, options } = useMemo(() => {
    const seen = new Set<string>();
    const filter = query.trim().toLocaleLowerCase();
    const colorOptions = variables
      .filter((variable) => {
        if (!variable.name.startsWith('--') || seen.has(variable.name)) return false;
        seen.add(variable.name);
        return true;
      })
      .map((variable) => {
        const resolved = resolveColorVariable(`var(${variable.name})`, variables);
        return { ...variable, resolvedColor: resolved ? toCss(resolved) : null };
      })
      .filter((variable) => variable.resolvedColor || variable.name === selected);

    return {
      selectedOption: colorOptions.find((variable) => variable.name === selected) ?? null,
      options: colorOptions.filter(
        (variable) =>
          variable.name !== selected && variable.name.toLocaleLowerCase().includes(filter)
      ),
    };
  }, [query, selected, variables]);
  const optionCount = options.length + (selectedOption ? 1 : 0);
  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      searchRef.current?.focus({ preventScroll: true });
      return;
    }
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % optionCount;
    else if (event.key === 'ArrowUp') next = (index - 1 + optionCount) % optionCount;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = optionCount - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    optionRefs.current[next]?.focus({ preventScroll: true });
  };
  const renderOption = (variable: (typeof options)[number], index: number) => (
    <button
      key={variable.name}
      ref={(element) => {
        optionRefs.current[index] = element;
      }}
      type="button"
      role="option"
      aria-selected={selected === variable.name}
      aria-label={`${variable.name}${variable.resolvedColor ? '' : ', preview unavailable'}`}
      className="ss-color-picker__variable-option"
      tabIndex={activeIndex === index ? 0 : -1}
      onFocus={() => setActiveIndex(index)}
      onKeyDown={(event) => handleOptionKeyDown(event, index)}
      onClick={() => onSelect(variable.name, variable.resolvedColor)}
    >
      {variable.resolvedColor ? (
        <span
          className="ss-color-picker__variable-swatch ss-color-picker__swatch"
          style={{ '--picker-swatch-color': variable.resolvedColor } as CSSProperties}
          aria-hidden="true"
        />
      ) : (
        <span
          className="ss-color-picker__variable-swatch ss-color-picker__variable-swatch--unknown"
          aria-hidden="true"
        />
      )}
      <span className="ss-color-picker__variable-name">{variable.name}</span>
      {!variable.resolvedColor && (
        <span className="ss-color-picker__variable-unavailable">Preview unavailable</span>
      )}
    </button>
  );

  return (
    <section className="ss-color-picker__variables" aria-label="Project color variables">
      <label className="ss-color-picker__variable-search">
        <SearchIcon size={14} />
        <TextField
          ref={searchRef}
          aria-label="Search color variables"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search variables"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' || optionCount === 0) return;
            event.preventDefault();
            setActiveIndex(0);
            optionRefs.current[0]?.focus({ preventScroll: true });
          }}
        />
      </label>

      {selectedOption || options.length > 0 ? (
        <div className="ss-color-picker__variable-list" role="listbox" aria-label="Color variables">
          {selectedOption && renderOption(selectedOption, 0)}
          {selectedOption && (
            <div className="ss-color-picker__variable-divider" aria-hidden="true" />
          )}
          {options.map((variable, index) =>
            renderOption(variable, index + (selectedOption ? 1 : 0))
          )}
        </div>
      ) : (
        <p className="ss-color-picker__variables-empty" role="status">
          {query.trim()
            ? 'No color variables match this search.'
            : 'No project color variables are available.'}
        </p>
      )}
    </section>
  );
}
