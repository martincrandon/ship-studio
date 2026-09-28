import { describe, expect, it } from 'vitest';
import { CanvasHistory } from './canvas-history';

describe('canvas transaction history', () => {
  it('records one bounded entry per completed gesture', () => {
    const history = new CanvasHistory({ x: 0 }, { maxEntries: 2, equals: (a, b) => a.x === b.x });
    const gesture = history.begin('drag');
    gesture.update({ x: 1 });
    gesture.update({ x: 2 });
    expect(gesture.commit()).toEqual({ x: 2 });
    expect(history.entries).toHaveLength(1);
    expect(history.undo()).toEqual({ x: 0 });
    expect(history.redo()).toEqual({ x: 2 });
  });

  it('aborts to the exact pre-gesture state and does not create history', () => {
    const initial = { x: 10 };
    const history = new CanvasHistory(initial, { equals: (a, b) => a.x === b.x });
    const gesture = history.begin('resize');
    gesture.update({ x: 40 });
    expect(gesture.abort()).toBe(initial);
    expect(history.current).toBe(initial);
    expect(history.canUndo).toBe(false);
  });

  it('bounds old entries and clears redo after a new committed gesture', () => {
    const history = new CanvasHistory(0, { maxEntries: 2 });
    history.record('one', 0, 1);
    history.record('two', 1, 2);
    history.record('three', 2, 3);
    expect(history.entries.map((entry) => entry.label)).toEqual(['two', 'three']);
    history.undo();
    const gesture = history.begin('new');
    gesture.update(9);
    gesture.commit();
    expect(history.canRedo).toBe(false);
  });
});
