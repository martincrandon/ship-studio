import type { ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';
import { MenuButton } from './MenuButton';

interface SplitButtonProps {
  actionLabel: ReactNode;
  actionProps: Omit<ButtonProps, 'children'>;
  menuLabel: ReactNode;
  menuProps: Omit<ButtonProps, 'children' | 'aria-expanded' | 'aria-haspopup'> & {
    expanded: boolean;
  };
  className?: string;
}

export function SplitButton({
  actionLabel,
  actionProps,
  menuLabel,
  menuProps,
  className,
}: SplitButtonProps) {
  return (
    <div className={`button-group button-group--split ${className ?? ''}`}>
      <Button {...actionProps}>{actionLabel}</Button>
      <MenuButton {...menuProps}>{menuLabel}</MenuButton>
    </div>
  );
}
