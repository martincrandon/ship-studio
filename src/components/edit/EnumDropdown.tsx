/**
 * Custom dropdown for the visual editor's enum controls.
 *
 * Replaces the native <select> (whose menu is an unstyleable OS widget). The
 * menu is portaled to <body> and positioned under the trigger so the panel's
 * own `overflow` can't clip it, matching the panel's dark theme.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { PropertyField } from '../primitives/PropertyField';
import { ChevronIcon } from '../icons';

interface Option {
  label: string;
  token: string;
}

interface Props {
  label: string;
  options: Option[];
  optionIcons?: Record<string, ReactNode>;
  /** Currently-active token, or null when none of the options is applied. */
  value: string | null;
  onChange: (token: string) => void;
}

export function EnumDropdown({ label, options, optionIcons, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = options.find((o) => o.token === value) ?? null;
  const currentIcon = current ? optionIcons?.[current.token] : undefined;

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  // Position the menu under the trigger when it opens, and keep it there.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  // Close on outside pointer (menu is portaled, so the trigger is a second
  // "inside" root) / Escape.
  useDismissOnOutsidePointer(open, menuRef, () => setOpen(false), {
    isOutside: (t) => !triggerRef.current?.contains(t) && !menuRef.current?.contains(t),
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <PropertyField
        ref={triggerRef}
        variant="select"
        className="ss-enum__trigger"
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ss-enum__current">
          {currentIcon && <span className="ss-enum__option-icon">{currentIcon}</span>}
          <span className={current ? '' : 'ss-edit-panel__muted'}>{current?.label ?? '—'}</span>
        </span>
        <ChevronIcon className="ss-enum__chevron" />
      </PropertyField>
      {open &&
        menuRect &&
        createPortal(
          <div
            ref={menuRef}
            className="ss-enum__menu"
            role="listbox"
            id={listId}
            style={{ top: menuRect.top, left: menuRect.left, minWidth: menuRect.width }}
          >
            {options.map((o) => (
              <button
                key={o.token}
                type="button"
                role="option"
                aria-selected={o.token === value}
                className={`ss-enum__item${o.token === value ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(o.token);
                  setOpen(false);
                }}
              >
                {optionIcons?.[o.token] && (
                  <span className="ss-enum__option-icon">{optionIcons[o.token]}</span>
                )}
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
