import { describe, expect, it } from 'vitest';
import {
  cameraTransitionDuration,
  isCanvasEditableTarget,
  isCanvasPinchWheel,
  isCanvasTextInputTarget,
  isComponentsWorkspaceTarget,
  mapCanvasKeyboardIntent,
  shouldIgnoreCanvasKeyboardEvent,
} from './canvas-input';

describe('canvas input guards', () => {
  it('does not steal keyboard input from editable controls or IME composition', () => {
    expect(isCanvasEditableTarget({ tagName: 'input' })).toBe(true);
    expect(shouldIgnoreCanvasKeyboardEvent({ key: 'a', target: { tagName: 'INPUT' } })).toBe(true);
    expect(shouldIgnoreCanvasKeyboardEvent({ key: 'a', isComposing: true })).toBe(true);
    expect(shouldIgnoreCanvasKeyboardEvent({ key: 'Escape', target: { tagName: 'DIV' } })).toBe(
      false
    );
  });

  it('keeps camera shortcuts on buttons while guarding actual text inputs', () => {
    expect(isCanvasTextInputTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isCanvasTextInputTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isCanvasTextInputTarget({ isContentEditable: true })).toBe(true);
  });

  it('distinguishes pinch wheel input and reduced-motion camera transitions', () => {
    expect(isCanvasPinchWheel({ ctrlKey: true })).toBe(true);
    expect(isCanvasPinchWheel({ ctrlKey: false })).toBe(false);
    expect(cameraTransitionDuration(true)).toBe(0);
  });

  it('maps scene shortcuts while ignoring editable targets', () => {
    expect(mapCanvasKeyboardIntent({ key: 'ArrowRight', shiftKey: true })).toEqual({
      type: 'move',
      dx: 10,
      dy: 0,
    });
    expect(mapCanvasKeyboardIntent({ key: ']', metaKey: true, shiftKey: true })).toEqual({
      type: 'bring-to-front',
    });
    expect(
      mapCanvasKeyboardIntent({ key: 'a', metaKey: true, target: { tagName: 'INPUT' } })
    ).toBeNull();
    expect(mapCanvasKeyboardIntent({ key: 'y', ctrlKey: true })).toEqual({ type: 'redo' });
    expect(
      shouldIgnoreCanvasKeyboardEvent({
        key: 'a',
        target: { contentEditable: 'true' },
      })
    ).toBe(true);
  });

  it('keeps canvas history scoped to the Components workspace', () => {
    const canvasTarget = {
      closest: (selector: string) =>
        selector === '[data-testid="components-workspace"]' ? {} : null,
    };
    const sourceTarget = { closest: () => null };
    expect(isComponentsWorkspaceTarget(canvasTarget)).toBe(true);
    expect(isComponentsWorkspaceTarget(sourceTarget)).toBe(false);
    expect(isComponentsWorkspaceTarget({ tagName: 'INPUT' })).toBe(false);
  });
});
