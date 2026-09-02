import { forwardRef, type InputHTMLAttributes } from 'react';
import { SearchIcon } from '@/components/icons';
import { TextField } from './TextField';

/** Props for the compact search-field shell used by filterable panels. */
export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Additional classes for the outer search shell. */
  className?: string;
  /** Additional classes for the underlying text input. */
  inputClassName?: string;
}

/** Compact search shell shared by panel and file-browser filters. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, inputClassName, ...props },
  ref
) {
  return (
    <label className={['ss-search-field', className].filter(Boolean).join(' ')}>
      <SearchIcon size={12} aria-hidden="true" />
      <TextField
        ref={ref}
        className={['ss-search-field__input', inputClassName].filter(Boolean).join(' ')}
        {...props}
      />
    </label>
  );
});
