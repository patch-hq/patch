// Desktop shell auto-update — the state machine behind the "Version & updates" panel.
//
// spec/11 § Version reporting. This exists because the shell's updater had never
// run once: the installed app was produced by `dist:dry` (electron-builder
// `--dir`), which emits no `app-update.yml`, so main.ts's `existsSync` guard
// returned early on every launch; the publish config pointed at a GitHub repo that
// isn't the real remote; there were no releases; and the version was pinned to
// 0.0.0 so electron-updater had nothing to compare. Four independent breakages,
// none of them visible from inside the app — which is the actual defect.
//
// So the design rule here is: every outcome is RECORDED and reportable, including
// failure. "I checked and there's nothing new" and "I couldn't check" must never
// look the same, and neither may silently look like "up to date".
//
// The check state is persisted to userData so "last checked" survives relaunch —
// otherwise every launch would claim it had never checked.

/** What the panel renders. Serialisable — crosses the IPC boundary as-is. */
export interface UpdaterState {
  /** Version of the running shell. */
  currentVersion: string;
  /** Short git sha the running shell was built from, or null if unstamped. */
  gitSha: string | null;
  /** ISO instant the running shell was built, or null if unstamped. */
  builtAt: string | null;
  /** The feed being polled, or null when updates are not configured at all. */
  feedUrl: string | null;
  /**
   * Why the updater is inert, when it is. Non-null here is the honest answer to
   * "why does this never find updates?" — the question the old build couldn't
   * answer. null means the updater is live.
   */
  disabledReason: string | null;
  /** ISO instant the last check COMPLETED (persisted across launches). */
  lastCheckedAt: string | null;
  /** Outcome of the last completed check. */
  lastResult: 'up-to-date' | 'update-available' | 'downloaded' | 'error' | null;
  /** Failure detail when lastResult is 'error'. Surfaced verbatim, never swallowed. */
  lastError: string | null;
  /**
   * What lastError was about. A failed CHECK leaves a downloaded update fully
   * installable, so the Restart banner must stay quiet about it; a failed
   * INSTALL is the one that banner has to show. Not persisted: an install
   * failure does not survive the relaunch that ends it.
   */
  lastErrorKind: 'check' | 'install' | null;
  /** Version offered by the feed, when newer than current. */
  availableVersion: string | null;
  /** True once the update is on disk and installable. */
  downloaded: boolean;
  /**
   * ISO instant this shell FIRST learned it was behind the feed, and has been
   * behind ever since. Cleared only by actually installing.
   *
   * Deliberately not "when the current download finished": Patch ships ~20
   * times a day, so a per-download clock is reset by the next deploy and can
   * never age past a few minutes. The thing worth measuring — the thing the
   * banner escalates on — is how long you have been running a build older than
   * what is published, across however many versions have gone by.
   */
  staleSince: string | null;
  /** True while a check is in flight. */
  checking: boolean;
}

/** The subset of UpdaterState worth persisting between launches. */
export interface PersistedUpdaterState {
  lastCheckedAt: string | null;
  lastResult: UpdaterState['lastResult'];
  lastError: string | null;
  availableVersion: string | null;
  /** Survives relaunch: a shell restarted for some other reason is still behind. */
  staleSince: string | null;
}

export function emptyPersisted(): PersistedUpdaterState {
  return {
    lastCheckedAt: null,
    lastResult: null,
    lastError: null,
    availableVersion: null,
    staleSince: null,
  };
}

/**
 * Parse persisted state read off disk. Unknown/corrupt content yields "never
 * checked" rather than a thrown boot error — the app must still launch — but it
 * deliberately does NOT invent a check time, so the panel still says "never".
 */
export function parsePersisted(raw: string): PersistedUpdaterState {
  try {
    const v = JSON.parse(raw) as Partial<PersistedUpdaterState>;
    const results: UpdaterState['lastResult'][] = [
      'up-to-date',
      'update-available',
      'downloaded',
      'error',
    ];
    return {
      lastCheckedAt: typeof v.lastCheckedAt === 'string' ? v.lastCheckedAt : null,
      lastResult: results.includes(v.lastResult as UpdaterState['lastResult'])
        ? (v.lastResult as UpdaterState['lastResult'])
        : null,
      lastError: typeof v.lastError === 'string' ? v.lastError : null,
      availableVersion: typeof v.availableVersion === 'string' ? v.availableVersion : null,
      staleSince: typeof v.staleSince === 'string' ? v.staleSince : null,
    };
  } catch {
    return emptyPersisted();
  }
}

/**
 * Reasons the updater cannot work, checked in the order a user would hit them.
 * Returns null when it should function.
 *
 * Each of these was a REAL breakage in the shipped app, silently short-circuiting
 * the update check. Naming them turns "updates never appear" into a specific,
 * fixable sentence in the panel.
 */
export function diagnoseUpdater(env: {
  /** app.isPackaged — a `pnpm dev` run has nothing to update. */
  isPackaged: boolean;
  /** Does `<resources>/app-update.yml` exist? Absent for a `--dir` build. */
  hasUpdateConfig: boolean;
  /** The running app's version. */
  version: string;
  /** Is the bundle signed with a real (non-adhoc) identity? */
  signed: boolean;
  /**
   * Set when this app has no server to take updates from — it runs its own
   * (spec/05 § Desktop first run, "On this Mac"). The feed is the server's.
   */
  noFeedReason?: string | null;
}): string | null {
  if (!env.isPackaged) {
    return 'running from source (pnpm dev) — only a packaged build can self-update';
  }
  if (env.noFeedReason) return env.noFeedReason;
  if (!env.hasUpdateConfig) {
    return (
      'this build has no app-update.yml, so it can never check for updates — ' +
      'it was produced by `dist:dry` (--dir). Rebuild with `pnpm ship desktop`.'
    );
  }
  if (/^0\.0\.0/.test(env.version)) {
    return `version is ${env.version}, which can never compare as older than a release — rebuild with a real version`;
  }
  if (!env.signed) {
    // Measured, not assumed: an adhoc build downloads the update and then fails
    // validation ("code has no resources but signature indicates they must be
    // present"). A Developer ID is NOT required — Squirrel's designated requirement
    // is `identifier … and certificate root = H"…"` with no `anchor apple` clause, so
    // any trusted code-signing identity works, self-signed included (spec/11 §
    // Desktop code signing).
    return (
      'this build is adhoc-signed, so macOS will refuse to APPLY a downloaded ' +
      'update — Squirrel requires the update to carry the same code-signing ' +
      'certificate as the installed app, and adhoc has none. Checking and ' +
      'downloading work; installing needs a signed build (any trusted ' +
      'code-signing identity, not necessarily an Apple Developer ID).'
    );
  }
  return null;
}

/**
 * Whether the shell should ever ask electron-updater to check. The shipped
 * app-update.yml names a placeholder feed (`updates.invalid`) that is replaced at
 * runtime by the server's own; a shell with no feed of its own ("On this Mac")
 * must not fall back to that placeholder — it would record a DNS error every
 * hour over the honest `disabledReason`.
 */
export function shouldPollFeed(env: { hasUpdateConfig: boolean; feedUrl: string | null }): boolean {
  return env.hasUpdateConfig && env.feedUrl !== null;
}

/**
 * Fold an updater event into new state. Pure, so the whole state machine is
 * testable without Electron or a live feed.
 */
export type UpdaterEvent =
  | { type: 'check-started' }
  | { type: 'up-to-date'; at: string }
  | { type: 'available'; version: string; at: string }
  | { type: 'downloaded'; version: string; at: string }
  | { type: 'error'; kind: 'check' | 'install'; message: string; at: string };

export function reduceUpdater(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case 'check-started':
      // Keep the previous result visible while re-checking — blanking it would
      // make a failed check look like "no answer yet" forever.
      return { ...state, checking: true };
    case 'up-to-date':
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'up-to-date',
        lastError: null,
        lastErrorKind: null,
        availableVersion: null,
        downloaded: false,
        // Current again. Either the update was installed, or the feed rolled
        // back to what we run; either way there is nothing to nag about.
        staleSince: null,
      };
    case 'available':
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'update-available',
        lastError: null,
        lastErrorKind: null,
        availableVersion: event.version,
        // What is staged on disk is the older build; it is not this version.
        downloaded: state.downloaded && state.availableVersion === event.version,
        // First sighting starts the clock; later sightings do NOT restart it.
        staleSince: state.staleSince ?? event.at,
      };
    case 'downloaded':
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'downloaded',
        lastError: null,
        lastErrorKind: null,
        availableVersion: event.version,
        downloaded: true,
        staleSince: state.staleSince ?? event.at,
      };
    case 'error':
      // An error CLEARS neither the previous availableVersion nor `downloaded`
      // (a already-downloaded update is still installable), but it does record
      // that this check failed — never reported as up to date.
      return {
        ...state,
        checking: false,
        lastCheckedAt: event.at,
        lastResult: 'error',
        lastError: event.message,
        lastErrorKind: event.kind,
      };
  }
}

export function persistedOf(state: UpdaterState): PersistedUpdaterState {
  return {
    lastCheckedAt: state.lastCheckedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    availableVersion: state.availableVersion,
    staleSince: state.staleSince,
  };
}

/**
 * True when version `a` is the same as or older than `b`. Numeric core first;
 * on a tie a prerelease (`1.0.0-rc.1`) is older than its release (`1.0.0`), per
 * semver, and prerelease identifiers compare numerically when both are numbers.
 */
function versionAtMost(a: string, b: string): boolean {
  const [coreA = '', preA] = a.split(/-(.*)/s);
  const [coreB = '', preB] = b.split(/-(.*)/s);
  const pa = coreA.split('.').map((n) => Number.parseInt(n, 10));
  const pb = coreB.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a === b;
    if (x !== y) return x < y;
  }
  if (preA === undefined) return preB === undefined;
  if (preB === undefined) return true;
  const ia = preA.split('.');
  const ib = preB.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return true;
    if (y === undefined) return false;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y);
    if (nx !== ny) return nx;
    return x < y;
  }
  return true;
}

/** Build the initial state from the running app plus whatever was persisted. */
export function initialUpdaterState(args: {
  currentVersion: string;
  gitSha: string | null;
  builtAt: string | null;
  feedUrl: string | null;
  disabledReason: string | null;
  persisted: PersistedUpdaterState;
}): UpdaterState {
  // The persisted "waiting" version may be the one we are now running: the
  // install worked and the binary was replaced, but the file still names it.
  const installed =
    args.persisted.availableVersion !== null &&
    versionAtMost(args.persisted.availableVersion, args.currentVersion);
  const persisted: PersistedUpdaterState = installed
    ? { ...args.persisted, availableVersion: null, staleSince: null, lastResult: null }
    : args.persisted;
  // `downloaded` is false below, so the result the panel reads must agree: a
  // persisted 'downloaded' would say "ready — restart to apply" with the banner
  // hidden and Restart refused. Until electron-updater re-confirms the staged
  // file, the honest reading is that an update is available.
  const lastResult =
    persisted.lastResult === 'downloaded' ? 'update-available' : persisted.lastResult;
  return {
    currentVersion: args.currentVersion,
    gitSha: args.gitSha,
    builtAt: args.builtAt,
    feedUrl: args.feedUrl,
    disabledReason: args.disabledReason,
    lastCheckedAt: persisted.lastCheckedAt,
    lastResult,
    lastError: persisted.lastError,
    lastErrorKind: persisted.lastResult === 'error' ? 'check' : null,
    availableVersion: persisted.availableVersion,
    downloaded: false, // a downloaded update does not survive a relaunch decision.
    checking: false,
    // A relaunch is not an install: the shell that comes back is the same
    // build, so if it was behind before it is behind now. Only `quitAndInstall`
    // clears this, and it clears it by replacing the binary.
    staleSince: persisted.staleSince,
  };
}

/**
 * The exact sequence that makes "restart to install" actually restart.
 *
 * Two things have to be true or the install is a silent no-op:
 *
 *  1. `app.isQuitting` must ALREADY be set. `quitAndInstall` works by closing
 *     every window and then quitting, but main.ts's `close` handler
 *     `preventDefault()`s and hides any close it hasn't been told is a real
 *     quit (Cmd+W hides; the tray app stays alive). Without the flag the window
 *     merely hides, no window ever closes, `app.quit()` is never reached, and
 *     the shell carries on running the OLD build — which is exactly what
 *     "restart to install just closes the window" was.
 *  2. `isForceRunAfter` must be true, so the installer relaunches the shell
 *     instead of leaving the user with no app at all.
 *
 * Every install path goes through here rather than touching `autoUpdater`
 * directly, so a third call site can't reintroduce the bug. Dependencies are
 * injected because main.ts imports electron and so is not importable under
 * node:test; this keeps the ordering rule unit-testable.
 *
 * If the install is REFUSED — Squirrel.Mac throws synchronously when it won't
 * apply an update to an adhoc/invalid signature — the flag goes back and the
 * error is handed to `onError` for the panel. Since there is no longer a
 * "restart to install" prompt to fall back to (every download installs itself),
 * that error line is the only way a broken updater reaches the user, so it must
 * never be swallowed and must not leave the app armed to quit on the next Cmd+W.
 */
/**
 * How long to give a successful-looking `quitAndInstall()` call before
 * concluding it silently stalled. electron-updater relaunches within a few
 * seconds on a healthy install; this is generous headroom above that.
 *
 * Found live: Squirrel.Mac's ShipIt helper can take the install request and
 * then wedge — a FileCoordination claim granted and never released, no error
 * event, no relaunch — leaving the old process running indefinitely. Nothing
 * upstream of this ever reported that as a failure, so pressing "Restart now"
 * looked like it did nothing at all.
 */
export const INSTALL_WATCHDOG_MS = 20_000;

/**
 * An updater error as one short clause for the banner, which prefixes it with
 * "Couldn't install Patch <version>:". Squirrel's messages carry the full
 * file:// path of the staged bundle, which says nothing to the person reading.
 */
export function conciseReason(message: string): string {
  return (message.split('\n')[0] ?? '')
    .replace(/\s*at URL\s+\S+/gi, '')
    .replace(/\s*\S+:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}

export function quitAndInstallNow(deps: {
  app: { isQuitting: boolean };
  autoUpdater: { quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void };
  onError: (err: Error) => void;
  /**
   * Clears whatever wedged the install (kills the stuck ShipIt helper) so the
   * install can be asked for again. Called once, on the first stall: a wedged
   * helper is the app's fault to repair, not the user's to quit around.
   */
  recoverStall?: () => void;
  /**
   * The updater's error since this update finished downloading, if any.
   * electron-updater says "downloaded" before Squirrel.Mac has staged the
   * update; when Squirrel then fails, that error is why no install will come,
   * and it is what the user is told — not that the installer stalled.
   */
  pendingError?: () => string | null;
  /**
   * True once the app has actually begun shutting down (`will-quit` fired).
   * The quit then waits on the local server stopping, which can outlast the
   * watchdog; that is the install going ahead, not a stall. Killing ShipIt
   * then removed the very helper waiting to relaunch the app, so it closed and
   * stayed closed.
   */
  shuttingDown?: () => boolean;
  /** Test seam for the stall watchdog below; real callers get the real timer. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}): void {
  const schedule = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const attempt = (retriesLeft: number): void => {
    deps.app.isQuitting = true;
    try {
      deps.autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      deps.app.isQuitting = false;
      deps.onError(err as Error);
      return;
    }
    // A call that returns without throwing is not proof the install is
    // happening. If it genuinely is, this process exits before the timer below
    // ever fires, so firing at all IS the evidence of a stall, not a guess.
    const watchdog = schedule(() => {
      if (deps.shuttingDown?.()) return;
      deps.app.isQuitting = false;
      const reason = deps.pendingError?.();
      if (reason) {
        deps.onError(new Error(conciseReason(reason)));
        return;
      }
      if (retriesLeft > 0 && deps.recoverStall) {
        try {
          deps.recoverStall();
        } catch (err) {
          deps.onError(
            new Error(`the installer stalled and couldn't be reset (${(err as Error).message})`),
          );
          return;
        }
        attempt(retriesLeft - 1);
        return;
      }
      deps.onError(new Error("the installer didn't respond"));
    }, INSTALL_WATCHDOG_MS);
    watchdog.unref?.();
  };
  attempt(1);
}

/**
 * The Restart button's entry point: install only what has finished downloading.
 * With nothing staged `quitAndInstall` is a silent no-op, which the stall
 * watchdog would then misread as a wedged ShipIt — so refuse up front, loudly.
 */
export function installDownloaded(
  state: UpdaterState,
  deps: Parameters<typeof quitAndInstallNow>[0],
): void {
  if (!state.downloaded) {
    deps.onError(new Error("it hasn't finished downloading"));
    return;
  }
  const reason = deps.pendingError?.();
  if (reason) {
    deps.onError(new Error(conciseReason(reason)));
    return;
  }
  quitAndInstallNow(deps);
}

/**
 * How loudly the pending-update banner should speak, by how long this shell has
 * been behind.
 *
 * Modelled on Chrome, which is the only updater most people tolerate: it never
 * relaunches itself, it just puts a button in the corner and lets it change
 * colour — green, then amber, then red — until you press it. Slack's contribution
 * is the wording: say which version is waiting and what pressing it does.
 *
 * The thresholds are shorter than Chrome's 2/4/7 days because restarting Patch
 * costs seconds and it ships many times a day, but the shape is the same: the
 * first hours are quiet, and it only becomes insistent once being behind is a
 * real fact about the install rather than a deploy that landed a minute ago.
 *
 * This is deliberately NOT a countdown to a forced restart. There is no forced
 * restart; the escalation is the whole mechanism.
 */
export type UpdateUrgency = 'none' | 'ready' | 'due' | 'overdue';

/** Behind for less than this, the banner is quiet and informational. */
export const URGENCY_DUE_MS = 8 * 60 * 60 * 1000;
/** Behind for longer than this, the banner is at its loudest. */
export const URGENCY_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

export function updateUrgency(staleSince: string | null, now: number): UpdateUrgency {
  if (staleSince === null) return 'none';
  const since = Date.parse(staleSince);
  // An unparseable timestamp must not silently mean "not stale" — we know the
  // shell is behind, we just can't age it, so show it at its quietest rather
  // than hiding it.
  if (Number.isNaN(since)) return 'ready';
  const age = now - since;
  if (age >= URGENCY_OVERDUE_MS) return 'overdue';
  if (age >= URGENCY_DUE_MS) return 'due';
  return 'ready';
}

/** How long one update check may run before it is recorded as a failure. */
export const UPDATE_CHECK_TIMEOUT_MS = 2 * 60_000;

/**
 * One update check, bounded and single-flight. Dependencies are injected for
 * the same reason as `quitAndInstallNow`: main.ts imports electron.
 *
 * Without the bound, a feed that accepted the request and never answered left
 * `checking: true` for good and "Check now" awaiting forever; without
 * single-flight, each hourly re-check stacked another call on top of the stuck
 * one. Both ends are recorded as an `error` — never a quiet "up to date".
 */
export function createCheckRunner(deps: {
  start: () => void;
  record: (event: UpdaterEvent) => void;
  check: () => Promise<unknown>;
  /** True when the check emitted an outcome (events arrive via electron-updater). */
  hasOutcomeSinceStart: () => boolean;
  /** Reason to give when the check resolved but nothing answered. */
  silentReason?: () => string | null;
  timeoutMs?: number;
}): () => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  let inFlight: Promise<void> | null = null;
  const fail = (message: string): void =>
    deps.record({ type: 'error', kind: 'check', message, at: new Date().toISOString() });

  const run = async (): Promise<void> => {
    deps.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([deps.check().then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        fail(
          `update check timed out after ${Math.round(timeoutMs / 1000)}s — the feed did not answer`,
        );
        return;
      }
    } catch (err) {
      fail((err as Error).message);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!deps.hasOutcomeSinceStart()) {
      fail(
        deps.silentReason?.() ??
          'the updater returned no result (no update feed answered this check)',
      );
    }
  };

  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Write the persisted state so a crash mid-write can never leave a truncated
 * file where the last good one was: stage to a sibling temp file, then rename
 * over the target. Dependencies are injected so the failure path is testable.
 */
export function savePersisted(
  file: string,
  state: PersistedUpdaterState,
  fs: {
    writeFile: (path: string, data: string) => void;
    rename: (from: string, to: string) => void;
  },
): void {
  const tmp = `${file}.tmp`;
  fs.writeFile(tmp, JSON.stringify(state, null, 2));
  fs.rename(tmp, file);
}

/**
 * The Restart button's handler, for the lifetime of the app. Pressing Restart
 * while an install is still pending (the watchdog gives it 20s) used to start a
 * second, independent install chain: two `quitAndInstall` calls, two ShipIt
 * kills, two error reports. The check path is single-flight; the install path
 * must be too. The latch releases when the attempt is reported as failed, so
 * the user can always try again after being told it did not work.
 */
export function createInstaller(
  deps: Parameters<typeof quitAndInstallNow>[0],
): (state: UpdaterState) => void {
  let pending = false;
  return (state) => {
    if (pending) return;
    pending = true;
    installDownloaded(state, {
      ...deps,
      onError: (err) => {
        pending = false;
        deps.onError(err);
      },
    });
  };
}

/** How long "Restart Patch" waits for a newer build to finish downloading. */
export const LATEST_DOWNLOAD_WAIT_MS = 4 * 60_000;

/**
 * "Restart Patch" always lands on the newest published build. Patch ships ~20
 * times a day, so the build staged on disk when the button is pressed is often
 * already one or more deploys old; installing it relaunches into a build that
 * the next check immediately flags as behind, and the banner comes straight
 * back — "multiple updates queued". So the press first asks the feed again,
 * waits for anything newer to finish downloading, and only then installs.
 *
 * Single-flight: pressing again while this is in progress joins it. Failures
 * (check error, download never finishing) go to `onError`, never swallowed.
 */
export function createLatestInstaller(deps: {
  check: () => Promise<void>;
  getState: () => UpdaterState;
  install: (state: UpdaterState) => void;
  onError: (err: Error) => void;
  waitMs?: number;
  pollMs?: number;
}): () => Promise<void> {
  const waitMs = deps.waitMs ?? LATEST_DOWNLOAD_WAIT_MS;
  const pollMs = deps.pollMs ?? 250;
  let inFlight: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    await deps.check();
    const checked = deps.getState();
    if (checked.lastResult === 'error' && checked.lastErrorKind === 'check') {
      deps.onError(new Error(conciseReason(checked.lastError ?? 'the update check failed')));
      return;
    }
    const deadline = Date.now() + waitMs;
    // A newer build is "available" with downloaded=false until its own
    // download lands (the reducer drops `downloaded` for a different version).
    while (!deps.getState().downloaded) {
      if (deps.getState().lastResult === 'up-to-date' || Date.now() >= deadline) {
        deps.onError(new Error("the latest build hasn't finished downloading"));
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    deps.install(deps.getState());
  };
  return () => {
    inFlight ??= run()
      .catch((err) => deps.onError(err as Error))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
