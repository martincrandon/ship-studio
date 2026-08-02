import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementTree } from './useElementTree';

describe('useElementTree', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('retries the initial request until the preview returns a tree', () => {
    vi.useFakeTimers();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const previewWindow = iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    const postMessage = vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
    const iframeRef = { current: iframe };

    const { result } = renderHook(() => useElementTree({ iframeRef, enabled: true }));

    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:requestTree' }, '*');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(postMessage).toHaveBeenCalledTimes(2);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: previewWindow,
          data: {
            type: 'ss:tree',
            tree: { i: 1, t: 'body', c: '', x: '', k: [] },
            truncated: false,
          },
        })
      );
    });

    expect(result.current.tree).toEqual({
      id: 1,
      tag: 'body',
      cls: '',
      text: '',
      children: [],
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
