/**
 * SplitPane component that provides a resizable two-pane layout.
 *
 * Creates a horizontal split view with a draggable divider. The divider
 * can be dragged to resize the panes while respecting minimum size constraints.
 * Automatically triggers window resize events when dragged so child components
 * (like terminals) can recalculate their dimensions.
 *
 * @module components/SplitPane
 */

import { useState, useRef, useCallback, ReactNode, useEffect } from 'react';

/** Props for the SplitPane component */
interface SplitPaneProps {
  /** Content for the left pane */
  left: ReactNode;
  /** Content for the right pane */
  right: ReactNode;
  /** Initial split position as percentage (0-100, default: 50) */
  defaultSplit?: number;
  /** Minimum width for left pane as percentage (default: 20) */
  minLeft?: number;
  /** Minimum width for right pane as percentage (default: 20) */
  minRight?: number;
  /** Whether the right pane is collapsed */
  rightCollapsed?: boolean;
  /** Whether the left pane is collapsed */
  leftCollapsed?: boolean;
  /** Optional localStorage key used to restore the user's split ratio. */
  persistenceKey?: string;
}

export function SplitPane({
  left,
  right,
  defaultSplit = 50,
  minLeft = 20,
  minRight = 20,
  rightCollapsed = false,
  leftCollapsed = false,
  persistenceKey,
}: SplitPaneProps) {
  const initialSplit = (() => {
    if (!persistenceKey) return defaultSplit;
    const saved = Number(localStorage.getItem(persistenceKey));
    return Number.isFinite(saved) && saved >= minLeft && saved <= 100 - minRight
      ? saved
      : defaultSplit;
  })();
  const [split, setSplit] = useState(initialSplit);
  const savedSplitRef = useRef(initialSplit);
  const latestSplitRef = useRef(initialSplit);
  const prevCollapsedRef = useRef(rightCollapsed);
  const prevLeftCollapsedRef = useRef(leftCollapsed);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Store drag listeners in ref for cleanup on unmount
  const dragListenersRef = useRef<{
    move: ((e: MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => {
      const { move, up } = dragListenersRef.current;
      if (move) document.removeEventListener('mousemove', move);
      if (up) document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  // Handle collapse/expand of right pane
  useEffect(() => {
    // Only act on actual state changes, not initial mount
    if (rightCollapsed !== prevCollapsedRef.current) {
      if (rightCollapsed) {
        // Save current split before collapsing
        savedSplitRef.current = split;
      } else {
        // Restore saved split when expanding
        setSplit(savedSplitRef.current);
      }
      prevCollapsedRef.current = rightCollapsed;
      // Trigger resize event for terminals to recalculate
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  }, [rightCollapsed, split]);

  useEffect(() => {
    if (leftCollapsed !== prevLeftCollapsedRef.current) {
      prevLeftCollapsedRef.current = leftCollapsed;
      // Let terminals and preview content fit their newly available width.
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  }, [leftCollapsed]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      let rafId: number | null = null;
      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return;
        // Throttle to one update per animation frame
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!containerRef.current) return;

          const rect = containerRef.current.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const percentage = (x / rect.width) * 100;

          // Clamp to min/max
          const clamped = Math.max(minLeft, Math.min(100 - minRight, percentage));
          latestSplitRef.current = clamped;
          setSplit(clamped);

          // Trigger resize event for terminals to recalculate
          window.dispatchEvent(new Event('resize'));
        });
      };

      const handleMouseUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        setIsDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        dragListenersRef.current = { move: null, up: null };
        if (persistenceKey) {
          localStorage.setItem(persistenceKey, String(latestSplitRef.current));
        }
      };

      // Store listeners for cleanup
      dragListenersRef.current = { move: handleMouseMove, up: handleMouseUp };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [minLeft, minRight, persistenceKey]
  );

  return (
    <div
      ref={containerRef}
      className={`split-pane${rightCollapsed ? ' right-collapsed' : ''}${
        leftCollapsed ? ' left-collapsed' : ''
      }`}
    >
      {/* Overlay to capture mouse events during drag (prevents iframe from stealing events) */}
      {isDragging && <div className="split-pane-overlay" />}
      {/* Keep the left pane mounted while collapsed. Agent terminals own live
          session/UI state that must survive a purely visual hide/show. */}
      <div
        className="split-pane-left"
        style={{ width: leftCollapsed ? 0 : rightCollapsed ? '100%' : `${split}%` }}
        aria-hidden={leftCollapsed}
      >
        {left}
      </div>
      {!leftCollapsed && !rightCollapsed && (
        <div className="split-pane-handle" onMouseDown={handleMouseDown}>
          <div className="split-pane-handle-bar" />
        </div>
      )}
      {!rightCollapsed && (
        <>
          <div
            className="split-pane-right"
            style={{ width: leftCollapsed ? '100%' : `${100 - split}%` }}
          >
            {right}
          </div>
        </>
      )}
    </div>
  );
}
