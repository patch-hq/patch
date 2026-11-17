// Bounded shutdown steps (spec/02 § Restarting the host).
//
// Every close the host does on the way down can wait on something outside it:
// a peer that never answers a close handshake, a request that never finishes, a
// transcription still running. Run one after another with no limit, the first
// that waits holds up every one behind it and the whole shutdown runs into the
// hard deadline (`shutdownDeadline.ts`). Here the steps of a phase run together
// and each gets its own budget, so the phase takes as long as its slowest
// well-behaved step, a step that overruns is named in the log, and nothing
// waits on it any longer.

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
}

export interface StepReport {
  name: string;
  ms: number;
  /** The step was still going when its budget ran out and was abandoned. */
  overran: boolean;
  /** The step threw or rejected. */
  error?: string;
}

/** How long one shutdown step may take before it is abandoned. */
export const STEP_BUDGET_MS = 2_000;

export async function runShutdownSteps(
  steps: ShutdownStep[],
  opts: {
    budgetMs?: number;
    log?: (report: StepReport) => void;
  } = {},
): Promise<StepReport[]> {
  const budgetMs = opts.budgetMs ?? STEP_BUDGET_MS;
  return Promise.all(
    steps.map(async (step): Promise<StepReport> => {
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<'overran'>((resolve) => {
        timer = setTimeout(() => resolve('overran'), budgetMs);
        timer.unref();
      });
      const done = (async () => {
        await step.run();
        return 'done' as const;
      })();
      const report: StepReport = { name: step.name, ms: 0, overran: false };
      try {
        report.overran = (await Promise.race([done, budget])) === 'overran';
      } catch (err) {
        report.error = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      // An abandoned step may still reject later; that must not be unhandled.
      done.catch(() => undefined);
      report.ms = Date.now() - started;
      opts.log?.(report);
      return report;
    }),
  );
}
