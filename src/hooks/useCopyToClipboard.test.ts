import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTextWithFocusRetry } from './useCopyToClipboard';

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const notAllowed = () => {
  const e = new Error('Write permission denied.');
  e.name = 'NotAllowedError';
  return e;
};

describe('writeTextWithFocusRetry (issue #753)', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes once when the first attempt succeeds', async () => {
    writeText.mockResolvedValue(undefined);
    await writeTextWithFocusRetry('hello');
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('retries once after a NotAllowedError instead of surfacing it', async () => {
    // The webview denies clipboard writes while the window isn't focused; the
    // click that triggered the copy is what focuses it, a beat too late.
    writeText.mockRejectedValueOnce(notAllowed()).mockResolvedValueOnce(undefined);
    await writeTextWithFocusRetry('hello');
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(window.focus).toHaveBeenCalled();
  });

  it('waits for the focus event (or the timeout) before retrying when unfocused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    writeText.mockRejectedValueOnce(notAllowed()).mockResolvedValueOnce(undefined);
    const pending = writeTextWithFocusRetry('hello');
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    await pending;
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second denial and rethrows', async () => {
    writeText.mockRejectedValue(notAllowed());
    await expect(writeTextWithFocusRetry('hello')).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('does not retry unrelated failures', async () => {
    writeText.mockRejectedValue(new Error('Clipboard API unavailable'));
    await expect(writeTextWithFocusRetry('hello')).rejects.toThrow('unavailable');
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
