import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CheckIcon } from '@/components/icons';

export type ValueFieldVariant = 'number' | 'length' | 'angle' | 'time' | 'color';

/** Describes a unit or enumerated option accepted by a value field. */
export interface ValueFieldOption {
  /** Unit suffix (`px`) or complete keyword value (`auto`). */
  value: string;
  label: string;
  kind?: 'unit' | 'keyword' | 'format' | 'variable';
}

/** A project CSS custom property offered by the variable picker. */
export interface ValueFieldVariable {
  /** Custom-property name including the leading `--`. */
  name: string;
  /** Current resolved/source value, shown as supporting context in the picker. */
  value?: string;
}

const OPTIONS_BY_VARIANT: Record<ValueFieldVariant, ValueFieldOption[]> = {
  number: [{ value: '', label: '-' }],
  length: [
    { value: '', label: '-' },
    { value: 'px', label: 'PX' },
    { value: '%', label: '%' },
    { value: 'em', label: 'EM' },
    { value: 'rem', label: 'REM' },
    { value: 'ch', label: 'CH' },
    { value: 'vw', label: 'VW' },
    { value: 'vh', label: 'VH' },
    { value: 'svw', label: 'SVW' },
    { value: 'svh', label: 'SVH' },
  ],
  angle: [
    { value: '', label: '-' },
    { value: 'deg', label: 'DEG' },
    { value: 'rad', label: 'RAD' },
    { value: 'turn', label: 'TURN' },
  ],
  time: [
    { value: '', label: '-' },
    { value: 'ms', label: 'MS' },
    { value: 's', label: 'S' },
  ],
  color: [
    { value: 'hex', label: 'HEX', kind: 'format' },
    { value: 'rgb', label: 'RGB', kind: 'format' },
    { value: 'hsl', label: 'HSL', kind: 'format' },
    { value: 'hsb', label: 'HSB', kind: 'format' },
    { value: 'oklch', label: 'OKLCH', kind: 'format' },
  ],
};

interface SplitValue {
  text: string;
  unit: string;
}

const NUMERIC_VALUE = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/i;
const CSS_VARIABLE_VALUE = /^var\(\s*(--[\w-]+)\s*\)$/i;
const VARIABLE_OPTION: ValueFieldOption = { value: 'var', label: 'VAR', kind: 'variable' };
const EMPTY_VARIABLES: ValueFieldVariable[] = [];

/** Returns the raw custom-property name from a simple `var(--name)` value. */
export function parseValueFieldVariable(value: string): string | null {
  return CSS_VARIABLE_VALUE.exec(value.trim())?.[1] ?? null;
}

/** Splits a simple number+unit while leaving keywords and CSS functions editable intact. */
export function splitValueFieldValue(value: string, options: ValueFieldOption[]): SplitValue {
  const trimmed = value.trim();
  const variable = parseValueFieldVariable(trimmed);
  if (variable) return { text: variable, unit: 'var' };
  const match = NUMERIC_VALUE.exec(trimmed);
  if (!match || !match[2]) return { text: trimmed, unit: '' };

  const unit = options.find(
    (option) => option.kind !== 'keyword' && option.value.toLowerCase() === match[2].toLowerCase()
  )?.value;
  return unit ? { text: match[1], unit } : { text: trimmed, unit: '' };
}

/** Props for an editable numeric or unit-bearing design value. */
export interface ValueFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur'
> {
  value: string;
  variant?: ValueFieldVariant;
  /** Property-specific keywords such as `auto` or `none`. */
  keywords?: ValueFieldOption[];
  /** Project CSS custom properties available to this value. */
  variables?: ValueFieldVariable[];
  /** Selected representation for a color field. */
  format?: string;
  /** Reformat the current color when a color representation is selected. */
  onFormatChange?: (format: string) => void;
  /** Return false to reject the value and restore the last controlled value. */
  onCommit: (value: string) => boolean | void;
}

/**
 * Editable property value with an integrated format picker. Users may type a
 * complete value (`12px`) and commit it, or edit the number and choose its unit
 * independently. Keywords remain in the text side with the neutral unit marker.
 */
export function ValueField({
  value,
  variant = 'number',
  keywords = [],
  variables = EMPTY_VARIABLES,
  format,
  onFormatChange,
  onCommit,
  className,
  onKeyDown,
  'aria-label': ariaLabel,
  ...inputProps
}: ValueFieldProps) {
  const variableValue = parseValueFieldVariable(value);
  const availableVariables = useMemo(() => {
    const seen = new Set<string>();
    return variables.filter((variable) => {
      if (!variable.name.startsWith('--') || seen.has(variable.name)) return false;
      seen.add(variable.name);
      return true;
    });
  }, [variables]);
  const options = [
    ...OPTIONS_BY_VARIANT[variant],
    ...(availableVariables.length > 0 || variableValue ? [VARIABLE_OPTION] : []),
    ...keywords,
  ];
  const isFormatField = variant === 'color';
  const initial = splitValueFieldValue(value, options);
  const [text, setText] = useState(initial.text);
  const [unit, setUnit] = useState(initial.unit);
  const [selectedFormat, setSelectedFormat] = useState(
    format ?? options.find((option) => option.kind === 'format')?.value ?? ''
  );
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [variableOpen, setVariableOpen] = useState(false);
  const [variableQuery, setVariableQuery] = useState('');
  const [activeVariableIndex, setActiveVariableIndex] = useState(0);
  const [menuRect, setMenuRect] = useState<{
    top: number;
    right: number;
    variableLeft: number;
    variableWidth: number;
  } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const variableMenuRef = useRef<HTMLDivElement>(null);
  const pointerToggleRef = useRef(false);
  const keyboardToggleRef = useRef(false);
  const listId = useId();
  const variableListId = useId();

  const filteredVariables = useMemo(() => {
    const query = variableQuery.trim().toLowerCase();
    return availableVariables.filter((variable) => variable.name.toLowerCase().includes(query));
  }, [availableVariables, variableQuery]);

  useEffect(() => {
    const next = splitValueFieldValue(value, options);
    setText(next.text);
    setUnit(next.unit);
    if (format !== undefined) setSelectedFormat(format);
    setInvalid(false);
    // The options are intentionally derived from stable primitive presets and
    // caller-owned keyword literals; the controlled value is the sync signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, variant, format]);

  const reposition = () => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const boundary = root.closest<HTMLElement>('[data-value-field-menu-boundary]');
    const boundaryRect = boundary?.getBoundingClientRect();
    const boundaryStyle = boundary ? window.getComputedStyle(boundary) : null;
    const paddingLeft = Number.parseFloat(boundaryStyle?.paddingLeft ?? '0') || 0;
    const paddingRight = Number.parseFloat(boundaryStyle?.paddingRight ?? '0') || 0;
    const variableLeft = boundaryRect ? boundaryRect.left + paddingLeft : rect.left;
    const variableRight = boundaryRect ? boundaryRect.right - paddingRight : rect.right;
    setMenuRect({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      variableLeft,
      variableWidth: Math.max(0, variableRight - variableLeft),
    });
  };

  useLayoutEffect(() => {
    if (!open && !variableOpen) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, variableOpen]);

  useDismissOnOutsidePointer(
    open || variableOpen,
    menuRef,
    () => {
      setOpen(false);
      setVariableOpen(false);
    },
    {
      isOutside: (target) =>
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target) &&
        !variableMenuRef.current?.contains(target),
    }
  );

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  const combinedValue = (nextText = text, nextUnit = unit) => {
    const trimmed = nextText.trim();
    if (nextUnit === 'var') return `var(${trimmed})`;
    return isFormatField ? trimmed : `${trimmed}${nextUnit}`;
  };

  const commit = (nextText = text, nextUnit = unit) => {
    const nextValue = combinedValue(nextText, nextUnit);
    if (!nextValue) return true;
    if (onCommit(nextValue) === false) {
      const restored = splitValueFieldValue(value, options);
      setText(restored.text);
      setUnit(restored.unit);
      setInvalid(true);
      return false;
    }
    const normalized = splitValueFieldValue(nextValue, options);
    setText(normalized.text);
    setUnit(normalized.unit);
    setInvalid(false);
    return true;
  };

  const selectOption = (option: ValueFieldOption) => {
    setOpen(false);
    if (option.kind === 'variable') {
      const nextText = unit === 'var' ? text : '--';
      setText(nextText);
      setUnit('var');
      setVariableQuery('');
      setActiveVariableIndex(0);
      setVariableOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (option.kind === 'format') {
      setSelectedFormat(option.value);
      if (unit === 'var') {
        setText('');
        setUnit('');
        inputRef.current?.focus();
        return;
      }
      onFormatChange?.(option.value);
      inputRef.current?.focus();
      return;
    }
    if (option.kind === 'keyword') {
      setText(option.value);
      setUnit('');
      commit(option.value, '');
      inputRef.current?.focus();
      return;
    }

    if (unit === 'var') {
      setText('');
      setUnit(option.value);
      inputRef.current?.focus();
      return;
    }

    const typed = splitValueFieldValue(text, options).text;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(typed)) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    setText(typed);
    setUnit(option.value);
    commit(typed, option.value);
    inputRef.current?.focus();
  };

  const selectVariable = (variable: ValueFieldVariable) => {
    setText(variable.name);
    setUnit('var');
    setVariableOpen(false);
    setVariableQuery('');
    commit(variable.name, 'var');
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const stepNumericValue = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+))$/.exec(text.trim());
    if (!match) return false;
    const baseStep = unit ? 0.1 : 1;
    const amount = event.shiftKey ? 10 : event.altKey ? baseStep : 1;
    const direction = event.key === 'ArrowUp' ? 1 : -1;
    const next = String(Math.round((Number(match[1]) + direction * amount) * 100) / 100);
    event.preventDefault();
    setText(next);
    commit(next, unit);
    return true;
  };

  const currentKeyword = keywords.find(
    (option) => option.value.toLowerCase() === text.trim().toLowerCase() && unit === ''
  );
  const selectedValue =
    unit === 'var' ? 'var' : isFormatField ? selectedFormat : (currentKeyword?.value ?? unit);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selectedValue)
  );
  const selectedLabel = options.find((option) => option.value === selectedValue)?.label;

  useLayoutEffect(() => {
    if (!open || !menuRect || !menuRef.current) return;
    const optionElements = Array.from(
      menuRef.current.querySelectorAll<HTMLElement>('[role="option"]')
    );
    const option = optionElements[Math.min(activeIndex, optionElements.length - 1)];
    option?.focus({ preventScroll: true });
  }, [activeIndex, menuRect, open]);

  const handleFormatKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % options.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + options.length) % options.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = options[activeIndex];
      if (!option) return;
      event.preventDefault();
      selectOption(option);
    }
  };

  return (
    <span
      ref={rootRef}
      className={[
        'value-field',
        invalid ? 'value-field--invalid' : null,
        open || variableOpen ? 'value-field--open' : null,
        unit === 'var' ? 'value-field--variable' : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <input
        {...inputProps}
        ref={inputRef}
        className="value-field__input"
        value={text}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        role={availableVariables.length > 0 ? 'combobox' : undefined}
        aria-autocomplete={availableVariables.length > 0 ? 'list' : undefined}
        aria-expanded={availableVariables.length > 0 ? variableOpen : undefined}
        aria-controls={variableOpen ? variableListId : undefined}
        aria-activedescendant={
          variableOpen && filteredVariables[activeVariableIndex]
            ? `${variableListId}-option-${activeVariableIndex}`
            : undefined
        }
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          const isVariableInput = next.trimStart().startsWith('--');
          setText(next);
          if (isVariableInput) {
            setUnit('var');
            if (availableVariables.length > 0) {
              setVariableQuery(next);
              setActiveVariableIndex(0);
              setVariableOpen(true);
              setOpen(false);
            }
          } else if (unit === 'var') {
            setUnit('');
            setVariableOpen(false);
            setVariableQuery('');
          }
          if (
            !isVariableInput &&
            !isFormatField &&
            (splitValueFieldValue(next, options).unit || /[a-z%)]$/i.test(next.trim()))
          )
            setUnit('');
          if (invalid) setInvalid(false);
        }}
        onFocus={(event) => {
          event.currentTarget.select();
          if (unit === 'var' && availableVariables.length > 0) {
            setVariableQuery('');
            setActiveVariableIndex(
              Math.max(
                0,
                availableVariables.findIndex((variable) => variable.name === text)
              )
            );
            setVariableOpen(true);
            setOpen(false);
          }
        }}
        onBlur={(event) => {
          if (
            rootRef.current?.contains(event.relatedTarget) ||
            menuRef.current?.contains(event.relatedTarget) ||
            variableMenuRef.current?.contains(event.relatedTarget)
          )
            return;
          setVariableOpen(false);
          setVariableQuery('');
          commit();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (variableOpen) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveVariableIndex((current) =>
                filteredVariables.length ? (current + 1) % filteredVariables.length : 0
              );
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveVariableIndex((current) =>
                filteredVariables.length
                  ? (current - 1 + filteredVariables.length) % filteredVariables.length
                  : 0
              );
              return;
            }
            if (event.key === 'Enter' && filteredVariables[activeVariableIndex]) {
              event.preventDefault();
              selectVariable(filteredVariables[activeVariableIndex]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setVariableOpen(false);
              setVariableQuery('');
              return;
            }
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            const restored = splitValueFieldValue(value, options);
            setText(restored.text);
            setUnit(restored.unit);
            setInvalid(false);
            event.currentTarget.select();
          } else {
            stepNumericValue(event);
          }
        }}
      />
      <button
        ref={triggerRef}
        type="button"
        className="value-field__unit"
        aria-label={`${ariaLabel ?? 'Value'} format`}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        onPointerDown={(event) => {
          // Toggle on pointerdown so the opening gesture is complete before the
          // outside-dismiss listener can be attached. Keep focus in the input;
          // moving focus to this segment can make WebKit commit the value and
          // refresh the editor before the menu opens.
          event.preventDefault();
          event.stopPropagation();
          pointerToggleRef.current = true;
          keyboardToggleRef.current = false;
          setVariableOpen(false);
          setOpen((current) => !current);
        }}
        onClick={(event) => {
          event.stopPropagation();
          // Pointerdown already toggles the menu. Ignore its later click even
          // when the browser reports a zero click detail or dispatches it late.
          if (pointerToggleRef.current) {
            pointerToggleRef.current = false;
            return;
          }
          // Enter/Space opens from onKeyDown; ignore that keyboard-generated
          // click so keyboard activation does not toggle twice.
          if (keyboardToggleRef.current) {
            keyboardToggleRef.current = false;
            return;
          }
          setActiveIndex(selectedIndex);
          setVariableOpen(false);
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (open || !['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          keyboardToggleRef.current = true;
          setActiveIndex(selectedIndex);
          setVariableOpen(false);
          setOpen(true);
        }}
      >
        {selectedLabel ?? '-'}
      </button>
      {open &&
        menuRect &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="value-field__menu"
            role="listbox"
            aria-label={`${ariaLabel ?? 'Value'} formats`}
            style={{ top: menuRect.top, right: menuRect.right }}
            tabIndex={-1}
            onKeyDown={handleFormatKeyDown}
          >
            {options.map((option, index) => {
              const selected = option.value === selectedValue;
              return (
                <button
                  key={`${option.kind ?? 'unit'}:${option.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  className={`value-field__option${selected ? ' value-field__option--selected' : ''}`}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => selectOption(option)}
                >
                  <span className="value-field__check" aria-hidden>
                    {selected && <CheckIcon size={14} />}
                  </span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>,
          document.body
        )}
      {variableOpen &&
        menuRect &&
        createPortal(
          <div
            ref={variableMenuRef}
            id={variableListId}
            className="value-field__menu value-field__variable-menu"
            role="listbox"
            aria-label={`${ariaLabel ?? 'Value'} variables`}
            style={{
              top: menuRect.top,
              left: menuRect.variableLeft,
              width: menuRect.variableWidth,
            }}
          >
            {filteredVariables.length > 0 ? (
              filteredVariables.map((variable, index) => {
                const selected = variable.name === text;
                const active = index === activeVariableIndex;
                return (
                  <button
                    key={variable.name}
                    id={`${variableListId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={[
                      'value-field__option',
                      'value-field__variable-option',
                      selected ? 'value-field__option--selected' : null,
                      active ? 'value-field__option--active' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveVariableIndex(index)}
                    onClick={() => selectVariable(variable)}
                  >
                    <span className="value-field__check" aria-hidden>
                      {selected && <CheckIcon size={14} />}
                    </span>
                    <span className="value-field__variable-name">{variable.name}</span>
                    {variable.value && (
                      <span className="value-field__variable-value">{variable.value}</span>
                    )}
                  </button>
                );
              })
            ) : (
              <span className="value-field__variable-empty">No matching variables</span>
            )}
          </div>,
          document.body
        )}
    </span>
  );
}
