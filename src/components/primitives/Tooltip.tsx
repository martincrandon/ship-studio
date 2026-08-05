import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

const TOOLTIP_ID = 'ss-tooltip';
const TOOLTIP_OFFSET = 8;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_DEFAULT_DELAY_MS = 1000;

interface TooltipProps {
  /** Text shown when the trigger is hovered or focused. */
  content: string;
  /** Optional delay override for contexts that need a faster tooltip. */
  delayMs?: number;
  /** One DOM element. The shared data attribute is applied to that element. */
  children: ReactElement;
}

/**
 * Mark one element for the app-wide tooltip surface. Keeping the trigger as the
 * original element means this works for buttons, SVG groups, and compact labels
 * without adding a layout wrapper.
 */
export function Tooltip({ content, delayMs, children }: TooltipProps) {
  return cloneElement(children as ReactElement<Record<string, unknown>>, {
    'data-tooltip-content': content,
    'data-tooltip-delay': delayMs,
    'aria-describedby': TOOLTIP_ID,
    title: undefined,
  });
}

interface TooltipPosition {
  top: number;
  left: number;
}

interface TooltipState {
  content: string;
}

function tooltipAnchor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-tooltip-disabled]')) return null;
  const anchor = target.closest('[data-tooltip-content], [title]');
  return anchor?.closest(`#${TOOLTIP_ID}`) ? null : anchor;
}

function readTooltipContent(anchor: Element): string | null {
  if (anchor.closest('[data-tooltip-disabled]')) {
    // This also prevents the browser's native title tooltip when an element
    // opts out of the shared React tooltip surface.
    anchor.removeAttribute('title');
    return null;
  }

  const explicit = anchor.getAttribute('data-tooltip-content');
  const title = anchor.getAttribute('title');
  if (explicit) {
    // React can restore a title attribute during a rerender after the custom
    // tooltip has already claimed this anchor. Always remove it, even when
    // the shared content attribute is already present.
    if (title) anchor.removeAttribute('title');
    return explicit;
  }
  if (!title) return null;

  // Promote native title tooltips to the shared surface for every existing
  // title-based affordance. Removing the attribute prevents the OS tooltip from
  // competing with the app tooltip on the same hover.
  anchor.setAttribute('data-tooltip-content', title);
  anchor.setAttribute('aria-describedby', TOOLTIP_ID);
  anchor.removeAttribute('title');
  return title;
}

function readTooltipDelay(anchor: Element): number {
  const rawDelay = anchor.getAttribute('data-tooltip-delay');
  if (!rawDelay) return TOOLTIP_DEFAULT_DELAY_MS;

  const delay = Number(rawDelay);
  return Number.isFinite(delay) && delay >= 0 ? delay : TOOLTIP_DEFAULT_DELAY_MS;
}

function promoteTitleAttributes(root: Element) {
  const anchors = [...(root.matches('[title]') ? [root] : []), ...root.querySelectorAll('[title]')];

  anchors.forEach((anchor) => {
    readTooltipContent(anchor);
  });
}

function samePosition(a: TooltipPosition | null, b: TooltipPosition) {
  return a?.top === b.top && a.left === b.left;
}

/**
 * App-level tooltip host. Existing `title` attributes are promoted to the
 * shared surface as soon as they enter the DOM, while new components can use
 * `<Tooltip content="…">` explicitly. A short delay prevents tooltips from
 * flashing during quick pointer passes.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null);
  const pendingAnchorRef = useRef<Element | null>(null);
  const showTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    promoteTitleAttributes(document.body);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          readTooltipContent(mutation.target);
          return;
        }

        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) promoteTitleAttributes(node);
        });
      });
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    });

    return () => observer.disconnect();
  }, []);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const belowTop = anchorRect.bottom + TOOLTIP_OFFSET;
    const aboveTop = anchorRect.top - TOOLTIP_OFFSET - popoverRect.height;
    const top =
      belowTop + popoverRect.height <= window.innerHeight || aboveTop < TOOLTIP_MARGIN
        ? belowTop
        : aboveTop;
    const left = Math.max(
      TOOLTIP_MARGIN,
      Math.min(
        anchorRect.left + (anchorRect.width - popoverRect.width) / 2,
        window.innerWidth - popoverRect.width - TOOLTIP_MARGIN
      )
    );
    const next = { top: Math.max(TOOLTIP_MARGIN, top), left };
    setPosition((current) => (samePosition(current, next) ? current : next));
  }, []);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    pendingAnchorRef.current = null;
  }, []);

  const show = useCallback(
    (anchor: Element | null) => {
      clearShowTimer();
      if (!anchor) return;
      const content = readTooltipContent(anchor);
      if (!content) return;

      pendingAnchorRef.current = anchor;
      showTimerRef.current = window.setTimeout(() => {
        if (pendingAnchorRef.current !== anchor) return;
        pendingAnchorRef.current = null;
        showTimerRef.current = null;
        anchorRef.current = anchor;
        setPosition(null);
        setState({ content });
      }, readTooltipDelay(anchor));
    },
    [clearShowTimer]
  );

  const hide = useCallback(() => {
    clearShowTimer();
    anchorRef.current = null;
    setState(null);
    setPosition(null);
  }, [clearShowTimer]);

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      const anchor = tooltipAnchor(event.target);
      if (anchor === anchorRef.current) return;
      show(anchor);
    };
    const onPointerOut = (event: PointerEvent) => {
      const anchor = anchorRef.current ?? pendingAnchorRef.current;
      if (!anchor) return;
      const related = event.relatedTarget;
      if (related instanceof Node && anchor.contains(related)) return;
      if (tooltipAnchor(related) === anchor) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => show(tooltipAnchor(event.target));
    const onFocusOut = (event: FocusEvent) => {
      const anchor = anchorRef.current ?? pendingAnchorRef.current;
      if (
        !anchor ||
        (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))
      ) {
        return;
      }
      hide();
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      clearShowTimer();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, [clearShowTimer, hide, show]);

  useLayoutEffect(() => {
    if (!state) return;
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [state, updatePosition]);

  useEffect(() => {
    if (!state) return;
    const onViewportChange = () => updatePosition();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [state, updatePosition]);

  return (
    <>
      {children}
      {state &&
        createPortal(
          <div
            ref={popoverRef}
            id={TOOLTIP_ID}
            className="ss-tooltip"
            role="tooltip"
            style={position ? { top: position.top, left: position.left } : undefined}
          >
            {state.content}
          </div>,
          document.body
        )}
    </>
  );
}
