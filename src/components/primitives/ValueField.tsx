import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CheckIcon } from '@/components/icons';

export type ValueFieldVariant = 'number' | 'length' | 'angle' | 'time';

export interface ValueFieldOption {
  /** Unit suffix (`px`) or complete keyword value (`auto`). */
  value: string;
  label: string;
  kind?: 'unit' | 'keyword';
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
};

interface SplitValue {
  text: string;
  unit: string;
}

const NUMERIC_VALUE = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/i;

/** Splits a simple number+unit while leaving keywords and CSS functions editable intact. */
export function splitValueFieldValue(value: string, options: ValueFieldOption[]): SplitValue {
  const trimmed = value.trim();
  const match = NUMERIC_VALUE.exec(trimmed);
  if (!match || !match[2]) return { text: trimmed, unit: '' };

  const unit = options.find(
    (option) => option.kind !== 'keyword' && option.value.toLowerCase() === match[2].toLowerCase()
  )?.value;
  return unit ? { text: match[1], unit } : { text: trimmed, unit: '' };
}

export interface ValueFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur'
> {
  value: string;
  variant?: ValueFieldVariant;
  /** Property-specific keywords such as `auto` or `none`. */
  keywords?: ValueFieldOption[];
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
  onCommit,
  className,
  onKeyDown,
  'aria-label': ariaLabel,
  ...inputProps
}: ValueFieldProps) {
  const options = [...OPTIONS_BY_VARIANT[variant], ...keywords];
  const initial = splitValueFieldValue(value, options);
  const [text, setText] = useState(initial.text);
  const [unit, setUnit] = useState(initial.unit);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuRect, setMenuRect] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const next = splitValueFieldValue(value, options);
    setText(next.text);
    setUnit(next.unit);
    setInvalid(false);
    // The options are intentionally derived from stable primitive presets and
    // caller-owned keyword literals; the controlled value is the sync signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, variant]);

  const reposition = () => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    setMenuRect({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useDismissOnOutsidePointer(open, menuRef, () => setOpen(false), {
    isOutside: (target) => !rootRef.current?.contains(target) && !menuRef.current?.contains(target),
  });

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

  const combinedValue = (nextText = text, nextUnit = unit) => `${nextText.trim()}${nextUnit}`;

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
    if (option.kind === 'keyword') {
      setText(option.value);
      setUnit('');
      commit(option.value, '');
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
  const selectedValue = currentKeyword?.value ?? unit;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selectedValue)
  );
  const selectedLabel = options.find(
    (option) => option.kind !== 'keyword' && option.value === unit
  )?.label;

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
        open ? 'value-field--open' : null,
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
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (splitValueFieldValue(next, options).unit || /[a-z%)]$/i.test(next.trim()))
            setUnit('');
          if (invalid) setInvalid(false);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => {
          if (
            rootRef.current?.contains(event.relatedTarget) ||
            menuRef.current?.contains(event.relatedTarget)
          )
            return;
          commit();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
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
          // Keep focus in the input. In WebKit, moving focus to this segment can
          // report a null relatedTarget to the input blur handler, which commits
          // the unchanged value and refreshes the editor before this click opens.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (open) setOpen(false);
          else {
            setActiveIndex(selectedIndex);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (open || !['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          setActiveIndex(selectedIndex);
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
    </span>
  );
}
