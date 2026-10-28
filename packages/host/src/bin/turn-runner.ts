#!/usr/bin/env node
// Entry point for one turn's runner — started detached by the host for every
// Claude turn so the turn outlives a host restart. See `turnRunner.ts`.
//
// Usage: turn-runner <turnDir>   (the spawn spec arrives on stdin)

import { runTurnRunner } from '../turnRunner.js';

const dir = process.argv[2];
if (!dir) {
  console.error('turn-runner: usage: turn-runner <turnDir>');
  process.exit(64);
}
runTurnRunner(dir).catch((err: unknown) => {
  console.error('turn-runner: fatal:', err);
  process.exit(1);
});
