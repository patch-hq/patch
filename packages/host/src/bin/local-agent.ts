#!/usr/bin/env node
// Entry point for one local-model turn's agent process — started under the
// turn runner so the turn outlives a host restart. See `localAgent.ts`.
//
// Usage: local-agent   (the turn arrives on stdin as a `start` line)

import { runLocalAgent } from '../localAgent.js';

runLocalAgent(process.stdin, process.stdout).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('local-agent: fatal:', err);
    process.exit(1);
  },
);
