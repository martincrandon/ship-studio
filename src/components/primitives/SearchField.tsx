import { forwardRef, type InputHTMLAttributes } from 'react';
import { CloseIcon, SearchIcon } from '@/components/icons';
import { IconButton } from './IconButton';
import { TextField } from './TextField';

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'aria-label' | 'className' | 'onChange' | 'placeholder' | 'type' | 'value'
> {
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
  placeholder: string;
  /** Accessible label for the clear control. Defaults to "Clear search". */
  clearLabel?: string;
  /** The control density shared with TextField's default and compact contracts. */
  density?: 'standard' | 'compact';
  className?: string;
  inputClassName?: string;
}

/** Search input with shared icon, input styling, and an accessible clear action. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  {
    value,
    onChange,
    'aria-label': ariaLabel,
    placeholder,
    clearLabel = 'Clear search',
    density = 'standard',
    className,
    inputClassName,
    ...inputProps
  },
  ref
) {
  return (
    <div
      className={[
        'ss-search-field',
        density === 'compact' ? 'ss-search-field--compact' : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <SearchIcon className="ss-search-field__icon" size={13} aria-hidden="true" />
      <TextField
        ref={ref}
        type="search"
        className={[
          'ss-search-field__input',
          density === 'compact' ? 'ss-text-field--compact' : null,
          inputClassName,
        ]
          .filter(Boolean)
          .join(' ')}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        {...inputProps}
      />
      {value.length > 0 && (
        <IconButton
          variant="ghost"
          size="compact"
          disabled={inputProps.disabled}
          className="ss-search-field__clear"
          aria-label={clearLabel}
          title={clearLabel}
          icon={<CloseIcon size={12} />}
          onClick={() => onChange('')}
        />
      )}
    </div>
  );
});
