export interface CanvasHistoryEntry<T> {
  label: string;
  before: T;
  after: T;
}

export interface CanvasHistoryOptions<T = unknown> {
  maxEntries?: number;
  equals?: (left: T, right: T) => boolean;
}

export interface CanvasHistoryTransaction<T> {
  readonly before: T;
  readonly current: T;
  update(next: T): T;
  commit(): T;
  abort(): T;
}

const sameValue = (left: unknown, right: unknown): boolean => Object.is(left, right);

/**
 * Scene history is deliberately separate from source-editor undo/redo. A
 * gesture owns one transaction: updates are transient, commit adds one entry,
 * and abort restores the exact pre-gesture value without touching redo state.
 */
export class CanvasHistory<T> {
  private readonly maxEntries: number;
  private readonly equals: (left: T, right: T) => boolean;
  private undoStack: CanvasHistoryEntry<T>[] = [];
  private redoStack: CanvasHistoryEntry<T>[] = [];
  private state: T;

  constructor(initial: T, options: CanvasHistoryOptions<T> = {}) {
    this.state = initial;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 100));
    this.equals = options.equals ?? sameValue;
  }

  get current(): T {
    return this.state;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get entries(): readonly CanvasHistoryEntry<T>[] {
    return this.undoStack;
  }

  begin(label: string): CanvasHistoryTransaction<T> {
    const before = this.state;
    let current = before;
    let settled = false;
    const transaction: CanvasHistoryTransaction<T> = {
      before,
      get current() {
        return current;
      },
      update: (next) => {
        if (settled) return current;
        current = next;
        this.state = next;
        return current;
      },
      commit: () => {
        if (settled) return this.state;
        settled = true;
        if (!this.equals(before, current)) {
          this.undoStack.push({ label, before, after: current });
          if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
          this.redoStack = [];
        }
        this.state = current;
        return current;
      },
      abort: () => {
        if (settled) return this.state;
        settled = true;
        current = before;
        this.state = before;
        return before;
      },
    };
    return transaction;
  }

  beginTransaction(label: string): CanvasHistoryTransaction<T> {
    return this.begin(label);
  }

  record(label: string, before: T, after: T): T {
    if (this.equals(before, after)) {
      this.state = after;
      return after;
    }
    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
    this.redoStack = [];
    this.state = after;
    return after;
  }

  /**
   * Replaces the current document without creating an undo entry. Callers can
   * optionally rebase existing entries when the update is an out-of-band
   * persisted field such as camera state or renderer measurements.
   */
  replaceCurrent(next: T, rebase?: (entry: CanvasHistoryEntry<T>) => CanvasHistoryEntry<T>): T {
    if (rebase) {
      this.undoStack = this.undoStack.map(rebase);
      this.redoStack = this.redoStack.map(rebase);
    }
    this.state = next;
    return next;
  }

  undo(): T {
    const entry = this.undoStack.pop();
    if (!entry) return this.state;
    this.redoStack.push(entry);
    this.state = entry.before;
    return this.state;
  }

  redo(): T {
    const entry = this.redoStack.pop();
    if (!entry) return this.state;
    this.undoStack.push(entry);
    this.state = entry.after;
    return this.state;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export const CanvasTransactionHistory = CanvasHistory;

export function createCanvasHistory<T>(
  initial: T,
  options?: CanvasHistoryOptions<T>
): CanvasHistory<T> {
  return new CanvasHistory(initial, options);
}
