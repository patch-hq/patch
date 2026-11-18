// spec/08 § Action — `script`, host half. Real commands, real exit codes:
// this is the layer that would silently succeed if it ran the command in the
// wrong directory or swallowed a failure.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { JobRuns } from '../src/jobExec.js';

const silentLogger = pino({ level: 'silent' });

type Result = Extract<WireEvent, { type: 'job.exec_result' }>;

function request(command: string, folder: string, timeoutMs = 5000, fireId = 'f_1') {
  return {
    type: 'job.exec_request' as const,
    hostId: 'd1',
    jobId: 'j_1',
    fireId,
    folder,
    command,
    timeoutMs,
  };
}

/** One host's job runner, collecting what it reports. */
function host(runDir: string, extra: { bootTime?: () => number | undefined } = {}) {
  const results: Result[] = [];
  const waiters: Array<(r: Result) => void> = [];
  const runs = new JobRuns({
    runDir,
    emit: (e) => {
      if (e.type !== 'job.exec_result') return;
      results.push(e);
      waiters.shift()?.(e);
    },
    logger: silentLogger,
    pollMs: 50,
    ...extra,
  });
  const next = (): Promise<Result> =>
    results.length > 0
      ? Promise.resolve(results.shift()!)
      : new Promise((resolve) =>
          waiters.push((r) => {
            results.splice(results.indexOf(r), 1);
            resolve(r);
          }),
        );
  return { runs, next, results };
}

function run(command: string, folder: string, timeoutMs = 5000): Promise<Result> {
  const h = host(mkdtempSync(join(tmpdir(), 'patch-exec-runs-')));
  h.runs.start(request(command, folder, timeoutMs));
  return h.next();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('script job runs', () => {
  it('runs the command IN the folder it was given and reports its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    writeFileSync(join(dir, 'marker.txt'), 'here');
    const r = await run('ls marker.txt && pwd', dir);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('marker.txt');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a non-zero exit is a failure carrying the code and stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const r = await run('echo "went wrong" >&2; exit 3', dir);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('went wrong');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a folder that does not exist rather than running somewhere else', async () => {
    const r = await run('pwd', join(tmpdir(), 'patch-exec-does-not-exist-xyz'));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain('folder not found');
    // Nothing ran, so there is nothing to report from it.
    expect(r.stdout).toBe('');
  });

  // patch doesn't recognise tilde in workspace paths — a job's folder is
  // typed into the same "type a path" field as a chat's, so `~/sub` must run
  // there rather than failing `folder not found`.
  it('expands a leading ~ in the job folder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-exec-tilde-home-'));
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const r = await run('pwd', '~');
      expect(r.ok).toBe(true);
      expect(r.stdout.trim()).toBe(home);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('kills a command that outlives its timeout and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const r = await run('sleep 30', dir, 1000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timeout');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a chatty command runs to completion: real exit code, output is its tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    // ~6MiB on each stream, then the last words and a real exit code.
    const r = await run(
      'head -c 6291456 /dev/zero | tr "\\0" x; echo; echo "last out"; ' +
        'head -c 6291456 /dev/zero | tr "\\0" y >&2; echo >&2; echo "last err" >&2; exit 5',
      dir,
      20000,
    );
    expect(r.error).not.toContain('maxBuffer');
    expect(r.exitCode).toBe(5);
    expect(r.stdout.endsWith('last out')).toBe(true);
    expect(r.stderr.endsWith('last err')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // The bug that made every correct hold look like a crash.
  //
  // A non-interactive LOGIN shell reads `~/.bash_logout` whenever `exit` runs
  // explicitly, and Ubuntu's default one ends in a `&&` whose right side needs a
  // console (`clear_console -q`) and so returns 1 in a host. Under `set -e`
  // that became the shell's exit status — so a gate written the careful way
  // (`set -euo pipefail`, `exit 0` on the nothing-to-do path) reported FAILURE
  // on every fire where it correctly did nothing. Found 12 Sep 2026, the first
  // time a gate printed a verdict and its run still came back `dispatch-error`.
  //
  // The host's own dotfiles are NOT the fixture: these supply a hostile
  // `~/.bash_logout` of their own so the case is reproduced on any host,
  // including ones whose real logout file is harmless or absent. Two conditions
  // are needed and both are set here — the logout file must exist, and the shell
  // must compute `SHLVL=1`, which is true of a systemd service and false of
  // anything launched from a terminal (which is why this hid for so long).
  describe('the exit code is the command’s, not the login shell’s', () => {
    let home: string;
    let savedHome: string | undefined;
    let savedShlvl: string | undefined;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'patch-exec-home-'));
      writeFileSync(
        join(home, '.bash_logout'),
        // Ubuntu's skeleton file, verbatim in shape: a `&&` that fails for want
        // of a console. `false` stands in for `clear_console -q`, which is what
        // it returns in a host.
        'if [ "$SHLVL" = 1 ]; then\n  [ -x /bin/false ] && /bin/false\nfi\n',
      );
      savedHome = process.env['HOME'];
      savedShlvl = process.env['SHLVL'];
      process.env['HOME'] = home;
      // A systemd service has no SHLVL, so the shell it starts is level 1.
      delete process.env['SHLVL'];
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedShlvl === undefined) delete process.env['SHLVL'];
      else process.env['SHLVL'] = savedShlvl;
      rmSync(home, { recursive: true, force: true });
    });

    it('`set -e` plus an explicit `exit 0` succeeds', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
      const r = await run('set -euo pipefail\necho "queue empty — holding"\nexit 0', dir);
      expect(r.exitCode).toBe(0);
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain('queue empty');
      rmSync(dir, { recursive: true, force: true });
    });

    it('...and a deliberate non-zero exit still fails, with its own code', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
      const r = await run('set -euo pipefail\necho "observer unreachable" >&2\nexit 1', dir);
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    });

    it('passes a command full of quotes through untouched', async () => {
      // The command travels in the environment precisely so this cannot break.
      const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
      const r = await run(
        `python3 -c 'import json;print(json.dumps({"verdict": "held"}))'\necho "done \\"quoted\\" $(echo sub)"`,
        dir,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('{"verdict": "held"}');
      expect(r.stdout).toContain('done "quoted" sub');
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

// spec/02 § Host restarts: a script job is the host's work, and a host restart
// must neither kill it nor lose its result.
describe('script job runs outlive a host restart', () => {
  it('a run the restarted host picks up mid-run completes and is reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const runDir = mkdtempSync(join(tmpdir(), 'patch-exec-runs-'));
    const first = host(runDir);
    first.runs.start(request('sleep 1; echo "made it"; echo "and warned" >&2', dir));
    // The host goes down while the command runs.
    first.runs.dispose();
    await sleep(100);
    expect(first.results).toEqual([]);

    const second = host(runDir);
    expect(second.runs.adopt()).toBe(1);
    const r = await second.next();
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.fireId).toBe('f_1');
    expect(r.stdout).toBe('made it');
    expect(r.stderr).toBe('and warned');
    // The duration is the run's own, not the time since the new host came up.
    expect(r.durationMs).toBeGreaterThanOrEqual(900);
    expect(readdirSync(runDir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a run that finished while no host was up is reported with its real exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const runDir = mkdtempSync(join(tmpdir(), 'patch-exec-runs-'));
    const first = host(runDir);
    first.runs.start(request('echo bye; exit 4', dir));
    first.runs.dispose();
    await sleep(500);

    const second = host(runDir);
    second.runs.adopt();
    const r = await second.next();
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toBe('bye');
    expect(r.error).toContain('exit code 4');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a run that died with the machine is reported interrupted, not lost and not re-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const runDir = mkdtempSync(join(tmpdir(), 'patch-exec-runs-'));
    const first = host(runDir);
    first.runs.start(request('echo started >> ran.txt; sleep 30', dir, 60_000));
    await sleep(300);
    first.runs.dispose();
    // The machine goes down: the whole run dies, wrapper and all.
    const rec = JSON.parse(readFileSync(join(runDir, 'f_1.json'), 'utf8')) as { pid: number };
    process.kill(-rec.pid, 'SIGKILL');
    await sleep(100);

    const second = host(runDir, { bootTime: () => Date.now() });
    second.runs.adopt();
    const r = await second.next();
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.error).toMatch(/^interrupted: the (machine|Mac) restarted/);
    await sleep(200);
    expect(readFileSync(join(dir, 'ran.txt'), 'utf8')).toBe('started\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the restarted host still enforces the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const runDir = mkdtempSync(join(tmpdir(), 'patch-exec-runs-'));
    const first = host(runDir);
    first.runs.start(request('sleep 30', dir, 1000));
    first.runs.dispose();

    const second = host(runDir);
    second.runs.adopt();
    const r = await second.next();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timeout');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the same fire sent twice runs once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-exec-'));
    const h = host(mkdtempSync(join(tmpdir(), 'patch-exec-runs-')));
    h.runs.start(request('echo x >> count.txt; sleep 0.3', dir));
    h.runs.start(request('echo x >> count.txt; sleep 0.3', dir));
    const r = await h.next();
    expect(r.ok).toBe(true);
    await sleep(200);
    expect(h.results).toEqual([]);
    expect(readFileSync(join(dir, 'count.txt'), 'utf8')).toBe('x\n');
    rmSync(dir, { recursive: true, force: true });
  });
});
