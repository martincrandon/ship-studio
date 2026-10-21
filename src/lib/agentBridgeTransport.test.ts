import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]): Promise<unknown> => invokeMock(...args),
}));

vi.mock('./logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  MAX_IPC_BODY_BYTES,
  deliverBridgeResponse,
  jsonEncodedBytes,
  respondToBridgeRequest,
  splitForIpc,
  toWellFormed,
  type McpToolResult,
} from './agentBridgeTransport';
import { logger } from './logger';

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** What would actually be the IPC body for one invoke call. */
const bodyBytes = (args: unknown) => utf8(JSON.stringify(args));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe('jsonEncodedBytes', () => {
  it('matches the UTF-8 length of JSON.stringify (minus quotes)', () => {
    for (const s of ['plain', 'a"b\\c\n\t', '\u001b[31mred', 'rød 日本 🚀', '\u0000\u0007']) {
      expect(jsonEncodedBytes(s)).toBe(utf8(JSON.stringify(s)) - 2);
    }
  });
});

describe('toWellFormed', () => {
  it('replaces lone surrogates and keeps pairs', () => {
    expect(toWellFormed('ok 🚀')).toBe('ok 🚀');
    expect(toWellFormed('a\ud83db')).toBe('a�b');
    expect(toWellFormed('\ude80x')).toBe('�x');
    expect(toWellFormed('end\ud83d')).toBe('end�');
  });
});

describe('splitForIpc', () => {
  it('keeps every chunk under the budget and rejoins losslessly', () => {
    const s = JSON.stringify({ text: '\u001b[2m🚀 "quoted" rød\n'.repeat(5000) });
    const chunks = splitForIpc(s, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(s);
    for (const c of chunks) expect(utf8(JSON.stringify(c)) - 2).toBeLessThanOrEqual(4096);
  });

  it('never splits a surrogate pair', () => {
    const s = '🚀'.repeat(1000);
    for (const c of splitForIpc(s, 10)) {
      expect(toWellFormed(c)).toBe(c);
    }
  });

  it('returns one (possibly empty) chunk for short input', () => {
    expect(splitForIpc('', 10)).toEqual(['']);
    expect(splitForIpc('abc', 10)).toEqual(['abc']);
  });
});

describe('respondToBridgeRequest', () => {
  it('sends a small result in one agent_bridge_respond call', async () => {
    const result: McpToolResult = { content: [{ type: 'text', text: 'hi' }] };
    await respondToBridgeRequest(1, result);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('agent_bridge_respond', { requestId: 1, result });
  });

  it('chunks a large result so no IPC body exceeds the limit (#1128)', async () => {
    // Console output full of ANSI escapes: what was cut inside "\u001b".
    const big = '\u001b[31merror\u001b[0m rød 🚀 '.repeat(20_000);
    const result: McpToolResult = { content: [{ type: 'text', text: big }] };
    await respondToBridgeRequest(7, result);

    const calls = invokeMock.mock.calls as [string, Record<string, unknown>][];
    expect(calls.length).toBeGreaterThan(1);
    for (const [cmd, args] of calls) {
      expect(cmd).toBe('agent_bridge_respond_chunk');
      expect(bodyBytes(args)).toBeLessThanOrEqual(MAX_IPC_BODY_BYTES);
    }
    calls.forEach(([, args], i) => {
      expect(args).toMatchObject({ requestId: 7, index: i, total: calls.length });
    });
    const joined = calls.map(([, args]) => args.chunk as string).join('');
    expect(JSON.parse(joined)).toEqual(result);
  });

  it('replaces lone surrogates that serde_json would reject', async () => {
    await respondToBridgeRequest(2, { content: [{ type: 'text', text: 'cut \ud83d' }] });
    expect(invokeMock).toHaveBeenCalledWith('agent_bridge_respond', {
      requestId: 2,
      result: { content: [{ type: 'text', text: 'cut �' }] },
    });
  });
});

describe('deliverBridgeResponse', () => {
  it('answers the agent in-band when delivery fails, and logs the tool', async () => {
    (logger.error as ReturnType<typeof vi.fn>).mockClear();
    invokeMock.mockRejectedValueOnce(new Error('unexpected end of hex escape'));
    invokeMock.mockResolvedValueOnce(undefined);

    await deliverBridgeResponse(3, 'preview_console', {
      content: [{ type: 'text', text: 'log' }],
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    const [cmd, args] = invokeMock.mock.calls[1] as [string, { result: McpToolResult }];
    expect(cmd).toBe('agent_bridge_respond');
    expect(args.result.isError).toBe(true);
    expect(JSON.stringify(args.result)).toContain('preview_console');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error).toHaveBeenCalledWith(
      '[AgentBridge] Failed to deliver tool response',
      expect.objectContaining({ tool: 'preview_console' })
    );
  });

  it('never throws even if the fallback fails too', async () => {
    invokeMock.mockRejectedValue(new Error('down'));
    await expect(
      deliverBridgeResponse(4, 'preview_dom', { content: [{ type: 'text', text: 'x' }] })
    ).resolves.toBeUndefined();
  });
});
