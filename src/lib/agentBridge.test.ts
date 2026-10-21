import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]): Promise<unknown> => invokeMock(...args),
}));

vi.mock('./logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  executeBridgeTool,
  isValidPreviewPath,
  overlayFraction,
  registerPreviewMcpServer,
  type BridgeToolContext,
} from './agentBridge';
import { logger } from './logger';

type Fn = ReturnType<typeof vi.fn>;

const makeCtx = (overrides: Partial<BridgeToolContext> = {}): BridgeToolContext => ({
  projectPath: '/Users/me/ShipStudio/site',
  getCurrentUrl: () => 'http://localhost:4173/',
  serverReady: true,
  currentPath: '/',
  pages: ['/', '/about'],
  navigate: vi.fn(),
  reload: vi.fn(),
  setViewport: vi.fn(),
  getViewportWidth: () => null,
  canvasMode: false,
  getOverlayFrameSize: () => null,
  ...overrides,
});

beforeEach(() => {
  invokeMock.mockReset();
});

describe('overlayFraction', () => {
  const rect = { x: 100, y: 4000, w: 200, h: 100, fx: 0.5, fy: 1 };

  it('trusts the page when the host has no frame size (focus mode)', () => {
    expect(overlayFraction(rect, null)).toEqual({ fx: 0.5, fy: 1 });
  });

  it('re-derives from raw pixels against the canvas frame', () => {
    // The page reported fy: 1 — clamped, because on the canvas its own
    // viewport is a 900px device fiction while the frame is 6000px of page.
    // The cursor belongs two thirds down, not pinned to the bottom edge.
    expect(overlayFraction(rect, { w: 1200, h: 6000 })).toEqual({
      fx: 200 / 1200,
      fy: 4050 / 6000,
    });
  });

  it('falls back to the page fractions before the stage has been measured', () => {
    expect(overlayFraction(rect, { w: 1200, h: 0 })).toEqual({ fx: 0.5, fy: 1 });
  });

  it('clamps a rect that sits outside the frame', () => {
    expect(overlayFraction({ ...rect, y: -500 }, { w: 1200, h: 6000 })).toEqual({
      fx: 200 / 1200,
      fy: 0,
    });
  });
});

describe('isValidPreviewPath', () => {
  it('accepts in-app absolute paths', () => {
    expect(isValidPreviewPath('/')).toBe(true);
    expect(isValidPreviewPath('/about')).toBe(true);
    expect(isValidPreviewPath('/blog/post-1?tab=2')).toBe(true);
  });

  it('rejects full URLs, protocol-relative URLs, and relative paths', () => {
    expect(isValidPreviewPath('https://evil.com')).toBe(false);
    expect(isValidPreviewPath('//evil.com')).toBe(false);
    expect(isValidPreviewPath('about')).toBe(false);
    expect(isValidPreviewPath('/foo/https://x')).toBe(false);
    expect(isValidPreviewPath(42)).toBe(false);
    expect(isValidPreviewPath(undefined)).toBe(false);
  });
});

describe('executeBridgeTool', () => {
  it('returns console output as text (empty store)', async () => {
    const result = await executeBridgeTool({ requestId: 1, tool: 'preview_console' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('console');
  });

  it('returns network output as text (empty store)', async () => {
    const result = await executeBridgeTool(
      { requestId: 2, tool: 'preview_network', arguments: { failed_only: true } },
      makeCtx()
    );
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('network');
  });

  it('navigates on a valid path and tells the agent', async () => {
    const ctx = makeCtx();
    const result = await executeBridgeTool(
      { requestId: 3, tool: 'preview_navigate', arguments: { path: '/pricing' } },
      ctx
    );
    expect(ctx.navigate).toHaveBeenCalledWith('/pricing');
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('/pricing');
  });

  it('rejects navigation to a full URL without navigating', async () => {
    const ctx = makeCtx();
    const result = await executeBridgeTool(
      { requestId: 4, tool: 'preview_navigate', arguments: { path: 'https://evil.com' } },
      ctx
    );
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('reloads the preview', async () => {
    const ctx = makeCtx();
    const result = await executeBridgeTool({ requestId: 5, tool: 'preview_reload' }, ctx);
    expect(ctx.reload).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('preview_status reports server, page, and route info', async () => {
    const result = await executeBridgeTool({ requestId: 20, tool: 'preview_status' }, makeCtx());
    const report = (result.content[0] as { text: string }).text;
    expect(result.isError).toBeUndefined();
    expect(report).toContain('running');
    expect(report).toContain('/about');
    expect(report).toContain('Console:');
  });

  it('preview_status tells the agent when the dev server is down', async () => {
    const result = await executeBridgeTool(
      { requestId: 21, tool: 'preview_status' },
      makeCtx({ serverReady: false })
    );
    expect((result.content[0] as { text: string }).text).toContain('NOT running');
  });

  it('preview_click without a selector errors in-band', async () => {
    const result = await executeBridgeTool({ requestId: 22, tool: 'preview_click' }, makeCtx());
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('selector');
  });

  it('preview_type without a value errors in-band', async () => {
    const result = await executeBridgeTool(
      { requestId: 23, tool: 'preview_type', arguments: { selector: 'input' } },
      makeCtx()
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('value');
  });

  it('preview_set_viewport applies presets and clamps pixel widths', async () => {
    const ctx = makeCtx();
    await executeBridgeTool(
      { requestId: 30, tool: 'preview_set_viewport', arguments: { preset: 'mobile' } },
      ctx
    );
    expect(ctx.setViewport).toHaveBeenCalledWith('mobile');
    await executeBridgeTool(
      { requestId: 31, tool: 'preview_set_viewport', arguments: { width: 50 } },
      ctx
    );
    expect(ctx.setViewport).toHaveBeenCalledWith(200);
    const bad = await executeBridgeTool(
      { requestId: 32, tool: 'preview_set_viewport', arguments: { preset: 'watch' } },
      ctx
    );
    expect(bad.isError).toBe(true);
  });

  it('preview_status tells the agent the breakpoint canvas is open', async () => {
    const result = await executeBridgeTool(
      { requestId: 24, tool: 'preview_status' },
      makeCtx({ canvasMode: true, getViewportWidth: () => 1024 })
    );
    const report = (result.content[0] as { text: string }).text;
    // Without this the agent reads a plain width, calls preview_set_viewport
    // to "test a breakpoint", and silently collapses the user's canvas.
    expect(report).toContain('breakpoint canvas is open');
    expect(report).toContain('1024px frame active');
    expect(report).toContain('CLOSES the canvas');
  });

  it('preview_set_viewport says so when it closed the canvas', async () => {
    const onCanvas = await executeBridgeTool(
      { requestId: 33, tool: 'preview_set_viewport', arguments: { preset: 'mobile' } },
      makeCtx({ canvasMode: true })
    );
    expect((onCanvas.content[0] as { text: string }).text).toContain(
      'closed the breakpoint canvas'
    );

    const offCanvas = await executeBridgeTool(
      { requestId: 34, tool: 'preview_set_viewport', arguments: { width: 900 } },
      makeCtx()
    );
    expect((offCanvas.content[0] as { text: string }).text).not.toContain('breakpoint canvas');
  });

  it('screenshot captures at the preview viewport width', async () => {
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'capture_viewport_playwright')
        return Promise.resolve('/proj/.shipstudio/screenshots/s.png');
      return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
    });
    await executeBridgeTool(
      { requestId: 33, tool: 'preview_screenshot' },
      makeCtx({ getViewportWidth: () => 375 })
    );
    expect(invokeMock).toHaveBeenCalledWith(
      'capture_viewport_playwright',
      expect.objectContaining({ width: 375 })
    );
  });

  it('warns instead of erroring when a capture races a dev-server restart (#735)', async () => {
    (logger.warn as Fn).mockClear();
    (logger.error as Fn).mockClear();
    invokeMock.mockRejectedValue({
      type: 'Other',
      message:
        'The dev server at http://localhost:4173/ stopped responding while the screenshot was being captured. Wait for the preview to finish reloading, then try again.',
    });
    const result = await executeBridgeTool(
      { requestId: 40, tool: 'preview_screenshot' },
      makeCtx()
    );

    // The agent still sees the failure…
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('stopped responding');
    // …but logger.error would auto-file a bug report for an Expected race.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalledWith(
      '[AgentBridge] Tool execution failed',
      expect.objectContaining({ tool: 'preview_screenshot' })
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('warns for any backend-Expected failure via the IPC flag (issue #872)', async () => {
    (logger.warn as Fn).mockClear();
    (logger.error as Fn).mockClear();
    invokeMock.mockRejectedValue({
      type: 'Other',
      expected: true,
      message:
        "The page at http://localhost:49765 didn't finish loading in time for the screenshot — the dev server is probably still compiling this route.",
    });
    const result = await executeBridgeTool(
      { requestId: 42, tool: 'preview_screenshot' },
      makeCtx()
    );
    expect(result.isError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalledWith(
      '[AgentBridge] Tool execution failed',
      expect.objectContaining({ tool: 'preview_screenshot' })
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('still errors on an unclassified tool failure', async () => {
    (logger.error as Fn).mockClear();
    invokeMock.mockRejectedValue(new Error('kaboom'));
    const result = await executeBridgeTool(
      { requestId: 41, tool: 'preview_screenshot' },
      makeCtx()
    );

    expect(result.isError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).toHaveBeenCalledWith(
      '[AgentBridge] Tool execution failed',
      expect.objectContaining({ tool: 'preview_screenshot' })
    );
  });

  it('returns an isError result for unknown tools', async () => {
    const result = await executeBridgeTool({ requestId: 6, tool: 'preview_dance' }, makeCtx());
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('preview_dance');
  });

  it('screenshot errors in-band when the preview is not running', async () => {
    const ctx = makeCtx({ getCurrentUrl: () => null });
    const result = await executeBridgeTool({ requestId: 7, tool: 'preview_screenshot' }, ctx);
    expect(result.isError).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('screenshot references the saved file instead of inlining base64 (#1128)', async () => {
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'capture_viewport_playwright')
        return Promise.resolve('/proj/.shipstudio/screenshots/s.png');
      return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
    });
    const result = await executeBridgeTool({ requestId: 8, tool: 'preview_screenshot' }, makeCtx());
    expect(result.isError).toBeUndefined();
    // Rust inlines the bytes from the path; no base64 crosses the IPC.
    expect(result.content[0]).toEqual({
      type: 'image',
      path: '/proj/.shipstudio/screenshots/s.png',
      mimeType: 'image/png',
    });
    expect(invokeMock).not.toHaveBeenCalledWith('get_screenshot_base64', expect.anything());
    expect((result.content[1] as { text: string }).text).toContain('s.png');
  });

  it('screenshot uses the fullpage command when full_page is true', async () => {
    invokeMock.mockImplementation((cmd: unknown) => {
      if (cmd === 'capture_fullpage_playwright')
        return Promise.resolve('/proj/.shipstudio/screenshots/f.png');
      return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
    });
    const result = await executeBridgeTool(
      { requestId: 9, tool: 'preview_screenshot', arguments: { full_page: true } },
      makeCtx()
    );
    expect(result.isError).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('capture_fullpage_playwright', expect.anything());
  });

  it('converts thrown command errors into verbose isError results', async () => {
    invokeMock.mockRejectedValue(new Error('Playwright screenshot failed. stderr: boom'));
    const result = await executeBridgeTool(
      { requestId: 10, tool: 'preview_screenshot' },
      makeCtx()
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('boom');
  });
});

describe('registerPreviewMcpServer', () => {
  it('removes any stale registration, then adds with http transport at local scope', async () => {
    invokeMock.mockResolvedValue(undefined);
    await registerPreviewMcpServer('http://127.0.0.1:4123/mcp/abc', '/Users/me/ShipStudio/site');
    expect(invokeMock).toHaveBeenCalledWith('remove_mcp_server', {
      name: 'shipstudio-preview',
      scope: 'local',
      projectPath: '/Users/me/ShipStudio/site',
      agentId: 'claude-code',
    });
    expect(invokeMock).toHaveBeenCalledWith('add_mcp_server', {
      rawArgs: '--transport http shipstudio-preview http://127.0.0.1:4123/mcp/abc',
      scope: 'local',
      projectPath: '/Users/me/ShipStudio/site',
      agentId: 'claude-code',
    });
  });

  it('still adds when the stale removal fails (nothing registered yet)', async () => {
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === 'remove_mcp_server'
        ? Promise.reject(new Error('No MCP server found'))
        : Promise.resolve(undefined)
    );
    await expect(registerPreviewMcpServer('http://127.0.0.1:4123/mcp/abc', '/p')).resolves.toBe(
      true
    );
    expect(invokeMock).toHaveBeenCalledWith('add_mcp_server', expect.anything());
  });

  it('treats an enterprise-policy denial as terminal: warns, caches, stops retrying (issue #675)', async () => {
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === 'add_mcp_server'
        ? Promise.reject(
            // Exact CLI wording from issue #675, as wrapped by add_mcp_server.
            new Error(
              'Failed to add MCP server: Cannot add MCP server "shipstudio-preview": not allowed by enterprise policy'
            )
          )
        : Promise.resolve(undefined)
    );
    await expect(
      registerPreviewMcpServer('http://127.0.0.1:4123/mcp/abc', '/policy-blocked')
    ).resolves.toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the mock, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalledWith(
      expect.stringContaining('enterprise policy'),
      expect.anything()
    );
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'add_mcp_server')).toHaveLength(1);

    // A later attach with the same URL must not re-run the CLI at all.
    invokeMock.mockClear();
    await expect(
      registerPreviewMcpServer('http://127.0.0.1:4123/mcp/abc', '/policy-blocked')
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('still rejects on unrecognized add failures', async () => {
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === 'add_mcp_server'
        ? Promise.reject(new Error('Failed to add MCP server: disk exploded'))
        : Promise.resolve(undefined)
    );
    await expect(
      registerPreviewMcpServer('http://127.0.0.1:4123/mcp/abc', '/still-broken')
    ).rejects.toThrow('disk exploded');
  });
});
