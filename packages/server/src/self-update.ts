// The server updating itself to the release its channel mirrored.
//
// The release mirror (release-mirror.ts) brings each new release into
// downloads/, the server's own included (downloads/server-release/). When that
// release is newer than the one running, this installs it: the release's own
// installer, unpacked under <home>/updates/, does what it does for a person at a
// shell — copies the release in, swaps `current`, restarts the unit and waits
// for /api/healthz to report the new commit.
//
// The installer restarts this process, so it cannot run inside it: systemd
// would stop it with the rest of the unit halfway through. It runs as a
// transient unit of its own (`systemd-run --user`), whose output is in
// `journalctl --user -u <unit>`.
//
// Only a server installed as a user unit can do that for itself. Anything else
// (a system unit, which needs root to install; Docker; no systemd) is told
// plainly, once per release, what to run instead. NO FALLBACK: a failure is
// logged loudly with where to look, and the same release is tried again later.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readMirrorState } from './release-mirror.js';

/** Between attempts at the same release, so a failing install is not a loop. */
export const RETRY_AFTER_MS = 30 * 60 * 1000;

function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `candidate` a newer release than `running`? Unparseable is never newer. */
export function isNewer(candidate: string, running: string): boolean {
  const a = parse(candidate);
  const b = parse(running);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export type SelfUpdatePlan =
  | { kind: 'current' }
  | { kind: 'install'; to: string }
  | { kind: 'manual'; to: string; why: string };

/** What to do about a mirrored release. Pure, so the decisions can be tested. */
export function planSelfUpdate(opts: {
  running: string;
  mirrored: string | null;
  tarballPresent: boolean;
  userUnit: boolean;
}): SelfUpdatePlan {
  const { running, mirrored } = opts;
  if (!mirrored || !isNewer(mirrored, running)) return { kind: 'current' };
  if (!opts.tarballPresent) {
    return { kind: 'manual', to: mirrored, why: 'the mirrored release carries no server tarball' };
  }
  if (!opts.userUnit) {
    return {
      kind: 'manual',
      to: mirrored,
      why: 'this server is not a systemd user unit, so it cannot restart itself into a new release',
    };
  }
  return { kind: 'install', to: mirrored };
}

export interface SelfUpdaterOptions {
  home: string;
  downloadsDir: string;
  running: string;
  log: (msg: string) => void;
  now?: () => number;
  /** Starts the installer; returns the transient unit's name. Replaced in tests. */
  launch?: (installer: string, home: string, unit: string) => void;
}

function launchWithSystemd(installer: string, home: string, unit: string): void {
  // Returns once the unit has started; the install itself carries on in it.
  // PATH carried across: the installer writes it into the unit, and finds node on it.
  execFileSync(
    'systemd-run',
    [
      '--user',
      '--collect',
      '--quiet',
      `--unit=${unit}`,
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      installer,
      '--home',
      home,
    ],
    { stdio: 'ignore' },
  );
}

/** Under systemd, as the user unit the installer writes? */
function runsAsUserUnit(): boolean {
  const unitDir = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'systemd',
    'user',
  );
  return Boolean(process.env.INVOCATION_ID) && existsSync(join(unitDir, 'patch-server.service'));
}

/** One check: called after every mirror tick. */
export function createSelfUpdater(opts: SelfUpdaterOptions): () => void {
  const now = opts.now ?? Date.now;
  const launch = opts.launch ?? launchWithSystemd;
  const attempted = new Map<string, number>();
  const told = new Set<string>();
  const tarball = join(opts.downloadsDir, 'server-release', 'patch-server.tar.gz');

  return () => {
    const mirrored = readMirrorState(opts.downloadsDir, opts.log)?.version ?? null;
    const plan = planSelfUpdate({
      running: opts.running,
      mirrored,
      tarballPresent: existsSync(tarball),
      userUnit: runsAsUserUnit(),
    });
    if (plan.kind === 'current') return;
    if (plan.kind === 'manual') {
      if (told.has(plan.to)) return;
      told.add(plan.to);
      opts.log(
        `self-update: release ${plan.to} is mirrored but not installed — ${plan.why}. ` +
          `Install it with: tar -xzf ${tarball} -C /tmp && /tmp/patch-server-${plan.to}/install --home ${opts.home}`,
      );
      return;
    }
    const last = attempted.get(plan.to);
    if (last !== undefined && now() - last < RETRY_AFTER_MS) return;
    attempted.set(plan.to, now());

    const updates = join(opts.home, 'updates');
    try {
      rmSync(updates, { recursive: true, force: true });
      mkdirSync(updates, { recursive: true });
      execFileSync('tar', ['-xzf', tarball, '-C', updates]);
      const dirs = readdirSync(updates);
      if (dirs.length !== 1)
        throw new Error(`expected one release in the tarball, found ${dirs.length}`);
      const installer = join(updates, dirs[0]!, 'install');
      if (!existsSync(installer)) throw new Error(`${installer} is missing`);
      const unit = `patch-server-update-${plan.to.replace(/\./g, '-')}-${now()}`;
      launch(installer, opts.home, unit);
      opts.log(
        `self-update: installing release ${plan.to} over ${opts.running}; ` +
          `progress in: journalctl --user -u ${unit}`,
      );
    } catch (err: unknown) {
      opts.log(
        `self-update FAILED to start installing ${plan.to}: ` +
          `${err instanceof Error ? err.message : String(err)} (tries again in ${RETRY_AFTER_MS / 60_000} min)`,
      );
    }
  };
}
