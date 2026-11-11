// CI diagnostic, preloaded with NODE_OPTIONS=--require in the test gate (see
// .github/workflows/test.yml). A host-suite shard is intermittently SIGKILLed
// (exit 137) with no kernel OOM record, and nothing in the logs says who sent
// the signal. This records every process.kill that could take down more than
// its target (group kills, pid 0/1, the caller's own or parent pid, any
// SIGKILL) with a short stack, so the next failure names the sender.
// Appends to $PATCH_KILLTRACE (default /tmp/killtrace.log). Never throws.
'use strict';
const fs = require('node:fs');
const out = process.env.PATCH_KILLTRACE || '/tmp/killtrace.log';
const real = process.kill.bind(process);
process.kill = function (pid, signal) {
  try {
    const sig = signal === undefined ? 'SIGTERM' : signal;
    const n = Number(pid);
    const wide = !(n > 1) || n === process.pid || n === process.ppid || Object.is(n, -0);
    if (sig === 'SIGKILL' || sig === 9 || (wide && sig !== 0)) {
      const stack = String(new Error().stack).split('\n').slice(2, 6).map((l) => l.trim()).join(' <- ');
      fs.appendFileSync(
        out,
        `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} kill(${String(pid)}, ${String(sig)}) ${stack}\n`,
      );
    }
  } catch {
    // diagnostics must never change behaviour
  }
  return real(pid, signal);
};
