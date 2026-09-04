import type { SourceRef } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Return the number of bytes in a UTF-8 string. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Convert a TypeScript compiler UTF-16 offset to the serialized byte offset. */
export function utf16OffsetToUtf8ByteOffset(content: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= content.length) return utf8ByteLength(content);
  return utf8ByteLength(content.slice(0, offset));
}

/** Convert a serialized byte offset to a UTF-16 offset without splitting UTF-8. */
export function utf8ByteOffsetToUtf16Offset(content: string, byteOffset: number): number | null {
  if (byteOffset < 0) return null;
  const bytes = encoder.encode(content);
  if (byteOffset > bytes.byteLength) return null;
  try {
    const prefix = decoder.decode(bytes.slice(0, byteOffset));
    // A valid prefix must encode to the same byte sequence. This catches an
    // offset in the middle of a multi-byte code point.
    const roundTrip = encoder.encode(prefix);
    if (roundTrip.byteLength !== byteOffset) return null;
    return prefix.length;
  } catch {
    return null;
  }
}

export function sourceRefFromUtf16Range(
  file: string,
  content: string,
  contentHash: string,
  start: number,
  end: number
): SourceRef {
  const safeStart = Math.max(0, Math.min(start, content.length));
  const safeEnd = Math.max(safeStart, Math.min(end, content.length));
  const before = content.slice(0, safeStart);
  const lineStart = before.lastIndexOf('\n') + 1;
  return {
    file,
    start: utf16OffsetToUtf8ByteOffset(content, safeStart),
    end: utf16OffsetToUtf8ByteOffset(content, safeEnd),
    line: before.split('\n').length,
    column: safeStart - lineStart + 1,
    contentHash,
  };
}

/** Read an exact UTF-8-byte source range without splitting a Unicode code point. */
export function sourceTextForRef(content: string, source: SourceRef): string | null {
  const start = utf8ByteOffsetToUtf16Offset(content, source.start);
  const end = utf8ByteOffsetToUtf16Offset(content, source.end);
  if (start === null || end === null || end < start) return null;
  return content.slice(start, end);
}

/** Apply UTF-8-byte edits while preserving every untouched source byte. */
export function applyTextEdits(
  content: string,
  edits: readonly { start: number; end: number; text: string }[]
): string | null {
  const bytes = encoder.encode(content);
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let previousStart = bytes.byteLength;
  for (const edit of ordered) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > bytes.byteLength ||
      edit.end > previousStart
    ) {
      return null;
    }
    if (
      utf8ByteOffsetToUtf16Offset(content, edit.start) === null ||
      utf8ByteOffsetToUtf16Offset(content, edit.end) === null
    ) {
      return null;
    }
    previousStart = edit.start;
  }

  let result = bytes;
  for (const edit of ordered) {
    const replacement = encoder.encode(edit.text);
    const next = new Uint8Array(
      result.byteLength - (edit.end - edit.start) + replacement.byteLength
    );
    next.set(result.slice(0, edit.start), 0);
    next.set(replacement, edit.start);
    next.set(result.slice(edit.end), edit.start + replacement.byteLength);
    result = next;
  }
  try {
    return decoder.decode(result);
  } catch {
    return null;
  }
}

/**
 * Small dependency-free SHA-256 implementation. It is intentionally kept in
 * the app layer so worker tests and packaged WebViews do not need Node's
 * `crypto` module. Hashes are always over UTF-8 bytes.
 */
export function sha256(value: string): string {
  const data = encoder.encode(value);
  const bitLength = data.byteLength * 8;
  const paddedLength = Math.ceil((data.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(schedule[i - 15], 7) ^ rotr(schedule[i - 15], 18) ^ (schedule[i - 15] >>> 3);
      const s1 = rotr(schedule[i - 2], 17) ^ rotr(schedule[i - 2], 19) ^ (schedule[i - 2] >>> 10);
      schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + constants[i] + schedule[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => part.toString(16).padStart(8, '0'))
    .join('');
}
