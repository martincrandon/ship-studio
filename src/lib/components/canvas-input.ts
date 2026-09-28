export interface CanvasKeyboardLikeEvent {
  key: string;
  target?: unknown;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export type CanvasKeyboardIntent =
  | { type: 'select-all' }
  | { type: 'duplicate' }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'bring-forward' }
  | { type: 'send-backward' }
  | { type: 'bring-to-front' }
  | { type: 'send-to-back' }
  | { type: 'move'; dx: number; dy: number };

export interface CanvasTargetLike {
  tagName?: string;
  role?: string;
  contentEditable?: string | boolean;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

export function isCanvasEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as CanvasTargetLike;
  const tagName = element.tagName?.toUpperCase();
  const contentEditable = element.getAttribute?.('contenteditable');
  const editableAncestor = element.closest?.('[contenteditable]');
  return (
    (!!tagName && EDITABLE_TAGS.has(tagName)) ||
    element.role?.toLowerCase() === 'textbox' ||
    element.contentEditable === true ||
    (typeof element.contentEditable === 'string' &&
      ['true', '', 'plaintext-only'].includes(element.contentEditable.toLowerCase())) ||
    element.isContentEditable === true ||
    (contentEditable !== null && contentEditable !== undefined && contentEditable !== 'false') ||
    Boolean(editableAncestor)
  );
}

/** Matches Grida's narrower text-input guard for document-level camera keys. */
export function isCanvasTextInputTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as CanvasTargetLike;
  const tagName = element.tagName?.toUpperCase();
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    element.isContentEditable === true ||
    element.contentEditable === true ||
    (typeof element.contentEditable === 'string' &&
      ['true', '', 'plaintext-only'].includes(element.contentEditable.toLowerCase()))
  );
}

export function shouldIgnoreCanvasKeyboardEvent(event: CanvasKeyboardLikeEvent): boolean {
  return Boolean(
    event.defaultPrevented || event.isComposing || isCanvasEditableTarget(event.target)
  );
}

export function shouldHandleCanvasKeyboardEvent(event: CanvasKeyboardLikeEvent): boolean {
  return !shouldIgnoreCanvasKeyboardEvent(event);
}

/** Returns whether a key event belongs to the Components workspace canvas. */
export function isComponentsWorkspaceTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as CanvasTargetLike).closest;
  return typeof closest === 'function'
    ? Boolean(closest.call(target, '[data-testid="components-workspace"]'))
    : false;
}

/** Maps keyboard input to scene intent without performing or preventing actions. */
export function mapCanvasKeyboardIntent(
  event: CanvasKeyboardLikeEvent
): CanvasKeyboardIntent | null {
  if (shouldIgnoreCanvasKeyboardEvent(event)) return null;
  const key = event.key.toLowerCase();
  const command = event.metaKey === true || event.ctrlKey === true;
  if (command && key === 'a') return { type: 'select-all' };
  if (command && key === 'd') return { type: 'duplicate' };
  if (command && key === 'z') return { type: event.shiftKey ? 'redo' : 'undo' };
  if (command && key === 'y') return { type: 'redo' };
  if (command && key === ']') {
    return { type: event.shiftKey ? 'bring-to-front' : 'bring-forward' };
  }
  if (command && key === '[') {
    return { type: event.shiftKey ? 'send-to-back' : 'send-backward' };
  }
  if (key === 'delete' || key === 'backspace') return { type: 'delete' };
  if (key === 'escape' || key === 'esc') return { type: 'escape' };
  const distance = event.shiftKey ? 10 : 1;
  if (key === 'arrowleft') return { type: 'move', dx: -distance, dy: 0 };
  if (key === 'arrowright') return { type: 'move', dx: distance, dy: 0 };
  if (key === 'arrowup') return { type: 'move', dx: 0, dy: -distance };
  if (key === 'arrowdown') return { type: 'move', dx: 0, dy: distance };
  return null;
}

export function isPrimaryCanvasPointer(button: number, isPrimary = true): boolean {
  return isPrimary && button === 0;
}

/** Wheel events with ctrlKey are browser pinch gestures and canvas zoom input. */
export function isCanvasPinchWheel(event: { ctrlKey?: boolean }): boolean {
  return event.ctrlKey === true;
}

export function prefersReducedMotion(
  mediaMatches: (query: string) => boolean = () => false
): boolean {
  return mediaMatches('(prefers-reduced-motion: reduce)');
}

export function cameraTransitionDuration(reducedMotion: boolean, normalDurationMs = 200): number {
  return reducedMotion ? 0 : Math.max(0, normalDurationMs);
}

export const isEditableTarget = isCanvasEditableTarget;
export const shouldIgnoreKeyboardEvent = shouldIgnoreCanvasKeyboardEvent;
export const keyboardIntent = mapCanvasKeyboardIntent;
export const isPinchGesture = isCanvasPinchWheel;
export const getCameraTransitionDuration = cameraTransitionDuration;
