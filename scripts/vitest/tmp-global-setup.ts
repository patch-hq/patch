// Vitest globalSetup shared by every package: each run gets its own TMPDIR and
// removes it when the run ends, so tests that mkdtemp under os.tmpdir() and
// never clean up no longer fill /tmp (an 8 GB tmpfs on the server).
// Workers inherit TMPDIR because globalSetup runs before they are spawned.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runDir = '';
let previous: string | undefined;

export function setup(): void {
  const base = tmpdir();
  mkdirSync(base, { recursive: true });
  runDir = mkdtempSync(join(base, 'patch-vitest-run-'));
  previous = process.env['TMPDIR'];
  process.env['TMPDIR'] = runDir;
}

export function teardown(): void {
  if (previous === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = previous;
  if (runDir) rmSync(runDir, { recursive: true, force: true });
}
