import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'ghost'
  | 'warning'
  | 'variable';

export type ButtonAppearance = 'solid' | 'outline' | 'ghost';
export type ButtonTone = 'neutral' | 'primary' | 'danger' | 'warning' | 'variable';
export type ButtonDensity = 'standard' | 'compact';
export type ButtonWidth = 'hug' | 'fill';

const variantRecipe: Record<ButtonVariant, { appearance: ButtonAppearance; tone: ButtonTone }> = {
  default: { appearance: 'solid', tone: 'neutral' },
  primary: { appearance: 'solid', tone: 'primary' },
  secondary: { appearance: 'outline', tone: 'neutral' },
  danger: { appearance: 'outline', tone: 'danger' },
  ghost: { appearance: 'ghost', tone: 'neutral' },
  warning: { appearance: 'solid', tone: 'warning' },
  variable: { appearance: 'solid', tone: 'variable' },
};

export function buttonClassNames({
  variant = 'default',
  appearance,
  tone,
  density = 'standard',
  width = 'hug',
  className,
}: {
  variant?: ButtonVariant;
  appearance?: ButtonAppearance;
  tone?: ButtonTone;
  density?: ButtonDensity;
  width?: ButtonWidth;
  className?: string;
} = {}) {
  const recipe = variantRecipe[variant];
  return [
    'button',
    `button--${variant}`,
    `button--appearance-${appearance ?? recipe.appearance}`,
    `button--tone-${tone ?? recipe.tone}`,
    `button--density-${density}`,
    `button--width-${width}`,
    density === 'compact' ? 'button--sm' : null,
    width === 'fill' ? 'button--fill button--block' : 'button--hug',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Props for the canonical action button. Extends the native button attributes
 * (`onClick`, `disabled`, `title`, …) and forwards its ref; `type` defaults to
 * `"button"` so forms don't submit by accident.
 *
 * - `variant` — visual emphasis. `default` = neutral Figma solid,
 *   `secondary` = neutral outline, `primary` = green CTA, `danger` =
 *   red-tinted destructive action, `ghost` = borderless low-emphasis action,
 *   `warning` = amber warning action, and `variable` = purple variable action.
 * - `size` — `md` (default) or `sm` for dense rows and toolbars.
 * - `width` — `hug` (default) sizes to content; `fill` stretches to the
 *   container. `block` remains as a backwards-compatible alias for `fill`.
 * - `leftIcon` / `rightIcon` — icon nodes rendered beside the label with the
 *   standard gap (size 14 is the house convention).
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  appearance?: ButtonAppearance;
  tone?: ButtonTone;
  size?: 'sm' | 'md';
  density?: ButtonDensity;
  width?: ButtonWidth;
  block?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    appearance,
    tone,
    size = 'md',
    density,
    width = 'hug',
    block,
    leftIcon,
    rightIcon,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const classes = buttonClassNames({
    variant,
    appearance,
    tone,
    density: density ?? (size === 'sm' ? 'compact' : 'standard'),
    width: block ? 'fill' : width,
    className,
  });

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
