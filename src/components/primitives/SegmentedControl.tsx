import type { ReactNode } from 'react';
import { ToggleButton } from './ToggleButton';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedControlOption<T>[];
  onValueChange: (value: T) => void;
  'aria-label': string;
  className?: string;
}

/**
 * A mutually exclusive set of compact choices.
 *
 * Use this for filters and settings that update a value in place. Use Tabs
 * when the choices navigate between panels, and ToggleButton for one boolean.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className={`segmented-control ${className ?? ''}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          variant="default"
          size="compact"
          pressed={value === option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          title={option.title ?? option.ariaLabel}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </ToggleButton>
      ))}
    </div>
  );
}
