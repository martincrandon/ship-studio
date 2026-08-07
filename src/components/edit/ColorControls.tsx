/**
 * Text + background color controls. Each is a swatch that opens a popover with
 * the full ColorPicker (HEX/RGB/HSL/HSB/OKLCH). The picked colour is written
 * back as an arbitrary Tailwind value in the format selected in the picker and
 * previewed live via inline color/background-color.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import {
  arbitraryColorRaw,
  colorClassToken,
  colorResetSpec,
  readLayer,
  type ColorPrefix,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import {
  COLOR_PICKER_GUTTER,
  COLOR_PICKER_HEIGHT,
  COLOR_PICKER_POSITION_KEY,
  COLOR_PICKER_SIZE_KEY,
  COLOR_PICKER_WIDTH,
  rgbaToCss,
  toHex,
  toRgba,
  visibleHex,
} from '../../lib/color';
import { ColorPicker } from './ColorPicker';
import { ResettableLabel } from './ResettableLabel';
import { DockablePanel } from '../primitives/DockablePanel';

interface Props {
  currentClass: string;
  /** Active breakpoint layer — the explicit color is read across the cascade. */
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  /** Clear a color at the active breakpoint. */
  onReset: (spec: ResetSpec) => void;
  /** Rendered colors from getComputedStyle, keyed by CSS property ('color',
   *  'background-color'), used to seed the picker when there's no explicit
   *  arbitrary value in the class. */
  computed?: Record<string, string | undefined>;
}

/** One color control (text / background / border …): a swatch + popover picker.
 *  Exported so the control registry can place each color in its own section. */
export function ColorField({
  label,
  css,
  prefix,
  currentClass,
  layer,
  onApplyEnum,
  onReset,
  computed,
}: {
  label: string;
  css: string;
  prefix: ColorPrefix;
} & Props) {
  // Explicit arbitrary value at the active breakpoint; otherwise fall back to
  // the element's rendered color for display/seeding.
  const { value: explicit, definedAt } = readLayer(currentClass, layer, (s) =>
    arbitraryColorRaw(s, prefix)
  );
  const computedRaw = computed?.[css];
  const seed = explicit ?? computedRaw ?? '#000000';
  // A parent-renderable color for the chip (alpha-aware): the explicit value if
  // parseable (a `var()` isn't), else the element's visible computed color.
  const renderable =
    (explicit && toHex(explicit) ? explicit : null) ??
    (computedRaw && visibleHex(computedRaw) ? computedRaw : null);
  const swatch = renderable ? rgbaToCss(toRgba(renderable)) : null;

  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = COLOR_PICKER_WIDTH;
    const H = COLOR_PICKER_HEIGHT;
    const M = COLOR_PICKER_GUTTER;
    // Prefer opening to the LEFT of the swatch (panel hugs the right edge); fall
    // back to the right, then clamp fully inside the viewport on both axes.
    let left = r.left - W - M;
    if (left < M) left = r.right + M;
    left = Math.min(Math.max(M, left), Math.max(M, window.innerWidth - W - M));
    const maxTop = Math.max(M, window.innerHeight - H - M);
    const top = Math.min(Math.max(M, r.top), maxTop);
    setRect({ top, left });
  }, []);

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

  useDismissOnOutsidePointer(open, popRef, () => setOpen(false), {
    isOutside: (t) =>
      !triggerRef.current?.contains(t) &&
      !popRef.current?.contains(t) &&
      !(t as HTMLElement).closest?.('.ss-color-picker__format-menu'),
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.ss-color-picker__format-menu')) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handlePick = useCallback(
    (cssColor: string) => {
      onApplyEnum(colorClassToken(prefix, cssColor), { [css]: cssColor });
    },
    [prefix, css, onApplyEnum]
  );

  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={label}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(colorResetSpec(prefix, css))}
      />
      <button
        ref={triggerRef}
        type="button"
        className="ss-color-swatch"
        title={`${label} color`}
        aria-label={`${label} color`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {swatch ? (
          <span className="ss-color-swatch__chip" style={{ background: swatch }} />
        ) : (
          <span className="ss-color-swatch__empty">—</span>
        )}
      </button>
      {open && rect && (
        <DockablePanel
          docked={false}
          ariaLabel="Color picker"
          positionKey={COLOR_PICKER_POSITION_KEY}
          sizeKey={COLOR_PICKER_SIZE_KEY}
          floatingSize={{ width: COLOR_PICKER_WIDTH, height: COLOR_PICKER_HEIGHT }}
          initialPosition={() => ({ left: rect.left, top: rect.top })}
          resizable={false}
          surfaceClassName="ss-color-picker__floating-surface"
        >
          <div ref={popRef} className="ss-color-picker__floating-content">
            <ColorPicker
              value={seed}
              onChange={handlePick}
              onClose={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            />
          </div>
        </DockablePanel>
      )}
    </div>
  );
}
