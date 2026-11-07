// Host self-update (spec/02 § Installation, spec/11 § Host installation).
//
// The server is the single channel a host gets its host from: the same
// manifest that feeds a brand-new install feeds every existing host's
// update, so publishing a build is what makes both see it.
//
// What this module will NOT do:
//   - install an artifact whose sha256 does not match the manifest;
//   - install an artifact whose Ed25519 signature does not verify against the
//     manifest's `signingPublicKey`. Until now nothing consumed that key, so
//     signing bought nothing — this is the path it exists for;
//   - report an update as applied when it was not.
//
// Applying reuses the artifact's OWN installer rather than reimplementing the
// install: the installer already lays the version down under
// `~/.patch/versions/<version>`, repoints `~/.patch/current`, rewrites the
// patch-cli skill, re-registers the unit with the service manager and verifies
// the service actually stayed up. Duplicating that here would mean two
// implementations of "install a host" drifting apart.

import { createHash, verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

/**
 * How long any single network step of an update may take. Nothing here had a
 * limit, so a server that accepted the connection and never answered left the
 * attempt pending forever — and `createUpdateGate` joins every later click onto
 * the pending attempt, so one stall disabled updating until a restart.
 */
export const UPDATE_STEP_TIMEOUT_MS = 2 * 60_000;
/** How long the installer may run before it is killed and the attempt fails. */
export const INSTALLER_TIMEOUT_MS = 5 * 60_000;

/** `fetch` that aborts after `ms`; an abort rejects with a message naming the URL. */
async function fetchBounded(f: typeof fetch, url: string, ms: number): Promise<Response> {
  try {
    return await f(url, { signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${url}`);
    }
    throw err;
  }
}

export interface ManifestArtifact {
  target: string;
  file: string;
  bytes: number;
  sha256: string;
  sig: string;
}

export interface HostManifest {
  version: string;
  gitSha: string;
  builtAt: string;
  signingPublicKey: string;
  artifacts: ManifestArtifact[];
}

export interface UpdateCheck {
  available: boolean;
  /** The published version, when one could be read. Null when unknown. */
  version: string | null;
  /**
   * A NEWER version is published but has no artifact for this target yet. A
   * deploy publishes linux-x64 first and the Mac build a minute or so later, so
   * this is usually transient — see `createArtifactWait`.
   */
  awaitingArtifact?: boolean;
  /** Why no update is available / why the check could not be made. */
  reason: string;
}

/** Compare dotted numeric versions; null when either side is not comparable. */
export function compareVersions(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Is a newer build published for THIS host's os/arch? A host that is not
 * running from a built artifact has no target to match and no version to
 * compare, so it reports "no update" with that as the stated reason — never a
 * silent false.
 */
export async function checkForUpdate(opts: {
  serverUrl: string;
  currentVersion: string;
  target: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpdateCheck> {
  if (!opts.target) {
    return {
      available: false,
      version: null,
      reason: 'this host is not running from a built artifact, so it has no update target',
    };
  }
  const f = opts.fetchImpl ?? fetch;
  let manifest: HostManifest;
  try {
    const res = await fetchBounded(
      f,
      `${opts.serverUrl.replace(/\/+$/, '')}/api/host/host-latest.json`,
      opts.timeoutMs ?? UPDATE_STEP_TIMEOUT_MS,
    );
    if (!res.ok) {
      return {
        available: false,
        version: null,
        reason: `the server has published no host manifest (HTTP ${res.status})`,
      };
    }
    manifest = (await res.json()) as HostManifest;
  } catch (err) {
    return {
      available: false,
      version: null,
      reason: `could not reach the update channel: ${(err as Error).message}`,
    };
  }
  const artifact = manifest.artifacts?.find((a) => a.target === opts.target);
  if (!artifact) {
    const newer = compareVersions(manifest.version ?? '', opts.currentVersion);
    return {
      available: false,
      version: manifest.version ?? null,
      reason: `the published build has no artifact for ${opts.target}`,
      ...(newer !== null && newer > 0 ? { awaitingArtifact: true } : {}),
    };
  }
  const cmp = compareVersions(manifest.version, opts.currentVersion);
  if (cmp === null) {
    return {
      available: false,
      version: manifest.version,
      reason: `cannot compare published ${manifest.version} with running ${opts.currentVersion}`,
    };
  }
  if (cmp <= 0) {
    return {
      available: false,
      version: manifest.version,
      reason: `running ${opts.currentVersion}; published ${manifest.version} is not newer`,
    };
  }
  return { available: true, version: manifest.version, reason: 'a newer build is published' };
}

/**
 * Verify an Ed25519 signature over the artifact's sha256 digest, exactly as
 * `scripts/build-host.mjs` produced it: the signed message is the RAW 32
 * digest bytes, the signature is base64url, the key is a base64url raw public
 * key. Wrapped into SPKI here because node:crypto has no raw-key verify.
 */
export function verifyArtifactSignature(opts: {
  sha256Hex: string;
  signatureB64Url: string;
  publicKeyB64Url: string;
}): boolean {
  try {
    const raw = Buffer.from(opts.publicKeyB64Url, 'base64url');
    if (raw.length !== 32) return false;
    // SPKI prefix for Ed25519 (RFC 8410).
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(
      null,
      Buffer.from(opts.sha256Hex, 'hex'),
      key,
      Buffer.from(opts.signatureB64Url, 'base64url'),
    );
  } catch {
    return false;
  }
}

/**
 * Never let the server's shared secret travel in an error string — an error
 * from here reaches a surface, and execFile's message embeds the whole argv,
 * which is how `--internal-token <secret>` ended up in a user-visible message.
 */
function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('<internal-token>');
}

/** The version `~/.patch/current` points at — what this host will run next. */
/**
 * Run the installer in a new process group (see applyUpdate), writing to
 * `fd`, and resolve when it exits. A non-zero exit rejects with its code.
 */
export function runDetached(
  cmd: string,
  args: string[],
  fd: number,
  timeoutMs: number = INSTALLER_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] });
    // An installer that never returns would hold the update gate open forever.
    // It leads its own process group, so killing the group takes its children too.
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error(`installer did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`installer exited ${code ?? signal}`));
    });
  });
}

function installedVersion(patchHome: string): string | undefined {
  try {
    const target = readlinkSync(join(patchHome, 'current'));
    return basename(target);
  } catch {
    return undefined;
  }
}

export interface ApplyResult {
  applied: boolean;
  message: string;
  /** The update is real and will apply, but not yet: this host's artifact is still being built (see `requestUpdate`). */
  deferred?: boolean;
}

/**
 * The front door for "apply the published build" (the Update button's
 * `host.update` frame and `patch hosts update`). Turns do not hold it: they run
 * under their own runners and carry on across the restart (spec/02 § Turns
 * outlive the host). The one thing that defers it is a build whose artifact for
 * this host is still being built.
 */
export async function requestUpdate(opts: {
  check: () => Promise<UpdateCheck>;
  apply: () => Promise<ApplyResult>;
  logger: Logger;
  /** When given, a newer build still missing this target's artifact is waited for, not refused. */
  artifactWait?: ArtifactWait;
}): Promise<ApplyResult> {
  if (opts.artifactWait) {
    const early = await opts.check();
    if (early.awaitingArtifact) {
      opts.artifactWait.start(opts);
      return {
        applied: false,
        deferred: true,
        message: `${early.version ?? 'the published build'} is still being built for this host — will update as soon as it is published`,
      };
    }
  }
  return opts.apply();
}

/**
 * How long a published build must have been the newest one, as seen by this
 * host's own scheduled checks, before the scheduled auto-update installs it.
 * Deploys land in bursts, and every install restarts the host and drops the
 * connection mid-work, so a burst should cost one restart, not one per build.
 * The Update button and `patch hosts update` ignore this: a person asking
 * for the update gets it now.
 */
export const AUTO_UPDATE_SETTLE_MS = 20 * 60_000;

export interface AutoUpdateSettle {
  /**
   * Record that a scheduled check saw `version` published. True once that same
   * version has been the newest published for `settleMs`; a different version
   * restarts the clock.
   */
  settled(version: string): boolean;
}

export function createAutoUpdateSettle(
  cfg: { settleMs?: number; now?: () => number } = {},
): AutoUpdateSettle {
  const settleMs = cfg.settleMs ?? AUTO_UPDATE_SETTLE_MS;
  const now = cfg.now ?? Date.now;
  let seen: { version: string; since: number } | null = null;
  return {
    settled(version) {
      if (!seen || seen.version !== version) seen = { version, since: now() };
      return now() - seen.since >= settleMs;
    },
  };
}

export interface ArtifactWait {
  /** True while a wait is in progress. */
  readonly active: boolean;
  /** Begin waiting (a no-op when already waiting — callers join the one wait). */
  start(opts: {
    check: () => Promise<UpdateCheck>;
    apply: () => Promise<ApplyResult>;
    logger: Logger;
  }): void;
  /** Resolves when the current wait (if any) has ended. Test hook. */
  settled(): Promise<void>;
}

/**
 * A deploy publishes the Linux host first and the Mac one after its SSH build
 * (the release workflow's mac job), so for a while a Mac sees a newer version
 * with no artifact for it. That is not a failure and not worth an error: poll
 * quietly — every `pollMs`, then every `slowPollMs` once `windowMs` has passed —
 * for as long as the build is pending, and apply when it lands. `onPendingChange`
 * tells the host to show "Update pending" while the wait is active. `onGiveUp`
 * is only for genuine failures (the apply was refused, the check threw).
 * Single-flight.
 */
export function createArtifactWait(cfg: {
  onGiveUp: (message: string) => void;
  /** Called with true when a wait starts and false when it ends, however it ends. */
  onPendingChange?: (pending: boolean) => void;
  windowMs?: number;
  pollMs?: number;
  slowPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): ArtifactWait {
  const windowMs = cfg.windowMs ?? 5 * 60_000;
  const pollMs = cfg.pollMs ?? 15_000;
  const slowPollMs = cfg.slowPollMs ?? 5 * 60_000;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = cfg.now ?? Date.now;
  let running: Promise<void> | null = null;

  const run = async (o: Parameters<ArtifactWait['start']>[0]): Promise<void> => {
    const deadline = now() + windowMs;
    o.logger.info(
      { windowMs },
      'self-update: newer build has no artifact for this target yet; waiting',
    );
    for (;;) {
      await sleep(now() >= deadline ? slowPollMs : pollMs);
      const check = await o.check();
      if (check.awaitingArtifact) continue;
      if (!check.available) {
        o.logger.info({ reason: check.reason }, 'self-update: no longer waiting for an artifact');
        return;
      }
      const result = await o.apply();
      if (!result.applied && !result.deferred) cfg.onGiveUp(result.message);
      return;
    }
  };

  return {
    get active() {
      return running !== null;
    },
    start(o) {
      if (running) return;
      running = run(o)
        .catch((err: unknown) => cfg.onGiveUp(`self-update failed: ${(err as Error).message}`))
        .finally(() => {
          running = null;
          cfg.onPendingChange?.(false);
        });
      cfg.onPendingChange?.(true);
    },
    settled: async () => {
      await running;
    },
  };
}

/**
 * Wraps `applyUpdate` so concurrent callers join the SAME attempt instead of
 * each starting their own installer run. There are two independent doors onto
 * this action — the `host.update` wire event (the Settings → Hosts/Updates
 * button, clicked again because the first click had nothing to show for
 * itself) and `patch hosts update`'s local control command — and a second
 * `applyUpdate` starting while the first was still installing raced the SAME
 * installer against itself: the second run's `bootout` tore down the service
 * the first had only just bootstrapped, right as it was starting it
 * (2026-09-28, the user's Mac — a `kickstart` that found no such service in the
 * gui/501 domain). Returns a function with `applyUpdate`'s own signature, so
 * every caller uses it exactly as they used `applyUpdate` directly.
 */
export function createUpdateGate(apply: typeof applyUpdate = applyUpdate): typeof applyUpdate {
  let inFlight: Promise<ApplyResult> | null = null;
  return (opts) => {
    if (inFlight) return inFlight;
    const attempt = apply(opts).finally(() => {
      inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  };
}

/** What a stage or apply needs of the published build: verified, unpacked, installer ready. */
type BuildResult = { ok: true; extracted: string } | { ok: false; message: string };

/**
 * Download the artifact, check its digest and signature, and unpack it into
 * `work`. Shared by an ordinary apply (a temp dir) and by staging ahead of a
 * server restart (a kept dir), so both verify identically.
 */
async function fetchVerifiedBuild(
  f: typeof fetch,
  base: string,
  artifact: ManifestArtifact,
  manifest: HostManifest,
  work: string,
  stepMs: number,
): Promise<BuildResult> {
  const res = await fetchBounded(f, `${base}/api/host/${artifact.file}`, stepMs);
  if (!res.ok) {
    return { ok: false, message: `could not download ${artifact.file}: HTTP ${res.status}` };
  }
  const bytes = Buffer.from(await res.arrayBuffer());

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256) {
    // Refuse loudly: a digest mismatch is a corrupted or substituted artifact,
    // never something to install and hope about.
    return {
      ok: false,
      message: `refusing to install ${artifact.file}: sha256 ${digest} does not match the manifest`,
    };
  }
  if (
    !verifyArtifactSignature({
      sha256Hex: digest,
      signatureB64Url: artifact.sig,
      publicKeyB64Url: manifest.signingPublicKey,
    })
  ) {
    return {
      ok: false,
      message: `refusing to install ${artifact.file}: its signature does not verify against the project signing key`,
    };
  }

  const tar = join(work, artifact.file);
  writeFileSync(tar, bytes);
  await execFileAsync('tar', ['-xzf', tar, '-C', work], { timeout: stepMs });
  // The tarball holds one top-level directory named for the build.
  const extracted = join(work, artifact.file.replace(/\.tar\.gz$/, ''));
  const installer = join(extracted, 'install');
  if (!existsSync(installer)) {
    return {
      ok: false,
      message: `the downloaded artifact carries no installer at ${installer}`,
    };
  }
  chmodSync(installer, 0o755);
  const node = join(extracted, 'node');
  if (existsSync(node)) chmodSync(node, 0o755);

  return { ok: true, extracted };
}

type FetchedBuild =
  | { ok: true; extracted: string; version: string }
  | { ok: false; message: string };

/** Ask the server what is published for this host and fetch it into `work`. */
async function fetchPublishedBuild(
  opts: {
    serverUrl: string;
    internalToken: string;
    currentVersion: string;
    target: string | undefined;
    fetchImpl?: typeof fetch;
    logger?: Logger;
  },
  stepMs: number,
  base: string,
  work: string,
): Promise<FetchedBuild> {
  const check = await checkForUpdate({
    serverUrl: opts.serverUrl,
    currentVersion: opts.currentVersion,
    target: opts.target,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs: stepMs,
  });
  // Redact on EVERY path out, not just the ones that obviously embed argv: the
  // check's own failure message carries whatever the fetch layer said, and that
  // has been seen to include the token.
  if (!check.available) {
    opts.logger?.info(
      { from: opts.currentVersion, reason: redactToken(check.reason, opts.internalToken) },
      'self-update: check — nothing to apply',
    );
    return { ok: false, message: redactToken(check.reason, opts.internalToken) };
  }
  opts.logger?.info(
    { from: opts.currentVersion, target: opts.target },
    'self-update: check — a newer build is published',
  );
  const f = opts.fetchImpl ?? fetch;
  let manifest: HostManifest;
  try {
    manifest = (await (
      await fetchBounded(f, `${base}/api/host/host-latest.json`, stepMs)
    ).json()) as HostManifest;
  } catch (err) {
    return {
      ok: false,
      message: `self-update failed: ${redactToken((err as Error).message, opts.internalToken)}`,
    };
  }
  const artifact = manifest.artifacts.find((a) => a.target === opts.target);
  if (!artifact) return { ok: false, message: `no artifact for ${opts.target}` };
  const built = await fetchVerifiedBuild(f, base, artifact, manifest, work, stepMs);
  return built.ok ? { ...built, version: manifest.version } : built;
}

const STAGED_READY = '.staged-ready';

function stagedRoot(patchHome: string): string {
  return join(patchHome, 'staged');
}

/** The unpacked, verified build staged for `version`, or null when there is none. */
export function stagedBuild(patchHome: string, version: string): string | null {
  const dir = join(stagedRoot(patchHome), version);
  if (!existsSync(join(dir, STAGED_READY))) return null;
  const sub = readdirSync(dir).find((n) => n !== STAGED_READY);
  return sub && existsSync(join(dir, sub, 'install')) ? join(dir, sub) : null;
}

/** Remove staged builds at or below the running version (and any half-written one). */
export function pruneStaged(patchHome: string, running: string): void {
  const root = stagedRoot(patchHome);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const cmp = compareVersions(name, running);
    if (cmp === null || cmp <= 0 || !existsSync(join(root, name, STAGED_READY))) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
}

/**
 * Download and verify `version` and keep it for the server's restart into it
 * (spec/11 § Updates in lockstep). Installs nothing. Refuses when the server's
 * published build is not that version: a stale instruction must not stage the
 * wrong build. Any other staged build is dropped.
 */
export async function stageUpdate(opts: {
  serverUrl: string;
  internalToken: string;
  currentVersion: string;
  target: string | undefined;
  patchHome: string;
  version: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ staged: boolean; message: string }> {
  if (stagedBuild(opts.patchHome, opts.version)) {
    return { staged: true, message: `${opts.version} is already staged` };
  }
  const stepMs = opts.timeoutMs ?? UPDATE_STEP_TIMEOUT_MS;
  const base = opts.serverUrl.replace(/\/+$/, '');
  const dir = join(stagedRoot(opts.patchHome), opts.version);
  rmSync(stagedRoot(opts.patchHome), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const fetched = await fetchPublishedBuild(opts, stepMs, base, dir);
    if (!fetched.ok) throw new Error(fetched.message);
    if (fetched.version !== opts.version) {
      throw new Error(`the server publishes ${fetched.version}, not ${opts.version}`);
    }
    // The tarball itself is not needed once unpacked.
    for (const n of readdirSync(dir)) if (n.endsWith('.tar.gz')) rmSync(join(dir, n));
    writeFileSync(join(dir, STAGED_READY), `${opts.version}\n`);
    return { staged: true, message: `staged ${opts.version}` };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return {
      staged: false,
      message: `staging ${opts.version} failed: ${redactToken((err as Error).message, opts.internalToken)}`,
    };
  }
}

/**
 * Download, verify and install the published build, then hand over to the new
 * artifact's installer (which re-registers the unit and restarts the service —
 * so a successful apply typically ends with this process being replaced).
 */
export async function applyUpdate(opts: {
  serverUrl: string;
  internalToken: string;
  currentVersion: string;
  target: string | undefined;
  /** `~/.patch` — where `current` says which version this host will run. */
  patchHome: string;
  /**
   * Called with the build's version immediately before the installer runs — the point at which an install has genuinely
   * been tried. Deferred and awaiting-artifact paths never reach it.
   */
  onInstallStart?: (version: string) => void;
  /**
   * Install the build already staged for this version (see `stageUpdate`)
   * instead of asking the server for one. Used when the server has announced it
   * is restarting into that version: it is down, so nothing can be fetched.
   */
  stagedVersion?: string;
  /** Installer-runner override — test hook, so a unit test starts no process. */
  runInstaller?: (cmd: string, args: string[], fd: number, timeoutMs?: number) => Promise<void>;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Per-step network limit; defaults to UPDATE_STEP_TIMEOUT_MS. */
  timeoutMs?: number;
}): Promise<ApplyResult> {
  const stepMs = opts.timeoutMs ?? UPDATE_STEP_TIMEOUT_MS;
  const base = opts.serverUrl.replace(/\/+$/, '');
  const work = mkdtempSync(join(tmpdir(), 'patch-update-'));
  try {
    let extracted: string;
    let version: string;
    if (opts.stagedVersion) {
      const staged = stagedBuild(opts.patchHome, opts.stagedVersion);
      if (!staged) {
        return { applied: false, message: `no staged build for ${opts.stagedVersion}` };
      }
      extracted = staged;
      version = opts.stagedVersion;
    } else {
      const fetched = await fetchPublishedBuild(opts, stepMs, base, work);
      if (!fetched.ok) return { applied: false, message: fetched.message };
      extracted = fetched.extracted;
      version = fetched.version;
    }

    opts.onInstallStart?.(version);
    opts.logger.info(
      { from: opts.currentVersion, to: version, target: opts.target },
      'self-update: verified artifact, handing over to its installer',
    );
    // The installer RESTARTS the service — which kills this very process, since
    // this is that service. So a non-zero exit here does NOT mean the update
    // failed: the far more likely reading is that it succeeded and took us down
    // mid-call. Judge by what is on disk afterwards, never by the exit code.
    //
    // It runs in its OWN process group. launchd's bootout kills every process
    // in the job's group, and the installer re-registering the service boots
    // out the very job it was started from — so as a plain child it died
    // between bootout and bootstrap, and a Mac's host updated itself into a
    // service that was no longer loaded (2026-09-28). Its words go to a log
    // file rather than a pipe, since the reader of the pipe is killed first.
    const logPath = join(opts.patchHome, 'logs', 'self-update.log');
    mkdirSync(dirname(logPath), { recursive: true });
    const started = existsSync(logPath) ? statSync(logPath).size : 0;
    const out = openSync(logPath, 'a');
    let installerOutput = '';
    const installStartedAt = Date.now();
    opts.logger.info(
      {
        installer: join(extracted, 'install'),
        from: opts.currentVersion,
        to: version,
        installedBefore: installedVersion(opts.patchHome),
        installerLog: logPath,
        pid: process.pid,
      },
      'self-update: installer start',
    );
    let installerFailure: string | undefined;
    try {
      await (opts.runInstaller ?? runDetached)(
        join(extracted, 'install'),
        ['--non-interactive', '--server', base, '--internal-token', opts.internalToken],
        out,
        ...(opts.timeoutMs ? [opts.timeoutMs] : []),
      );
    } catch (err) {
      installerFailure = redactToken((err as Error).message, opts.internalToken);
      installerOutput = installerFailure;
    } finally {
      closeSync(out);
    }
    installerOutput = `${readFileSync(logPath, 'utf8').slice(started)}\n${installerOutput}`.trim();

    const installed = installedVersion(opts.patchHome);
    opts.logger.info(
      {
        exit: installerFailure ?? 'exited 0',
        durationMs: Date.now() - installStartedAt,
        installedBefore: opts.currentVersion,
        installedAfter: installed,
        wanted: version,
        output: redactToken(installerOutput, opts.internalToken),
      },
      'self-update: installer finished',
    );
    if (installed === version) {
      opts.logger.info(
        { installed, output: installerOutput },
        'self-update: applied (the service restart may have interrupted this call)',
      );
      return { applied: true, message: `updated ${opts.currentVersion} → ${version}` };
    }
    opts.logger.warn(
      { installedAfter: installed, wanted: version },
      'self-update: did not take — this machine is not on the wanted version',
    );
    return {
      applied: false,
      message:
        `self-update did not take: this host is still on ${installed ?? 'an unknown version'}. ` +
        redactToken(installerOutput, opts.internalToken),
    };
  } catch (err) {
    opts.logger.error(
      { err: redactToken((err as Error).message, opts.internalToken) },
      'self-update: failed before or around the installer',
    );
    return {
      applied: false,
      message: `self-update failed: ${redactToken((err as Error).message, opts.internalToken)}`,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The words a surface shows when an update is refused. `reason` is diagnostic
 * text (target names, internals); the user needs what it means and what to do.
 */
export function describeUpdateRefusal(reason: string): string {
  if (/no artifact for/.test(reason)) {
    return "Update not ready: the new version hasn't finished building for this computer. Try again in a few minutes.";
  }
  return `Update failed: ${reason}`;
}
