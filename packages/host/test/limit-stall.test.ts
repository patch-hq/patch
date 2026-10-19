// A provider that has run out of usage can leave the turn hanging: Claude Code
// reports the window as `rejected` and then goes quiet while it retries against
// a limit that will not lift for hours. Patch used to wait for something else to
// end the turn; it now fails it as a stated limit shortly after the rejection.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { withLimitStall, LIMIT_STALL_GRACE_MS } from '../src/limitStall.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

const RESETS_AT = 1_800_000_000_000;

const rejected = (scope: 'session' | 'week' = 'session'): SdkEnvelope => ({
  type: 'system',
  rateLimit: { scope, window: { status: 'rejected', utilization: 1, resetsAt: RESETS_AT } },
  raw: {},
});
const allowed = (): SdkEnvelope => ({
  type: 'system',
  rateLimit: { scope: 'session', window: { status: 'allowed', utilization: 0.2 } },
  raw: {},
});
const assistant = (): SdkEnvelope => ({ type: 'assistant', content: 'hi', raw: {} });
const retryNotice = (): SdkEnvelope => ({ type: 'system', raw: { subtype: 'api_retry' } });

/** A source that yields `items`, then hangs until it is closed. */
function hangingSource(items: SdkEnvelope[]) {
  const state = { closed: false };
  const source: AsyncGenerator<SdkEnvelope> = {
    async next() {
      const item = items.shift();
      if (item !== undefined) return { value: item, done: false };
      return new Promise(() => undefined);
    },
    async return() {
      state.closed = true;
      return { value: undefined, done: true };
    },
    async throw(e) {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<SdkEnvelope>;
  return { source, state };
}

async function drain(gen: AsyncIterable<SdkEnvelope>): Promise<SdkEnvelope[]> {
  const out: SdkEnvelope[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => vi.useRealTimers());

describe('withLimitStall', () => {
  it('fails the turn as a stated limit when a rejected window is followed by silence', async () => {
    vi.useFakeTimers();
    const { source, state } = hangingSource([rejected()]);
    const p = drain(withLimitStall(source)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LIMIT_STALL_GRACE_MS + 1);
    const err = await p;
    expect(err).toBeInstanceOf(TurnFailedError);
    const e = err as TurnFailedError;
    expect(e.limit).toMatchObject({
      kind: 'rate_limit',
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: RESETS_AT,
    });
    expect(e.message).toMatch(/usage limit/i);
    expect(state.closed).toBe(true);
  });

  it('names the weekly window for a weekly rejection', async () => {
    vi.useFakeTimers();
    const { source } = hangingSource([rejected('week')]);
    const p = drain(withLimitStall(source)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LIMIT_STALL_GRACE_MS + 1);
    expect(((await p) as TurnFailedError).limit?.rateLimitType).toBe('seven_day');
  });

  it('does not fire before the grace period is over', async () => {
    vi.useFakeTimers();
    const { source, state } = hangingSource([rejected()]);
    let settled = false;
    void drain(withLimitStall(source)).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(LIMIT_STALL_GRACE_MS - 1000);
    expect(settled).toBe(false);
    expect(state.closed).toBe(false);
  });

  it('is cancelled by real output: an overage pool that carries on is not a failure', async () => {
    vi.useFakeTimers();
    const { source } = hangingSource([rejected(), assistant()]);
    let settled = false;
    void drain(withLimitStall(source)).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(LIMIT_STALL_GRACE_MS * 10);
    expect(settled).toBe(false);
  });

  it('is not cancelled by retry chatter, which is not progress', async () => {
    vi.useFakeTimers();
    const { source } = hangingSource([rejected(), retryNotice(), retryNotice()]);
    const p = drain(withLimitStall(source)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LIMIT_STALL_GRACE_MS + 1);
    expect(await p).toBeInstanceOf(TurnFailedError);
  });

  it('never fires on an allowed window, however long the turn is quiet', async () => {
    vi.useFakeTimers();
    const { source } = hangingSource([allowed()]);
    let settled = false;
    void drain(withLimitStall(source)).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(LIMIT_STALL_GRACE_MS * 100);
    expect(settled).toBe(false);
  });

  it('passes every envelope through unchanged and ends when the source ends', async () => {
    const items = [allowed(), assistant(), { type: 'result', raw: {} } as SdkEnvelope];
    async function* src() {
      yield* items;
    }
    expect(await drain(withLimitStall(src()))).toEqual(items);
  });

  it('honours a custom grace period', async () => {
    vi.useFakeTimers();
    const { source } = hangingSource([rejected()]);
    const p = drain(withLimitStall(source, 500)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(501);
    expect(await p).toBeInstanceOf(TurnFailedError);
  });

  it('propagates a source error untouched', async () => {
    async function* src(): AsyncGenerator<SdkEnvelope> {
      yield rejected();
      throw new Error('boom');
    }
    await expect(drain(withLimitStall(src()))).rejects.toThrow('boom');
  });
});
