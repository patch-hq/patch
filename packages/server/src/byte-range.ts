// `Range: bytes=…` parsing and multipart/byteranges bodies for artifact downloads.

import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

export interface ByteSpan {
  start: number;
  end: number;
}

export type ByteRanges = ByteSpan[] | 'unsatisfiable' | null;

/**
 * `null` means serve the whole file (no header, or a form we don't honour —
 * units other than bytes, a malformed spec; a full 200 is always a valid answer).
 * `'unsatisfiable'` means well-formed ranges that all lie outside the file.
 *
 * Several ranges come back in the order asked, unmerged: electron-updater's
 * differential download sends every changed block in one request and maps the
 * response parts back to its tasks by index. Ranges outside the file are dropped
 * when others survive (RFC 9110 § 14.2).
 */
export function parseByteRanges(header: string | undefined, size: number): ByteRanges {
  const m = /^bytes=(.+)$/.exec(header?.trim() ?? '');
  if (!m) return null;
  const spans: ByteSpan[] = [];
  for (const spec of m[1]!.split(',')) {
    const r = /^(\d*)-(\d*)$/.exec(spec.trim());
    if (!r || (r[1] === '' && r[2] === '')) return null;
    if (r[1] === '') {
      // Suffix range: the last N bytes.
      const n = Number(r[2]);
      if (n === 0 || size === 0) continue;
      spans.push({ start: Math.max(0, size - n), end: size - 1 });
      continue;
    }
    const start = Number(r[1]);
    if (r[2] !== '' && Number(r[2]) < start) return null; // last < first: invalid, not unsatisfiable
    if (start >= size) continue;
    spans.push({ start, end: r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1) });
  }
  return spans.length === 0 ? 'unsatisfiable' : spans;
}

/** A `206 multipart/byteranges` body: its boundary, exact length and stream. */
export function multipartByteRanges(
  file: string,
  spans: ByteSpan[],
  size: number,
  partType: string,
): { boundary: string; length: number; body: Readable } {
  const boundary = `patch-${randomBytes(12).toString('hex')}`;
  const heads = spans.map(
    (s) =>
      `--${boundary}\r\nContent-Type: ${partType}\r\nContent-Range: bytes ${s.start}-${s.end}/${size}\r\n\r\n`,
  );
  const tail = `--${boundary}--\r\n`;
  const length =
    spans.reduce((n, s, i) => n + Buffer.byteLength(heads[i]!) + (s.end - s.start + 1) + 2, 0) +
    Buffer.byteLength(tail);
  async function* parts(): AsyncGenerator<Buffer | string> {
    for (const [i, s] of spans.entries()) {
      yield heads[i]!;
      yield* createReadStream(file, { start: s.start, end: s.end });
      yield '\r\n';
    }
    yield tail;
  }
  return { boundary, length, body: Readable.from(parts()) };
}
