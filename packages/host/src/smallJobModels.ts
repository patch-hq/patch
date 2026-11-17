// The model the host's small one-shot jobs run on, and what they fall over to
// (spec/02-host.md § Small jobs).
//
// Chat titles, status lines, tool-run labels, send-back summaries, link
// summaries and recurrence translation are all small, cheap, one-shot queries.
// They share one ordered list: the FIRST entry is the set model, every later
// entry is a failover tried in order when the one before it fails. One list for
// all of them, so a retired or overloaded model is changed in one place.
//
import type { RunOnAccountWithCredit } from './accountFailover.js';

// This is a model failover, separate from account failover (accountFailover.ts):
// the account gate picks the credential, this picks the model on that
// credential. Every failed attempt is logged, and when the whole list fails the
// last error is thrown with the models tried — a failover list is a defined
// order, not a way of hiding that the set model stopped working.

// The list is the shared setting `smallJobModels` (wire/events.ts, which also
// holds the default and refuses an empty list or a repeated model); the host
// reads the current value on every job, so an edit applies to the next one.

/**
 * Run `run` on each model in order until one succeeds. A failure moves to the
 * next model; when none succeeds the last error is thrown, naming every model
 * tried, so the caller (and the account gate reading the provider's words)
 * still sees a real failure.
 */
export async function runWithSmallJobModels<T>(
  models: readonly string[],
  label: string,
  run: (model: string) => Promise<T>,
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<T> {
  let last: unknown;
  for (const model of models) {
    try {
      return await run(model);
    } catch (err) {
      last = err;
      logger?.warn({ label, model, err: String(err) }, 'small job failed on model, trying next');
    }
  }
  const reason = last instanceof Error ? last.message : String(last);
  throw new Error(`${label} failed on every small-job model (${models.join(', ')}): ${reason}`, {
    cause: last,
  });
}

/**
 * A small job on the host's account gate AND the small-job model list: the
 * account gate picks the credential, then the models are walked on it.
 */
export function runSmallJob<T>(
  opts: {
    runOnAccountWithCredit: RunOnAccountWithCredit;
    smallJobModels: () => readonly string[];
    logger?: { warn: (obj: object, msg: string) => void } | undefined;
  },
  label: string,
  run: (accessToken: string, model: string) => Promise<T>,
): Promise<T | null> {
  return opts.runOnAccountWithCredit(label, (accessToken) =>
    runWithSmallJobModels(
      opts.smallJobModels(),
      label,
      (model) => run(accessToken, model),
      opts.logger,
    ),
  );
}
