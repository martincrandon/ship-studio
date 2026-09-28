import { invoke } from '@tauri-apps/api/core';
import { isMac } from '../setup';

interface RendererScreenshotWindow {
  id: number | string;
  title?: string;
}

interface RendererScreenshotApi {
  getScreenshotableWindows: () => Promise<RendererScreenshotWindow[]>;
  getWindowScreenshot: (windowId: number | string) => Promise<string>;
}

const SNAPSHOT_CAPTURE_CLASS = 'component-renderer-snapshot-capture';
let activeSnapshotCaptureCount = 0;

function waitForPaint(): Promise<void> {
  if (typeof window.requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function beginSnapshotCapture(): () => void {
  const root = document.documentElement;
  activeSnapshotCaptureCount += 1;
  root.classList.add(SNAPSHOT_CAPTURE_CLASS);
  return () => {
    activeSnapshotCaptureCount = Math.max(0, activeSnapshotCaptureCount - 1);
    if (activeSnapshotCaptureCount === 0) root.classList.remove(SNAPSHOT_CAPTURE_CLASS);
  };
}

function isUsableRect(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function isFullyVisibleFrame(frame: HTMLIFrameElement): boolean {
  if (!frame.isConnected) return false;
  const frameRect = frame.getBoundingClientRect();
  if (!isUsableRect(frameRect)) return false;
  const viewport = frame.closest<HTMLElement>('.components-workspace__viewport');
  if (!viewport) return true;
  const viewportRect = viewport.getBoundingClientRect();
  const tolerance = 1;
  return (
    frameRect.left >= viewportRect.left - tolerance &&
    frameRect.top >= viewportRect.top - tolerance &&
    frameRect.right <= viewportRect.right + tolerance &&
    frameRect.bottom <= viewportRect.bottom + tolerance
  );
}

function sameRect(left: DOMRect, right: DOMRect): boolean {
  const tolerance = 1;
  return (
    Math.abs(left.left - right.left) <= tolerance &&
    Math.abs(left.top - right.top) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

/**
 * The screenshot API captures the whole Ship Studio window, not an iframe.
 * Clip the crop to the canvas viewport so an oversized frame cannot extend
 * into the surrounding Ship Studio chrome.
 */
function visibleFrameRect(frame: HTMLIFrameElement): DOMRect {
  const rect = frame.getBoundingClientRect();
  const viewport = frame.closest<HTMLElement>('.components-workspace__viewport');
  if (!viewport) return rect;
  const viewportRect = viewport.getBoundingClientRect();
  const left = Math.max(rect.left, viewportRect.left);
  const top = Math.max(rect.top, viewportRect.top);
  const right = Math.min(rect.right, viewportRect.right);
  const bottom = Math.min(rect.bottom, viewportRect.bottom);
  return {
    ...rect,
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  } as DOMRect;
}

async function captureShipStudioWindow(): Promise<string> {
  const api = (await import('tauri-plugin-screenshots-api')) as RendererScreenshotApi;
  const windows = await api.getScreenshotableWindows();
  const appWindow = windows.find((candidate) => {
    const title = candidate.title?.toLowerCase() ?? '';
    return title.includes('ship studio') || title.includes('tauri');
  });
  if (!appWindow) {
    throw new Error(
      isMac()
        ? "Ship Studio's window isn't visible to macOS screen capture. Allow Screen Recording permission, then try again."
        : "Ship Studio's window wasn't found in the list of capturable windows."
    );
  }
  return api.getWindowScreenshot(appWindow.id);
}

/**
 * Capture the visible active renderer frame through Ship Studio's existing
 * screenshot pipeline. The returned path is created by the Tauri crop command;
 * no screenshot bytes are retained in the renderer or browser storage.
 */
export async function captureRendererFrameSnapshot(
  projectPath: string,
  frame: HTMLIFrameElement,
  options: { requireFullyVisible?: boolean } = {}
): Promise<string> {
  const endSnapshotCapture = beginSnapshotCapture();
  try {
    // Let the temporary capture stylesheet hide parent canvas chrome before
    // the native window screenshot is taken. Two frames also avoid sampling a
    // half-committed React handoff between a live iframe and its poster.
    await waitForPaint();
    await waitForPaint();

    const rect = visibleFrameRect(frame);
    if (!isUsableRect(rect)) {
      throw new Error('The active renderer frame has no visible capture bounds.');
    }
    if (options.requireFullyVisible && !isFullyVisibleFrame(frame)) {
      throw new Error('The active renderer frame moved outside the visible canvas before capture.');
    }

    const sourcePath = await captureShipStudioWindow();
    const currentRect = visibleFrameRect(frame);
    if (!isUsableRect(currentRect) || !sameRect(rect, currentRect)) {
      throw new Error('The active renderer frame moved during capture.');
    }
    if (options.requireFullyVisible && !isFullyVisibleFrame(frame)) {
      throw new Error('The active renderer frame moved outside the visible canvas during capture.');
    }
    const devicePixelRatio = window.devicePixelRatio || 1;
    return await invoke<string>('crop_and_save_screenshot', {
      projectPath,
      sourcePath,
      x: Math.round(rect.left * devicePixelRatio),
      // Ship Studio uses an overlay titlebar on macOS, so the webview and
      // native window screenshot share the same top-left origin. Adding a
      // titlebar height here shifts the crop into the canvas below the frame.
      y: Math.round(rect.top * devicePixelRatio),
      width: Math.round(rect.width * devicePixelRatio),
      height: Math.round(rect.height * devicePixelRatio),
    });
  } finally {
    endSnapshotCapture();
  }
}
