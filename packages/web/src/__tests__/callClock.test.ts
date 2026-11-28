// lib/callClock.ts — the call's clock on web and desktop keeps its timers in a
// dedicated worker, so they fire with the tab in the background (spec/07 § A
// call keeps going in the background). jsdom has no Worker; this drives the
// real module against a stand-in that runs the worker's own source.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Runs the worker source the module hands to `new Worker`, on this thread's timers. */
class SourceWorker {
  static last: SourceWorker | null = null;
  onmessage: ((e: MessageEvent<number>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  private inner: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
  constructor(url: string) {
    const source = SourceWorker.sources.get(url);
    if (source === undefined) throw new Error(`no worker source behind ${url}`);
    const post = (data: number): void => this.onmessage?.({ data } as MessageEvent<number>);
    // The worker's globals: onmessage (assigned by the source) and postMessage.
    new Function('self', 'postMessage', `with (self) { ${source} }`)(this.inner, post);
    SourceWorker.last = this;
  }
  postMessage(data: unknown): void {
    this.posted.push(data);
    this.inner.onmessage?.({ data });
  }
  static sources = new Map<string, string>();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.doUnmock('../lib/callClock.js');
  let n = 0;
  vi.stubGlobal('Worker', SourceWorker);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob & { text?: () => Promise<string> }) => {
      const url = `blob:clock-${n++}`;
      // jsdom Blobs read synchronously through the module's own string.
      SourceWorker.sources.set(url, (blob as unknown as { __source: string }).__source);
      return url;
    },
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal(
    'Blob',
    class {
      __source: string;
      constructor(parts: string[]) {
        this.__source = parts.join('');
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('callClock', () => {
  it('fires a timer from the worker, once', async () => {
    const { callClock } = await import('../lib/callClock.js');
    const fn = vi.fn();
    callClock.setTimeout(fn, 3000);
    expect(SourceWorker.last!.posted).toEqual([{ op: 'set', id: 1, ms: 3000 }]);
    vi.advanceTimersByTime(2999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a cleared timer is cleared in the worker and never fires', async () => {
    const { callClock } = await import('../lib/callClock.js');
    const fn = vi.fn();
    const h = callClock.setTimeout(fn, 1000);
    callClock.clearTimeout(h);
    expect(SourceWorker.last!.posted.at(-1)).toEqual({ op: 'clear', id: h });
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('there is no call clock without a Worker (NO FALLBACK)', async () => {
    vi.stubGlobal('Worker', undefined);
    const { callClock } = await import('../lib/callClock.js');
    expect(() => callClock.setTimeout(() => undefined, 1)).toThrow(/no Worker/);
  });
});
