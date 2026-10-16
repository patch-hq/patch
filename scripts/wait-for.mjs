// Poll a check until it passes, saying so while it waits.
//
// A deferred host update can legitimately hold for many minutes while agent
// turns finish, and this loop used to be silent for all of it: the deploy log
// ended at "lanes → daemon" and looked dead for a quarter of an hour. A wait
// that long must show it is still alive and what it is waiting on.
import { execFileSync } from 'node:child_process';

/**
 * @param {string} label what is being waited for
 * @param {() => boolean} check
 * @param {object} [opts]
 * @param {number} [opts.tries] attempts before giving up
 * @param {number} [opts.intervalSec] pause between attempts
 * @param {number} [opts.reportEvery] say something every N attempts (0 = never)
 * @param {(line: string) => void} [opts.report] where progress goes
 * @param {(sec: number) => void} [opts.sleep] injected in tests
 * @param {() => string | undefined} [opts.detail] current state, appended to progress lines
 */
export function waitFor(label, check, opts = {}) {
  const {
    tries = 60,
    intervalSec = 2,
    reportEvery = 0,
    report = () => {},
    sleep = (s) => execFileSync('sleep', [String(s)]),
    detail,
  } = opts;
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    if (reportEvery > 0 && i > 0 && i % reportEvery === 0) {
      const state = detail?.();
      report(
        `still waiting for ${label} (${i * intervalSec}s of ${tries * intervalSec}s)` +
          (state ? ` — ${state}` : ''),
      );
    }
    sleep(intervalSec);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
