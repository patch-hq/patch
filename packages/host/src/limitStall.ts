// A provider that has run out of usage does not always end the turn. Claude Code
// reports the window as `rejected` and then goes quiet, retrying against a limit
// that will not lift for hours, and patch showed the chat as running until
// something else gave up. This ends such a turn as the stated limit it is.

import { TurnFailedError } from './sdkBackend.js';
import type { LimitFacts, SdkEnvelope } from './sdkBackend.js';
import { limitFailureMessage } from './limitFailure.js';

/**
 * How long a rejected window may be followed by nothing real before the turn is
 * failed. Long enough for an overage pool to take over and carry on (which shows
 * as output and cancels the wait), short enough that nobody sits watching.
 */
export const LIMIT_STALL_GRACE_MS = 20_000;

const TYPE_OF_SCOPE = { session: 'five_hour', week: 'seven_day' } as const;

const STALLED = Symbol('limit-stall');

/**
 * Pass `source` through, but fail it with a stated limit if a `rejected` window
 * arrives and no real output (anything but a `system` envelope — retry notices
 * are system) follows within `graceMs`.
 */
export async function* withLimitStall(
  source: AsyncIterable<SdkEnvelope>,
  graceMs: number = LIMIT_STALL_GRACE_MS,
): AsyncGenerator<SdkEnvelope> {
  const it = source[Symbol.asyncIterator]();
  let facts: LimitFacts | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled: Promise<typeof STALLED> | undefined;
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stalled = undefined;
  };
  try {
    for (;;) {
      const pending = it.next();
      pending.catch(() => undefined);
      const r = await (stalled === undefined ? pending : Promise.race([pending, stalled]));
      if (r === STALLED) {
        void Promise.resolve(it.return?.()).catch(() => undefined);
        const stated = { facts: facts ?? {}, from: 'structured' as const };
        throw new TurnFailedError(limitFailureMessage(stated), facts);
      }
      if (r.done === true) return;
      const env = r.value;
      const window = env.rateLimit?.window;
      if (env.rateLimit !== undefined && window?.status === 'rejected') {
        facts = {
          kind: 'rate_limit',
          status: 'rejected',
          rateLimitType: TYPE_OF_SCOPE[env.rateLimit.scope],
          ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
        };
        disarm();
        stalled = new Promise<typeof STALLED>((resolve) => {
          timer = setTimeout(() => resolve(STALLED), graceMs);
        });
      } else if (env.type !== 'system') {
        disarm();
      }
      yield env;
    }
  } finally {
    disarm();
  }
}
