import { describe, expect, it, vi } from 'vitest';
import { startComponentWatcherWithCleanup } from './useComponentCatalog';

describe('component watcher startup lifecycle', () => {
  it('stops a watcher when cleanup wins while startup is pending', async () => {
    let resolveStart!: () => void;
    let disposed = false;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        })
    );
    const stop = vi.fn().mockResolvedValue(undefined);

    const startup = startComponentWatcherWithCleanup({
      start,
      stop,
      isDisposed: () => disposed,
    });
    disposed = true;
    resolveStart();

    await expect(startup).resolves.toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps a watcher running when startup completes before cleanup', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    await expect(
      startComponentWatcherWithCleanup({
        start: vi.fn().mockResolvedValue(undefined),
        stop,
        isDisposed: () => false,
      })
    ).resolves.toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });
});
