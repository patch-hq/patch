// Unit tests for the desktop shell's update state machine.
//
// The shipped app's updater had never run once, for four independent reasons, none
// of them visible from inside the app. `diagnoseUpdater` is the fix for the
// invisibility: each historical breakage must produce a specific sentence a user
// can act on. The reducer tests then pin the rule that matters most — a failed
// check is never reported as "up to date".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseUpdater,
  createInstaller,
  createLatestInstaller,
  installDownloaded,
  conciseReason,
  shouldPollFeed,
  emptyPersisted,
  initialUpdaterState,
  INSTALL_WATCHDOG_MS,
  parsePersisted,
  persistedOf,
  quitAndInstallNow,
  savePersisted,
  reduceUpdater,
  updateUrgency,
  URGENCY_DUE_MS,
  URGENCY_OVERDUE_MS,
  type UpdaterEvent,
  type UpdaterState,
} from './updater';

const AT = '2026-07-28T12:00:00.000Z';

/** A live, updatable shell — the baseline the reducer cases start from. */
function state(): UpdaterState {
  return initialUpdaterState({
    currentVersion: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    feedUrl: 'https://patch.tomchambers.me/api/desktop/',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
}

// --- diagnoseUpdater: the four real breakages ------------------------------

test('a dev run cannot self-update, and says so', () => {
  const why = diagnoseUpdater({
    isPackaged: false,
    hasUpdateConfig: false,
    version: '0.1.317',
    signed: true,
  });
  assert.match(String(why), /pnpm dev/);
});

test('a --dir build has no app-update.yml — the exact reason the shipped app never checked', () => {
  const why = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: false,
    version: '0.1.317',
    signed: true,
  });
  assert.match(String(why), /app-update\.yml/);
  assert.match(String(why), /dist:dry|--dir/);
});

test('version 0.0.0 can never compare as older than a release', () => {
  const why = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: true,
    version: '0.0.0',
    signed: true,
  });
  assert.match(String(why), /0\.0\.0/);
});

test('an adhoc-signed build is told it can check and download but not install', () => {
  // Measured against the real feed: an adhoc build downloads the update and then
  // fails Squirrel's signature validation. Verified that a SELF-SIGNED cert is
  // sufficient — the designated requirement carries no `anchor apple` clause — so
  // the message must not claim a Developer ID is required (spec/11 § Desktop code
  // signing).
  const why = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: true,
    version: '0.1.317',
    signed: false,
  });
  assert.match(String(why), /adhoc/);
  assert.match(String(why), /same code-signing certificate/);
  assert.match(String(why), /not necessarily an Apple Developer ID/);
});

test('a properly packaged, versioned, signed build is not disabled', () => {
  assert.equal(
    diagnoseUpdater({
      isPackaged: true,
      hasUpdateConfig: true,
      version: '0.1.317',
      signed: true,
    }),
    null,
  );
});

test('breakages are reported in the order a user hits them', () => {
  // Unpackaged AND unversioned AND unsigned → the unpackaged reason wins, because
  // fixing anything else first would change nothing.
  const why = diagnoseUpdater({
    isPackaged: false,
    hasUpdateConfig: false,
    version: '0.0.0',
    signed: false,
  });
  assert.match(String(why), /pnpm dev/);
});

// --- the reducer ----------------------------------------------------------

test('a check in flight keeps the previous result visible', () => {
  const s = reduceUpdater(
    { ...state(), lastResult: 'up-to-date', lastCheckedAt: AT },
    { type: 'check-started' },
  );
  assert.equal(s.checking, true);
  assert.equal(s.lastResult, 'up-to-date', 'blanking it would look like "never checked"');
  assert.equal(s.lastCheckedAt, AT);
});

test('up-to-date records the check time and clears any prior availability', () => {
  const s = reduceUpdater(
    { ...state(), availableVersion: '0.1.318', downloaded: true },
    { type: 'up-to-date', at: AT },
  );
  assert.equal(s.lastResult, 'up-to-date');
  assert.equal(s.lastCheckedAt, AT);
  assert.equal(s.availableVersion, null);
  assert.equal(s.downloaded, false);
  assert.equal(s.checking, false);
});

test('an available update records the offered version', () => {
  const s = reduceUpdater(state(), { type: 'available', version: '0.1.318', at: AT });
  assert.equal(s.lastResult, 'update-available');
  assert.equal(s.availableVersion, '0.1.318');
  assert.equal(s.downloaded, false);
});

test('a downloaded update becomes installable', () => {
  const s = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  assert.equal(s.lastResult, 'downloaded');
  assert.equal(s.downloaded, true);
  assert.equal(s.availableVersion, '0.1.318');
});

test('a FAILED check is never reported as up to date', () => {
  // The whole point: "I checked, nothing new" and "I could not check" must be
  // distinguishable. The old code swallowed the error entirely.
  const s = reduceUpdater(state(), {
    type: 'error',
    kind: 'check',
    message: 'ENOTFOUND feed',
    at: AT,
  });
  assert.equal(s.lastResult, 'error');
  assert.equal(s.lastError, 'ENOTFOUND feed');
  assert.equal(s.checking, false);
  assert.notEqual(s.lastResult, 'up-to-date');
});

test('an error after a successful download leaves the update installable', () => {
  const downloaded = reduceUpdater(state(), {
    type: 'downloaded',
    version: '0.1.318',
    at: AT,
  });
  const errored = reduceUpdater(downloaded, {
    type: 'error',
    kind: 'install',
    message: 'could not get code signature for running application',
    at: AT,
  });
  assert.equal(errored.downloaded, true, 'a downloaded update is still on disk');
  assert.equal(errored.availableVersion, '0.1.318');
  assert.equal(errored.lastResult, 'error');
});

// --- persistence ---------------------------------------------------------

test('last-checked survives a relaunch', () => {
  const s = reduceUpdater(state(), { type: 'up-to-date', at: AT });
  const round = parsePersisted(JSON.stringify(persistedOf(s)));
  assert.equal(round.lastCheckedAt, AT);
  assert.equal(round.lastResult, 'up-to-date');
});

test('a corrupt state file reads as "never checked", not a fabricated time', () => {
  const p = parsePersisted('{oops');
  assert.equal(p.lastCheckedAt, null);
  assert.equal(p.lastResult, null);
});

test('a state file with junk fields is sanitised rather than trusted', () => {
  const p = parsePersisted(
    JSON.stringify({
      lastCheckedAt: 42,
      lastResult: 'nonsense',
      lastError: {},
      availableVersion: 7,
    }),
  );
  assert.equal(p.lastCheckedAt, null);
  assert.equal(p.lastResult, null);
  assert.equal(p.lastError, null);
  assert.equal(p.availableVersion, null);
});

test('initial state does not claim a downloaded update survived a relaunch', () => {
  const s = initialUpdaterState({
    currentVersion: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    feedUrl: null,
    disabledReason: null,
    persisted: {
      lastCheckedAt: AT,
      lastResult: 'downloaded',
      lastError: null,
      availableVersion: '0.1.318',
      staleSince: AT,
    },
  });
  assert.equal(s.downloaded, false, 'the downloaded file is not re-verified on boot');
  assert.equal(s.staleSince, AT, 'but being BEHIND does survive — same build, same lag');
  assert.equal(s.lastCheckedAt, AT, 'but the check history is preserved');
  assert.equal(
    s.lastResult,
    'update-available',
    'so the panel must not still say "ready — restart to apply" for a download it no longer trusts',
  );
});

test('initial state carries the disabled reason through to the panel', () => {
  const s = initialUpdaterState({
    currentVersion: '0.0.0',
    gitSha: null,
    builtAt: null,
    feedUrl: null,
    disabledReason: 'no app-update.yml',
    persisted: emptyPersisted(),
  });
  assert.equal(s.disabledReason, 'no app-update.yml');
  assert.equal(s.checking, false);
});

// --- quit-and-install ---------------------------------------------------
//
// Regression: "restart to install" closed the window and left the shell running
// on the OLD build. quitAndInstall() closes every window and then quits, but
// main.ts's `close` handler preventDefault()s any close it hasn't been told is a
// real quit (Cmd+W hides; the tray app lives on), so the window hid, no window
// ever closed, and the quit never arrived.

test('quitAndInstallNow marks the app as quitting BEFORE asking the updater to quit', () => {
  const app = { isQuitting: false };
  const seen: Array<{ isQuitting: boolean; args: [boolean, boolean] }> = [];
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: (isSilent, isForceRunAfter) =>
        seen.push({ isQuitting: app.isQuitting, args: [isSilent, isForceRunAfter] }),
    },
    onError: (err) => assert.fail(`unexpected install failure: ${err.message}`),
  });
  assert.deepEqual(
    seen,
    [{ isQuitting: true, args: [false, true] }],
    'without the flag the close handler hides the window and swallows the quit',
  );
});

test('quitAndInstallNow force-relaunches so the user gets the app back', () => {
  const app = { isQuitting: false };
  let args: [boolean, boolean] | null = null;
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: (isSilent, isForceRunAfter) => (args = [isSilent, isForceRunAfter]),
    },
    onError: (err) => assert.fail(`unexpected install failure: ${err.message}`),
  });
  assert.deepEqual(args, [false, true], 'isForceRunAfter must be true, or the shell just dies');
  assert.equal(app.isQuitting, true, 'the flag stays set through the quit');
});

test('a refused install is surfaced verbatim, not swallowed', () => {
  // Squirrel.Mac refuses to apply an update to an adhoc-signed build, throwing
  // out of quitAndInstall. With the "restart to install" prompt gone, the
  // panel's error line is the ONLY place that can reach the user.
  const app = { isQuitting: false };
  const errors: string[] = [];
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: () => {
        throw new Error('Could not get code signature for running application');
      },
    },
    onError: (err) => errors.push(err.message),
  });
  assert.deepEqual(errors, ['Could not get code signature for running application']);
  assert.equal(app.isQuitting, false, 'a failed install must not leave Cmd+W quitting the app');
});

// --- the stall watchdog: quitAndInstall() can return cleanly and still never
// quit. Found live — Squirrel.Mac's ShipIt helper took the install request,
// took a FileCoordination claim, and then wedged: no error, no relaunch, the
// old process just kept running. Nothing reported that as a failure, so
// "Restart now" looked like a dead button. -----------------------------

test('a stalled install resets the installer and retries instead of blaming the user', () => {
  const app = { isQuitting: false };
  const errors: string[] = [];
  let installs = 0;
  let recoveries = 0;
  const timers: Array<() => void> = [];
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: () => {
        installs++;
      },
    },
    recoverStall: () => {
      recoveries++;
    },
    onError: (err) => errors.push(err.message),
    setTimer: (fn, ms) => {
      assert.equal(ms, INSTALL_WATCHDOG_MS);
      timers.push(fn);
      return {};
    },
  });
  timers.shift()!(); // first stall
  assert.equal(recoveries, 1);
  assert.equal(installs, 2, 'the install is asked for again after the reset');
  assert.deepEqual(errors, []);
  assert.equal(app.isQuitting, true);
  timers.shift()!(); // stalls again
  assert.equal(recoveries, 1, 'only one reset');
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0]!, /by hand|⌘Q/);
  assert.equal(app.isQuitting, false, 'a stalled install must not leave Cmd+W quitting the app');
});

test('a reset that itself fails is reported, not retried', () => {
  const errors: string[] = [];
  let installs = 0;
  quitAndInstallNow({
    app: { isQuitting: false },
    autoUpdater: {
      quitAndInstall: () => {
        installs++;
      },
    },
    recoverStall: () => {
      throw new Error('pkill missing');
    },
    onError: (err) => errors.push(err.message),
    setTimer: (fn) => {
      fn();
      return {};
    },
  });
  assert.equal(installs, 1);
  assert.match(errors[0]!, /couldn't be reset \(pkill missing\)/);
});

test('a real relaunch never lets the watchdog speak', () => {
  // The process that would fire this timer is the one that just exited, so in
  // the success case the scheduled callback is simply never invoked — this
  // pins that quitAndInstallNow does not call onError up front regardless.
  const app = { isQuitting: false };
  quitAndInstallNow({
    app,
    autoUpdater: { quitAndInstall: () => {} },
    onError: () => assert.fail('a healthy install must not report an error before its watchdog'),
    setTimer: () => ({}), // captured but never invoked, exactly as a real exit would leave it
  });
  assert.equal(app.isQuitting, true);
});

// --- escalation: the shell no longer restarts itself, so "how long have you
// been behind" is the only pressure the user ever feels. -------------------

test('a shell that is not behind has no urgency at all', () => {
  assert.equal(updateUrgency(null, Date.now()), 'none');
});

test('freshly behind is the quiet level', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  assert.equal(updateUrgency('2026-09-17T11:00:00Z', now), 'ready');
});

test('escalates to due at 8 hours, and overdue at 3 days', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  assert.equal(updateUrgency(new Date(now - URGENCY_DUE_MS + 1000).toISOString(), now), 'ready');
  assert.equal(updateUrgency(new Date(now - URGENCY_DUE_MS).toISOString(), now), 'due');
  assert.equal(updateUrgency(new Date(now - URGENCY_OVERDUE_MS + 1000).toISOString(), now), 'due');
  assert.equal(updateUrgency(new Date(now - URGENCY_OVERDUE_MS).toISOString(), now), 'overdue');
});

test('an unparseable staleSince still shows the banner, at its quietest', () => {
  // Never silently "not stale": we know the shell is behind, we just cannot age
  // it. Going silent here would hide a real pending update.
  assert.equal(updateUrgency('not-a-date', Date.now()), 'ready');
});

test('a second update does NOT restart the staleness clock', () => {
  // The bug this prevents: Patch ships ~20x/day, so a clock reset per download
  // can never age past a few minutes and the banner would never escalate.
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'available', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: '2026-09-14T09:01:00Z' });
  // …a day and twenty deploys later…
  s = reduceUpdater(s, { type: 'available', version: '0.1.921', at: '2026-09-15T09:00:00Z' });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.921', at: '2026-09-15T09:01:00Z' });

  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
  assert.equal(s.availableVersion, '0.1.921', 'but the OFFERED version is the newest');
  assert.equal(updateUrgency(s.staleSince, Date.parse('2026-09-17T10:00:00Z')), 'overdue');
});

test('being up to date clears the clock, so the next lapse starts fresh', () => {
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'available', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
  s = reduceUpdater(s, { type: 'up-to-date', at: '2026-09-14T10:00:00Z' });
  assert.equal(s.staleSince, null);
  assert.equal(updateUrgency(s.staleSince, Date.now()), 'none');
});

test('a failed check does not clear a pending update or its clock', () => {
  // An update already on disk stays installable, and stays aged — a flaky feed
  // must not quietly reset the nag to zero.
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  s = reduceUpdater(s, {
    type: 'error',
    kind: 'check',
    message: 'ENOTFOUND',
    at: '2026-09-16T09:00:00Z',
  });
  assert.equal(s.downloaded, true);
  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
});

test('staleness survives a relaunch — the same build is still behind', () => {
  // Quitting and reopening Patch for some unrelated reason is not an install,
  // so it must not look like one and reset the nag.
  const persisted = parsePersisted(
    JSON.stringify({
      lastCheckedAt: '2026-09-14T09:00:00Z',
      lastResult: 'downloaded',
      lastError: null,
      availableVersion: '0.1.901',
      staleSince: '2026-09-14T09:00:00Z',
    }),
  );
  const s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted,
  });
  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
  assert.equal(updateUrgency(s.staleSince, Date.parse('2026-09-17T10:00:00Z')), 'overdue');
});

test('persisted state written back carries the clock', () => {
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  assert.equal(persistedOf(s).staleSince, '2026-09-14T09:00:00Z');
});

test('older persisted state (no staleSince) parses as not-behind rather than throwing', () => {
  const persisted = parsePersisted(
    JSON.stringify({ lastCheckedAt: '2026-09-14T09:00:00Z', lastResult: 'up-to-date' }),
  );
  assert.equal(persisted.staleSince, null);
});

test('an app that runs its own server has no feed to update from, and says so', () => {
  const reason = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: true,
    version: '0.1.5',
    signed: true,
    noFeedReason: 'This app runs its own server, so it has no feed to update from.',
  });
  assert.equal(reason, 'This app runs its own server, so it has no feed to update from.');
});

// "Patch sometimes locks up, maybe after an update" (Todoist 6hh3QMg45hVwMxp6).
// `await autoUpdater.checkForUpdates()` had no time limit: a feed that never
// answered left `checking: true` for good and the panel's "Check now" awaiting
// forever, and every hourly re-check piled another call on top.
test('createCheckRunner: a check that never answers ends as a recorded error, not a hang', async () => {
  const { createCheckRunner } = await import('./updater');
  const events: UpdaterEvent[] = [];
  const run = createCheckRunner({
    start: () => events.push({ type: 'check-started' }),
    record: (e) => events.push(e),
    check: () => new Promise<void>(() => {}),
    hasOutcomeSinceStart: () => false,
    timeoutMs: 30,
  });
  await run();
  const last = events[events.length - 1];
  assert.equal(last?.type, 'error');
  assert.match((last as { message: string }).message, /timed out/);
});

test('createCheckRunner: overlapping calls join one check', async () => {
  const { createCheckRunner } = await import('./updater');
  let calls = 0;
  let release!: () => void;
  const run = createCheckRunner({
    start: () => {},
    record: () => {},
    check: () => {
      calls += 1;
      return new Promise<void>((r) => (release = r));
    },
    hasOutcomeSinceStart: () => true,
    timeoutMs: 1000,
  });
  const a = run();
  const b = run();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('createCheckRunner: a check that resolves silently is an error, never up to date', async () => {
  const { createCheckRunner } = await import('./updater');
  const events: UpdaterEvent[] = [];
  const run = createCheckRunner({
    start: () => {},
    record: (e) => events.push(e),
    check: async () => {},
    hasOutcomeSinceStart: () => false,
    timeoutMs: 1000,
  });
  await run();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
});

test('after installing, the relaunched shell is not still "behind" the version it now runs', () => {
  // quitAndInstall replaces the binary but update-state.json still names the
  // version that was waiting. The new process must not inherit that clock.
  const persisted = parsePersisted(
    JSON.stringify({
      lastCheckedAt: '2026-09-14T09:00:00Z',
      lastResult: 'downloaded',
      lastError: null,
      availableVersion: '0.1.901',
      staleSince: '2026-09-14T09:00:00Z',
    }),
  );
  const s = initialUpdaterState({
    currentVersion: '0.1.901',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted,
  });
  assert.equal(s.staleSince, null);
  assert.equal(s.availableVersion, null);
  assert.equal(updateUrgency(s.staleSince, Date.parse('2026-09-17T10:00:00Z')), 'none');
});

test('a newer version appearing after a download means nothing newer is installable yet', () => {
  // Restart installs whatever is on disk. If 0.1.902 has just been offered while
  // 0.1.901 is the staged one, "ready to install" must not be claimed for 0.1.902.
  let s = state();
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: AT });
  s = reduceUpdater(s, { type: 'available', version: '0.1.902', at: '2026-07-28T13:00:00Z' });
  assert.equal(s.availableVersion, '0.1.902');
  assert.equal(s.downloaded, false);
  // Re-sighting the same staged version leaves it installable.
  let t = reduceUpdater(state(), { type: 'downloaded', version: '0.1.901', at: AT });
  t = reduceUpdater(t, { type: 'available', version: '0.1.901', at: '2026-07-28T13:00:00Z' });
  assert.equal(t.downloaded, true);
});

// --- shouldPollFeed: never poll the build's placeholder feed ----------------

test('a shell with no feed of its own never polls the placeholder in app-update.yml', () => {
  // The shipped app-update.yml points at https://updates.invalid/ — "On this Mac"
  // has no feed, so polling would record a DNS error hourly over the honest reason.
  assert.equal(shouldPollFeed({ hasUpdateConfig: true, feedUrl: null }), false);
});

test('a shell with a feed and an update config polls', () => {
  assert.equal(
    shouldPollFeed({ hasUpdateConfig: true, feedUrl: 'https://patch.example/api/desktop/' }),
    true,
  );
});

test('a shell without app-update.yml never polls, feed or not', () => {
  assert.equal(
    shouldPollFeed({ hasUpdateConfig: false, feedUrl: 'https://patch.example/api/desktop/' }),
    false,
  );
});

// --- installDownloaded: Restart with nothing staged ------------------------

test('Restart with no downloaded update records an error and never arms the quit', () => {
  // quitAndInstall with nothing staged returns without relaunching, so the
  // watchdog would pkill ShipIt, retry, and only then complain — with the app
  // armed to quit on Cmd+W throughout.
  const app = { isQuitting: false };
  const calls: string[] = [];
  const errors: Error[] = [];
  installDownloaded(
    { ...state(), downloaded: false },
    {
      app,
      autoUpdater: { quitAndInstall: () => calls.push('quitAndInstall') },
      onError: (e) => errors.push(e),
      setTimer: () => {
        calls.push('timer');
        return {};
      },
    },
  );
  assert.deepEqual(calls, []);
  assert.equal(app.isQuitting, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /finished downloading/);
});

test('Restart with a downloaded update installs it', () => {
  const app = { isQuitting: false };
  const calls: string[] = [];
  installDownloaded(
    { ...state(), downloaded: true },
    {
      app,
      autoUpdater: { quitAndInstall: () => calls.push('quitAndInstall') },
      onError: () => assert.fail('no error expected'),
      setTimer: () => ({}),
    },
  );
  assert.deepEqual(calls, ['quitAndInstall']);
  assert.equal(app.isQuitting, true);
});

test('initialUpdaterState: a prerelease that has been superseded by its release counts as installed', () => {
  const s = initialUpdaterState({
    currentVersion: '1.0.0',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://patch.example/api/desktop/',
    disabledReason: null,
    persisted: {
      ...emptyPersisted(),
      lastResult: 'update-available',
      availableVersion: '1.0.0-rc.1',
      staleSince: AT,
    },
  });
  assert.equal(s.availableVersion, null);
  assert.equal(s.staleSince, null);
});

test('initialUpdaterState: a release is not installed by running its older prerelease', () => {
  const s = initialUpdaterState({
    currentVersion: '1.0.0-rc.1',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://patch.example/api/desktop/',
    disabledReason: null,
    persisted: {
      ...emptyPersisted(),
      lastResult: 'update-available',
      availableVersion: '1.0.0',
      staleSince: AT,
    },
  });
  assert.equal(s.availableVersion, '1.0.0');
  assert.equal(s.staleSince, AT);
});

test('savePersisted: a write that dies midway leaves the previous file untouched', () => {
  const files = new Map<string, string>([['state.json', 'GOOD']]);
  const fs = {
    writeFile: (path: string, data: string) => {
      files.set(path, data.slice(0, 5)); // truncated, then the process dies
      throw new Error('disk full');
    },
    rename: (from: string, to: string) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
  };
  assert.throws(() => savePersisted('state.json', emptyPersisted(), fs), /disk full/);
  assert.equal(files.get('state.json'), 'GOOD');
});

test('savePersisted: a completed write lands at the target and leaves no temp file', () => {
  const files = new Map<string, string>();
  const fs = {
    writeFile: (path: string, data: string) => void files.set(path, data),
    rename: (from: string, to: string) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
  };
  const p = { ...emptyPersisted(), lastCheckedAt: AT };
  savePersisted('state.json', p, fs);
  assert.deepEqual([...files.keys()], ['state.json']);
  assert.deepEqual(parsePersisted(files.get('state.json') ?? ''), p);
});

// --- Restart pressed twice -------------------------------------------------

test('createInstaller: a second Restart while an install is pending does not start a second one', () => {
  const errors: string[] = [];
  let installs = 0;
  let recoveries = 0;
  const timers: Array<() => void> = [];
  const install = createInstaller({
    app: { isQuitting: false },
    autoUpdater: {
      quitAndInstall: () => {
        installs++;
      },
    },
    recoverStall: () => {
      recoveries++;
    },
    onError: (err) => errors.push(err.message),
    setTimer: (fn) => {
      timers.push(fn);
      return {};
    },
  });
  const ready = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  install(ready);
  install(ready); // the impatient second press
  assert.equal(installs, 1, 'one quitAndInstall for two presses');
  assert.equal(timers.length, 1, 'one watchdog, not two racing');
  timers.shift()!();
  timers.shift()!();
  assert.equal(recoveries, 1);
  assert.equal(errors.length, 1, 'one failure report');
});

test('createInstaller: after a reported failure the user can press Restart again', () => {
  let installs = 0;
  const install = createInstaller({
    app: { isQuitting: false },
    autoUpdater: {
      quitAndInstall: () => {
        installs++;
        throw new Error('refused');
      },
    },
    onError: () => {},
  });
  const ready = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  install(ready);
  install(ready);
  assert.equal(installs, 2);
});

// --- what failed: a check, or an install ----------------------------------
// The banner offers Restart for a downloaded update. A failed hourly CHECK
// (network blip) leaves that update installable and is no reason to put a raw
// error next to the button; a failed INSTALL is the one the button must show.

test('an error records whether it was a check or an install that failed', () => {
  const checked = reduceUpdater(state(), { type: 'error', kind: 'check', message: 'x', at: AT });
  assert.equal(checked.lastErrorKind, 'check');
  const installed = reduceUpdater(state(), {
    type: 'error',
    kind: 'install',
    message: 'x',
    at: AT,
  });
  assert.equal(installed.lastErrorKind, 'install');
});

test('a later successful outcome clears the error kind with the error', () => {
  const failed = reduceUpdater(state(), { type: 'error', kind: 'install', message: 'x', at: AT });
  for (const event of [
    { type: 'up-to-date', at: AT },
    { type: 'available', version: '0.1.318', at: AT },
    { type: 'downloaded', version: '0.1.318', at: AT },
  ] as UpdaterEvent[]) {
    const s = reduceUpdater(failed, event);
    assert.equal(s.lastError, null);
    assert.equal(s.lastErrorKind, null);
  }
});

test('a persisted error comes back as a check error — an install failure did not survive a relaunch', () => {
  const s = initialUpdaterState({
    currentVersion: '0.1.317',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://x/api/desktop/',
    disabledReason: null,
    persisted: { ...emptyPersisted(), lastResult: 'error', lastError: 'boom', lastCheckedAt: AT },
  });
  assert.equal(s.lastErrorKind, 'check');
  assert.equal(state().lastErrorKind, null);
});

// --- an install Squirrel has already failed says why ------------------------

const SQUIRREL =
  'Code signature at URL file:///Users/x/Library/Caches/io.github.tomchambers2.patch.ShipIt/update.abc/Patch.app/ ' +
  'did not pass validation: code failed to satisfy specified code requirement(s)';

test('an updater error becomes one short clause, without the bundle path', () => {
  assert.equal(
    conciseReason(SQUIRREL),
    'Code signature did not pass validation: code failed to satisfy specified code requirement(s)',
  );
  assert.equal(
    conciseReason('net::ERR_INTERNET_DISCONNECTED.\n    at foo'),
    'net::ERR_INTERNET_DISCONNECTED',
  );
});

test('Restart after Squirrel has already failed the download reports that, and never arms the quit', () => {
  const app = { isQuitting: false };
  const calls: string[] = [];
  const errors: Error[] = [];
  installDownloaded(
    { ...state(), downloaded: true, availableVersion: '1.1.37' },
    {
      app,
      autoUpdater: { quitAndInstall: () => calls.push('quitAndInstall') },
      onError: (e) => errors.push(e),
      pendingError: () => SQUIRREL,
      setTimer: () => {
        calls.push('timer');
        return {};
      },
    },
  );
  assert.deepEqual(calls, []);
  assert.equal(app.isQuitting, false);
  assert.equal(errors[0]?.message, conciseReason(SQUIRREL));
});

test('a Squirrel error during the wait is what the stall reports, not that the installer stalled', () => {
  const app = { isQuitting: false };
  const errors: Error[] = [];
  let pending: string | null = null;
  let fire: (() => void) | null = null;
  let killed = 0;
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: () => {
        pending = SQUIRREL;
      },
    },
    onError: (e) => errors.push(e),
    recoverStall: () => {
      killed += 1;
    },
    pendingError: () => pending,
    setTimer: (fn) => {
      fire = fn;
      return {};
    },
  });
  (fire as unknown as () => void)();
  assert.equal(killed, 0);
  assert.equal(app.isQuitting, false);
  assert.equal(errors[0]?.message, conciseReason(SQUIRREL));
});

// --- Update Patch goes to the newest build, not the staged one ---------------

test('createLatestInstaller: a newer deploy than the staged build is downloaded before installing', async () => {
  let current = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  const installed: string[] = [];
  const errors: string[] = [];
  const go = createLatestInstaller({
    // The re-check finds 0.1.319; its download lands a moment later.
    check: async () => {
      current = reduceUpdater(current, { type: 'available', version: '0.1.319', at: AT });
      setTimeout(() => {
        current = reduceUpdater(current, { type: 'downloaded', version: '0.1.319', at: AT });
      }, 10);
    },
    getState: () => current,
    install: (s) => installed.push(s.availableVersion ?? ''),
    onError: (e) => errors.push(e.message),
    pollMs: 2,
  });
  await go();
  assert.deepEqual(installed, ['0.1.319'], 'installs the newest build, once');
  assert.deepEqual(errors, []);
});

test('createLatestInstaller: nothing newer installs what is staged', async () => {
  let current = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  const installed: string[] = [];
  await createLatestInstaller({
    check: async () => {
      current = reduceUpdater(current, { type: 'downloaded', version: '0.1.318', at: AT });
    },
    getState: () => current,
    install: (s) => installed.push(s.availableVersion ?? ''),
    onError: () => assert.fail('no error expected'),
  })();
  assert.deepEqual(installed, ['0.1.318']);
});

test('createLatestInstaller: a download that never lands is reported, not installed over', async () => {
  let current = reduceUpdater(state(), { type: 'available', version: '0.1.319', at: AT });
  const errors: string[] = [];
  await createLatestInstaller({
    check: async () => {},
    getState: () => current,
    install: () => assert.fail('must not install'),
    onError: (e) => errors.push(e.message),
    waitMs: 20,
    pollMs: 2,
  })();
  assert.equal(errors.length, 1);
  void current;
});

test('createLatestInstaller: a failed check is reported and nothing installs', async () => {
  let current = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  const errors: string[] = [];
  await createLatestInstaller({
    check: async () => {
      current = reduceUpdater(current, {
        type: 'error',
        kind: 'check',
        message: 'feed down',
        at: AT,
      });
    },
    getState: () => current,
    install: () => assert.fail('must not install'),
    onError: (e) => errors.push(e.message),
  })();
  assert.deepEqual(errors, ['feed down']);
});

test('a quit that is already under way is not mistaken for a stalled installer', () => {
  // Stopping the local server can hold the quit past the watchdog. Treating
  // that as a stall killed ShipIt — the helper waiting to relaunch the app.
  const app = { isQuitting: false };
  let fire: (() => void) | null = null;
  let calls = 0;
  let recovered = false;
  quitAndInstallNow({
    app,
    autoUpdater: { quitAndInstall: () => void calls++ },
    recoverStall: () => (recovered = true),
    shuttingDown: () => true,
    onError: (err) => assert.fail(`unexpected install failure: ${err.message}`),
    setTimer: (fn) => ((fire = fn), {}),
  });
  fire!();
  assert.equal(recovered, false, 'ShipIt must be left alone');
  assert.equal(calls, 1, 'no second install request');
  assert.equal(app.isQuitting, true, 'still quitting');
});
