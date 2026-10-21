/**
 * Agent preview bridge — delivering a tool result back to Rust (issue #1128).
 *
 * Why this exists: on macOS, Tauri's invoke sends its arguments as the body of
 * a `fetch` to the `ipc://` custom protocol, and wry (0.53) reads that body
 * from WebKit's `HTTPBodyStream` only `while hasBytesAvailable()`. For a body
 * larger than one stream buffer (~64 KB) the loop can stop before the rest has
 * arrived, so Rust receives a truncated JSON document. A tool result that was
 * cut inside a `\u001b` escape surfaced as "unexpected end of hex escape at
 * line 1 column 65339" — and the agent's call then hung until the bridge
 * timed out.
 *
 * So no single invoke here ever carries more than `MAX_IPC_BODY_BYTES`:
 * - small results go through `agent_bridge_respond` as before;
 * - larger ones are serialized once and sent in pieces through
 *   `agent_bridge_respond_chunk`, which Rust reassembles and parses;
 * - screenshots never cross the IPC as base64 at all — the image item names
 *   the file it was saved to and Rust inlines it (see `captureScreenshot`).
 *
 * And a delivery that still fails answers the agent with an in-band error
 * instead of leaving the call to time out.
 */

import { invoke } from '@tauri-apps/api/core';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';

/** Image content whose bytes Rust reads from `path` before forwarding. */
export interface McpImageFileRef {
  type: 'image';
  mimeType: string;
  path: string;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | McpImageFileRef;

/** MCP CallToolResult — passed back to the agent verbatim (after Rust has
 *  inlined any `McpImageFileRef`). */
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  /** MCP's slot for machine-readable extras; agents ignore it. Remote access
   *  reads `savedPath` from a screenshot taken with `inline: false`. */
  _meta?: Record<string, unknown>;
}

/** Ceiling for one IPC request body, comfortably under the ~64 KB at which
 *  the macOS body stream was observed to be cut. */
export const MAX_IPC_BODY_BYTES = 32 * 1024;

/** UTF-8 bytes `s` occupies once JSON-encoded as a string value (quotes
 *  excluded). Matches what `JSON.stringify` emits for well-formed text. */
function encodedCost(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2; // \" \\
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2;
  if (code < 0x20) return 6; // \u00XX
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3; // BMP; a surrogate pair is costed 4 by the caller
}

export function jsonEncodedBytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
        continue;
      }
    }
    // A lone surrogate is escaped as \uXXXX.
    bytes += code >= 0xd800 && code <= 0xdfff ? 6 : encodedCost(code);
  }
  return bytes;
}

/** Replace unpaired UTF-16 surrogates with U+FFFD. `JSON.stringify` escapes
 *  them as `\udXXX`, which serde_json rejects when building a Rust String —
 *  console output that sliced an emoji in half would otherwise fail the whole
 *  result. */
export function toWellFormed(s: string): string {
  let out: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (out !== null) out += s[i] + s[i + 1];
        i++;
        continue;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      if (out !== null) out += s[i];
      continue;
    }
    out ??= s.slice(0, i);
    out += '�';
  }
  return out ?? s;
}

function sanitizeResult(result: McpToolResult): McpToolResult {
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === 'text' ? { ...item, text: toWellFormed(item.text) } : item
    ),
  };
}

/**
 * Split `s` into pieces that each JSON-encode to at most `maxBytes`, never
 * between the halves of a surrogate pair (a split pair would arrive in Rust
 * as two lone surrogates and fail to decode).
 */
export function splitForIpc(s: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff;
    const cost = isPair ? 4 : code >= 0xd800 && code <= 0xdfff ? 6 : encodedCost(code);
    if (bytes + cost > maxBytes && i > start) {
      chunks.push(s.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += cost;
    if (isPair) i++;
  }
  if (start < s.length || chunks.length === 0) chunks.push(s.slice(start));
  return chunks;
}

/** Room left in a request body for the chunk string after the other args
 *  (`{"requestId":…,"index":…,"total":…,"chunk":"…"}`). */
const CHUNK_ENVELOPE_BYTES = 128;

/** Hand a tool result back to Rust, chunking it when one invoke would be too
 *  large for the IPC transport. Throws if any invoke fails. */
export async function respondToBridgeRequest(
  requestId: number,
  result: McpToolResult
): Promise<void> {
  const clean = sanitizeResult(result);
  const serialized = JSON.stringify(clean);
  // The invoke body is `{"requestId":N,"result":<serialized>}`.
  if (new TextEncoder().encode(serialized).length + CHUNK_ENVELOPE_BYTES <= MAX_IPC_BODY_BYTES) {
    await invoke('agent_bridge_respond', { requestId, result: clean });
    return;
  }
  const chunks = splitForIpc(serialized, MAX_IPC_BODY_BYTES - CHUNK_ENVELOPE_BYTES);
  for (let index = 0; index < chunks.length; index++) {
    await invoke('agent_bridge_respond_chunk', {
      requestId,
      index,
      total: chunks.length,
      chunk: chunks[index],
    });
  }
}

/**
 * Deliver a tool result; if that fails, tell the agent in-band rather than
 * let its call hang until the bridge times out. Never throws.
 */
export async function deliverBridgeResponse(
  requestId: number,
  tool: string,
  result: McpToolResult
): Promise<void> {
  try {
    await respondToBridgeRequest(requestId, result);
    return;
  } catch (err) {
    const detail = formatCommandError(asCommandError(err));
    logger.error('[AgentBridge] Failed to deliver tool response', {
      error: detail,
      tool,
      approxBytes: JSON.stringify(result).length,
    });
    try {
      await respondToBridgeRequest(requestId, {
        content: [
          {
            type: 'text',
            text: `Ship Studio ran ${tool} but could not hand its result back (${detail}). This is a Ship Studio bug, not a problem with the page. Retrying may help; if it keeps failing, narrow the request (e.g. a smaller limit or a more specific selector).`,
          },
        ],
        isError: true,
      });
    } catch (fallbackErr) {
      logger.warn('[AgentBridge] Could not deliver the fallback error either', {
        error: formatCommandError(asCommandError(fallbackErr)),
        tool,
      });
    }
  }
}
