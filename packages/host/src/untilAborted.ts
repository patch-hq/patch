/**
 * How long after an abort the source may still close out the turn. A stopped
 * turn can owe the transcript the result of the tool call it was parked on
 * (the "turn was stopped" / "question was superseded" account the agent reads
 * back); that arrives within milliseconds. Anything slower is the SDK winding
 * down, and Stop does not wait for it.
 */
export const ABORT_SETTLE_MS = 250;

/**
 * Iterate `source`, but stop the moment `signal` aborts instead of waiting for
 * the source to notice. A Stop must cut the turn off at once: the SDK honours
 * an abort only when its current tool call or buffered stream lets it, and
 * every envelope it yields in that window would otherwise still reach the chat.
 *
 * After the abort only `keep`-ed envelopes (tool results) are still delivered,
 * for at most `ABORT_SETTLE_MS`. If the source ends in that window the run
 * completes as it always did; otherwise the source is closed in the background
 * and the abort is thrown, which the caller's user-stop branch treats as a
 * clean stop.
 */
export async function* untilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  keep: (item: T) => boolean = () => false,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const abortError = (): Error => {
    const e = new Error('Request was aborted');
    e.name = 'AbortError';
    return e;
  };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    else {
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  let deadline: Promise<'late'> | undefined;
  try {
    for (;;) {
      const pending = it.next();
      pending.catch(() => undefined);
      const r = await Promise.race([pending, deadline ?? aborted]);
      if (r === 'aborted') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        deadline = new Promise<'late'>((resolve) => {
          timer = setTimeout(() => resolve('late'), ABORT_SETTLE_MS);
        });
        deadline.then(() => clearTimeout(timer));
        const settled = await Promise.race([pending, deadline]);
        if (settled === 'late') throw abortError();
        clearTimeout(timer);
        if (settled.done === true) return;
        if (keep(settled.value)) yield settled.value;
        continue;
      }
      if (r === 'late') throw abortError();
      if (r.done === true) return;
      if (!signal.aborted || keep(r.value)) yield r.value;
    }
  } catch (err) {
    if (signal.aborted) void Promise.resolve(it.return?.()).catch(() => undefined);
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
