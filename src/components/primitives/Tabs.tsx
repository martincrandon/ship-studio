import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Button, type ButtonProps, type ButtonSize } from './Button';

type TabValue = string;

interface TabsContextValue {
  id: string;
  value: TabValue;
  select: (value: TabValue) => void;
  size: ButtonSize;
  registerTab: (value: TabValue, element: HTMLButtonElement | null) => void;
  moveFocus: (value: TabValue, direction: 1 | -1) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps {
  value?: TabValue;
  defaultValue?: TabValue;
  onValueChange?: (value: TabValue) => void;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
}

export function Tabs({
  value: controlledValue,
  defaultValue,
  onValueChange,
  size = 'compact',
  children,
  className,
}: TabsProps) {
  const id = useId();
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '');
  const value = controlledValue ?? uncontrolledValue;
  const tabsRef = useRef(new Map<TabValue, HTMLButtonElement>());

  const select = useCallback(
    (next: TabValue) => {
      if (controlledValue === undefined) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [controlledValue, onValueChange]
  );

  const registerTab = useCallback((tabValue: TabValue, element: HTMLButtonElement | null) => {
    if (element) tabsRef.current.set(tabValue, element);
    else tabsRef.current.delete(tabValue);
  }, []);

  const moveFocus = useCallback(
    (current: TabValue, direction: 1 | -1) => {
      const values = [...tabsRef.current.keys()];
      const index = values.indexOf(current);
      if (index < 0 || values.length < 2) return;
      const next = values[(index + direction + values.length) % values.length];
      select(next);
      tabsRef.current.get(next)?.focus();
    },
    [select]
  );

  const contextValue = useMemo(
    () => ({ id, value, select, size, registerTab, moveFocus }),
    [id, value, select, size, registerTab, moveFocus]
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={`tabs ${className ?? ''}`}>{children}</div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  variant?: 'default' | 'stretch';
  appearance?: 'segmented' | 'underline';
}

export function TabsList({
  children,
  className,
  variant = 'default',
  appearance = 'segmented',
  ...props
}: TabsListProps) {
  const tabs = useContext(TabsContext);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const activeValue = tabs?.value;

  useLayoutEffect(() => {
    if (!tabs || !listRef.current) return;
    const active = tabsRefElement(activeValue ?? '', listRef.current);
    if (!active) return;
    const listRect = listRef.current.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const borderInset = listRef.current.clientLeft;
    setIndicator({
      left: activeRect.left - listRect.left - borderInset,
      top: activeRect.top - listRect.top - borderInset,
      width: activeRect.width,
      height: activeRect.height,
    });
  }, [activeValue, tabs]);

  return (
    <div
      ref={listRef}
      className={`tabs__list tabs__list--${variant} tabs__list--appearance-${appearance} ${className ?? ''}`}
      role="tablist"
      {...props}
    >
      {children}
      <span
        className="tabs__indicator"
        aria-hidden="true"
        style={{
          transform: `translate(${indicator.left}px, ${indicator.top}px)`,
          width: indicator.width,
          height: indicator.height,
        }}
      />
    </div>
  );
}

function tabsRefElement(value: TabValue, list: HTMLDivElement): HTMLButtonElement | null {
  return (
    [...list.querySelectorAll<HTMLButtonElement>('[data-tab-value]')].find(
      (element) => element.dataset.tabValue === value
    ) ?? null
  );
}

export interface TabsTabProps extends Omit<ButtonProps, 'children' | 'value' | 'variant' | 'size'> {
  value: TabValue;
  children?: ReactNode;
  size?: ButtonSize;
}

export function TabsTab({
  value,
  children,
  className,
  size,
  onClick,
  onKeyDown,
  ...props
}: TabsTabProps) {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error('TabsTab must be used inside Tabs');
  const active = tabs.value === value;

  return (
    <Button
      {...props}
      variant="default"
      size={size ?? tabs.size}
      className={`tabs__tab ${active ? 'is-active' : ''} ${className ?? ''}`}
      data-tab-value={value}
      role="tab"
      aria-selected={active}
      aria-controls={`${tabs.id}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      ref={(element) => tabs.registerTab(value, element)}
      onClick={(event) => {
        tabs.select(value);
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          tabs.moveFocus(value, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          tabs.moveFocus(value, -1);
        }
      }}
    >
      {children}
    </Button>
  );
}

export interface TabsPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: TabValue;
  children: ReactNode;
}

export function TabsPanel({ value, children, className, ...props }: TabsPanelProps) {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error('TabsPanel must be used inside Tabs');
  const active = tabs.value === value;

  return (
    <div
      {...props}
      id={`${tabs.id}-panel-${value}`}
      className={`tabs__panel ${className ?? ''}`}
      role="tabpanel"
      aria-hidden={!active}
      hidden={!active}
    >
      {children}
    </div>
  );
}
