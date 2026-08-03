import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Adds the invalid treatment without requiring feature code to compose classes. */
  invalid?: boolean;
  /** Optional trailing unit/value slot for compact property fields. */
  suffix?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { className, invalid = false, suffix, ...props },
  ref
) {
  const input = (
    <input
      ref={ref}
      className={['ss-text-field', invalid ? 'ss-text-field--invalid' : null, className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );

  if (suffix === undefined) return input;

  return (
    <span className="ss-text-field-shell">
      {input}
      <span className="ss-text-field__suffix">{suffix}</span>
    </span>
  );
});
