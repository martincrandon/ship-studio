import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRendererFrameSnapshot } from './renderer-snapshot';

const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const getScreenshotableWindowsMock =
  vi.fn<() => Promise<Array<{ id: number | string; title?: string }>>>();
const getWindowScreenshotMock = vi.fn<(windowId: number | string) => Promise<string>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

vi.mock('tauri-plugin-screenshots-api', () => ({
  getScreenshotableWindows: () => getScreenshotableWindowsMock(),
  getWindowScreenshot: (windowId: number | string) => getWindowScreenshotMock(windowId),
}));

describe('renderer snapshot capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getScreenshotableWindowsMock.mockResolvedValue([{ id: 7, title: 'Ship Studio' }]);
    getWindowScreenshotMock.mockResolvedValue('/tmp/ship-studio-window.png');
    invokeMock.mockResolvedValue('/project/.shipstudio/screenshots/screenshot-1.png');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  });

  it('crops the active iframe through the approved screenshot command', async () => {
    const iframe = document.createElement('iframe');
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: 12,
      y: 24,
      top: 24,
      left: 12,
      right: 212,
      bottom: 224,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    });

    getWindowScreenshotMock.mockImplementation(() => {
      expect(document.documentElement).toHaveClass('component-renderer-snapshot-capture');
      return Promise.resolve('/tmp/ship-studio-window.png');
    });

    await expect(captureRendererFrameSnapshot('/project', iframe)).resolves.toBe(
      '/project/.shipstudio/screenshots/screenshot-1.png'
    );
    expect(document.documentElement).not.toHaveClass('component-renderer-snapshot-capture');
    expect(getWindowScreenshotMock).toHaveBeenCalledWith(7);
    expect(invokeMock).toHaveBeenCalledWith('crop_and_save_screenshot', {
      projectPath: '/project',
      sourcePath: '/tmp/ship-studio-window.png',
      x: 24,
      y: 48,
      width: 400,
      height: 400,
    });
  });

  it('restores the app after a failed native screenshot request', async () => {
    const iframe = document.createElement('iframe');
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: 12,
      y: 24,
      top: 24,
      left: 12,
      right: 212,
      bottom: 224,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    });
    getScreenshotableWindowsMock.mockRejectedValue(new Error('window capture failed'));

    await expect(captureRendererFrameSnapshot('/project', iframe)).rejects.toThrow(
      'window capture failed'
    );
    expect(document.documentElement).not.toHaveClass('component-renderer-snapshot-capture');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('clips an oversized frame to the visible canvas viewport', async () => {
    const viewport = document.createElement('div');
    viewport.className = 'components-workspace__viewport';
    const iframe = document.createElement('iframe');
    viewport.append(iframe);
    document.body.appendChild(viewport);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: -100,
      y: 24,
      top: 24,
      left: -100,
      right: 500,
      bottom: 824,
      width: 600,
      height: 800,
      toJSON: () => ({}),
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 600,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    });

    await captureRendererFrameSnapshot('/project', iframe);

    expect(iframe.parentElement).toBe(viewport);
    expect(invokeMock).toHaveBeenCalledWith('crop_and_save_screenshot', {
      projectPath: '/project',
      sourcePath: '/tmp/ship-studio-window.png',
      x: 0,
      y: 48,
      width: 800,
      height: 1152,
    });
    viewport.remove();
  });

  it('refuses an automatic capture if the frame is no longer fully visible after paint settling', async () => {
    const viewport = document.createElement('div');
    viewport.className = 'components-workspace__viewport';
    const iframe = document.createElement('iframe');
    viewport.append(iframe);
    document.body.appendChild(viewport);
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: -100,
      y: 24,
      top: 24,
      left: -100,
      right: 500,
      bottom: 424,
      width: 600,
      height: 400,
      toJSON: () => ({}),
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 600,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    });

    await expect(
      captureRendererFrameSnapshot('/project', iframe, { requireFullyVisible: true })
    ).rejects.toThrow('moved outside the visible canvas before capture');
    expect(getScreenshotableWindowsMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    viewport.remove();
  });

  it('refuses to crop when the canvas moves while the native screenshot is taken', async () => {
    const viewport = document.createElement('div');
    viewport.className = 'components-workspace__viewport';
    const iframe = document.createElement('iframe');
    viewport.append(iframe);
    document.body.appendChild(viewport);
    const frameRect = vi.spyOn(iframe, 'getBoundingClientRect');
    frameRect.mockReturnValue({
      x: 12,
      y: 24,
      top: 24,
      left: 12,
      right: 212,
      bottom: 224,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 600,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    });
    getWindowScreenshotMock.mockImplementation(() => {
      frameRect.mockReturnValue({
        x: 48,
        y: 24,
        top: 24,
        left: 48,
        right: 248,
        bottom: 224,
        width: 200,
        height: 200,
        toJSON: () => ({}),
      });
      return Promise.resolve('/tmp/ship-studio-window.png');
    });

    await expect(captureRendererFrameSnapshot('/project', iframe)).rejects.toThrow(
      'moved during capture'
    );
    expect(invokeMock).not.toHaveBeenCalled();
    viewport.remove();
  });

  it('refuses an invisible frame before invoking the screenshot API', async () => {
    const iframe = document.createElement('iframe');
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    });

    await expect(captureRendererFrameSnapshot('/project', iframe)).rejects.toThrow(
      'no visible capture bounds'
    );
    expect(getScreenshotableWindowsMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
