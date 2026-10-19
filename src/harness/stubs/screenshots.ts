/** Native screenshot plugin; inert in the browser harness. */
export function screenshot(): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array());
}

export interface ScreenshotableWindow {
  id: number;
  name: string;
  title: string;
  appName: string;
}

export function getScreenshotableWindows(): Promise<ScreenshotableWindow[]> {
  // A browser harness has no native Ship Studio window to capture.
  return Promise.resolve([]);
}

export function getWindowScreenshot(_id: number): Promise<string> {
  return Promise.reject(
    new Error('Native screenshot capture is unavailable in the browser harness.')
  );
}

export default { screenshot, getScreenshotableWindows, getWindowScreenshot };
