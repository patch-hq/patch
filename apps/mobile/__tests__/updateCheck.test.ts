// lib/updateCheck.ts — manual OTA check + "last checked" persistence for the
// Settings → Version panel. `__DEV__` is fixed false under test (vitest.config
// `define`); the disabled path is driven via the expo-updates stub's
// __setEnabled, and MMKV is the in-memory stub (aliased in vitest.config).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import type * as Updates from './stubs/expo-updates';
import { activeUpdateSource } from './testUtils/updateSource';

beforeEach(() => {
  vi.resetModules();
  __clearAllMmkv();
});

describe('getLastCheckedAt / recordUpdateCheck', () => {
  it('is null before any check, and returns the stamped instant after one', async () => {
    const { getLastCheckedAt, recordUpdateCheck } = await import('../src/lib/updateCheck');
    expect(getLastCheckedAt()).toBeNull();
    recordUpdateCheck('2026-07-31T09:00:00.000Z');
    expect(getLastCheckedAt()).toBe('2026-07-31T09:00:00.000Z');
  });
});

describe('runUpdateCheck', () => {
  it('returns {disabled} and does NOT record when updates are off (dev / Expo Go)', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(false);
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'disabled' });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).toBeNull();
  });

  it('returns {current} and records the check when nothing newer is available', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    await activeUpdateSource();
    Updates.__setCheckResult({ isAvailable: false });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'current' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).not.toBeNull();
  });

  it('fetches (but does NOT reload) and returns {downloaded} when an update exists', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    await activeUpdateSource();
    Updates.__setCheckResult({ isAvailable: true });
    const fetchSpy = vi.spyOn(Updates, 'fetchUpdateAsync');
    const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'downloaded' });
    expect(fetchSpy).toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).not.toBeNull();
  });

  it('returns {error} (and still records) when the check throws', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    await activeUpdateSource();
    vi.spyOn(Updates, 'checkForUpdateAsync').mockRejectedValue(new Error('network down'));
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'error', message: 'network down' });
    expect(getLastCheckedAt()).not.toBeNull();
  });

  it('returns {error} when the fetch throws after a successful check', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    await activeUpdateSource();
    Updates.__setCheckResult({ isAvailable: true });
    Updates.__setFetchError(new Error('fetch failed'));
    const { runUpdateCheck } = await import('../src/lib/updateCheck');
    expect(await runUpdateCheck()).toEqual({ status: 'error', message: 'fetch failed' });
  });

  // Module-wide invariant, not one branch of it: the ONLY reload in the app is
  // the "Restart to update" button, so no outcome of a check may reload. An
  // automatic reload is what made the app flash white and load twice
  // (spec/11 § Mobile OTA "NO automatic reload").
  it('never reloads, on any outcome', async () => {
    for (const setup of [
      (U: typeof Updates) => U.__setEnabled(false),
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setCheckResult({ isAvailable: false });
      },
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setCheckResult({ isAvailable: true });
      },
      (U: typeof Updates) => {
        U.__setEnabled(true);
        U.__setCheckResult({ isAvailable: true });
        U.__setFetchError(new Error('fetch failed'));
      },
      (U: typeof Updates) => {
        U.__setEnabled(true);
      },
    ]) {
      vi.resetModules();
      __clearAllMmkv();
      const Updates = await import('./stubs/expo-updates');
      setup(Updates);
      if (Updates.isEnabled) await activeUpdateSource();
      const reloadSpy = vi.spyOn(Updates, 'reloadAsync');
      const { runUpdateCheck } = await import('../src/lib/updateCheck');
      await runUpdateCheck();
      expect(reloadSpy).not.toHaveBeenCalled();
    }
  });

  // Before this launch is pointed at the paired server a check would ask the
  // build-time address, which serves nothing: say why instead, without the
  // network (spec/11 § Mobile updates).
  it('does not check, and says why, until this launch is pointed at the paired server', async () => {
    const Updates = await import('./stubs/expo-updates');
    Updates.__setEnabled(true);
    const checkSpy = vi.spyOn(Updates, 'checkForUpdateAsync');
    const { clearRoute, setRoute } = await import('../src/config');
    const source = await import('../src/lib/updateSource');
    const { runUpdateCheck, getLastCheckedAt } = await import('../src/lib/updateCheck');

    clearRoute();
    source.pointUpdatesAtServer();
    expect(await runUpdateCheck()).toEqual({
      status: 'error',
      message: 'This phone is not paired to a server yet.',
    });

    setRoute({ kind: 'relay', relay: { url: 'wss://relay.test', channel: 'c' } } as never);
    source.pointUpdatesAtServer();
    expect((await runUpdateCheck()) as { message: string }).toMatchObject({
      message: expect.stringMatching(/relay/),
    });

    // Newly paired: set for next launch, not this one.
    setRoute({ kind: 'direct', url: 'https://patch.test' });
    expect(source.pointUpdatesAtServer()).toEqual({
      state: 'pending',
      url: 'https://patch.test/api/mobile/updates',
    });
    expect(Updates.__override).toEqual({
      updateUrl: 'https://patch.test/api/mobile/updates',
      requestHeaders: {},
    });
    expect(await runUpdateCheck()).toEqual({
      status: 'error',
      message: 'Updates from this server start at the next launch. Restart the app.',
    });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).not.toBeNull();

    // The next launch finds the override already in place and checks.
    expect(source.pointUpdatesAtServer().state).toBe('active');
    expect(await runUpdateCheck()).toEqual({ status: 'current' });
    expect(checkSpy).toHaveBeenCalledOnce();
  });
});

// The published-APK check answers the question OTA cannot: "is there a native
// build I don't have?" It matters most exactly when OTA is broken (an APK with
// no channel), so it must not depend on the OTA path working.
describe('fetchPublishedApk', () => {
  const sidecar = {
    version: '0.1.540',
    gitSha: 'abc1234',
    builtAt: '2026-08-17T10:00:00.000Z',
    file: 'patch-abc1234.apk',
  };

  it('returns null when the box publishes no APK sidecar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect(await fetchPublishedApk()).toBeNull();
  });

  it('flags a published build this phone is not running, with a download URL', async () => {
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({ version: '0.1.500', gitSha: 'old9999' }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    const apk = await fetchPublishedApk();
    expect(apk).toMatchObject({ version: '0.1.540', gitSha: 'abc1234', newer: true });
    expect(apk?.url).toContain('/api/download/patch-abc1234.apk');
    vi.doUnmock('../src/lib/buildInfo');
  });

  it('does NOT flag a build whose commit is already running', async () => {
    // The running sha comes from an EXPO_PUBLIC_* literal Metro inlines at build
    // time, which is absent under vitest — so stub buildInfo to stand in for a
    // phone already running this exact APK.
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({ version: '0.1.540', gitSha: 'abc1234' }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect((await fetchPublishedApk())?.newer).toBe(false);
    vi.doUnmock('../src/lib/buildInfo');
  });

  // The healthy, ordinary case: an OTA has moved this phone's JS ahead of the
  // native shell it launched under, so the running commit legitimately differs
  // from — and postdates — the last APK build. A bare sha comparison would
  // wrongly flag this as "something to install"; the build-time comparison
  // does not.
  it('does NOT flag a build this phone has already moved past via OTA, even with a different commit', async () => {
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({
        version: '0.1.600',
        gitSha: 'running9',
        builtAt: '2026-08-20T00:00:00.000Z', // after sidecar.builtAt
      }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect((await fetchPublishedApk())?.newer).toBe(false);
    vi.doUnmock('../src/lib/buildInfo');
  });

  // The bug this comparison exists to catch: a phone stuck on an old native
  // runtime, where OTA has gone silent — the published APK is genuinely more
  // recent than what this phone last built, so it must be flagged even though
  // this phone's own OTA path reports nothing wrong.
  it('flags a build genuinely more recent than this phone has ever run', async () => {
    vi.doMock('../src/lib/buildInfo', () => ({
      mobileBuildInfo: () => ({
        version: '0.1.500',
        gitSha: 'stale999',
        builtAt: '2026-08-10T00:00:00.000Z', // before sidecar.builtAt
      }),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true, json: async () => sidecar })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    expect((await fetchPublishedApk())?.newer).toBe(true);
    vi.doUnmock('../src/lib/buildInfo');
  });

  // NO FALLBACK: a server error must not read as "up to date".
  it('throws on a non-404 error rather than reporting no update', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, ok: false })),
    );
    const { fetchPublishedApk } = await import('../src/lib/updateCheck');
    await expect(fetchPublishedApk()).rejects.toThrow('HTTP 500');
  });

  // spec/11 § Mobile updates: a newer build on THIS runtime arrives over the
  // air; only one on another runtime has to be installed.
  describe('needsInstall', () => {
    const newerBuild = { ...sidecar, gitSha: 'new0001', builtAt: '2099-01-01T00:00:00.000Z' };
    beforeEach(() => {
      vi.doMock('../src/lib/buildInfo', () => ({
        mobileBuildInfo: () => ({
          version: '0.1.540',
          gitSha: 'abc1234',
          builtAt: '2026-08-17T10:00:00.000Z',
        }),
      }));
    });
    afterEach(() => {
      vi.doUnmock('../src/lib/buildInfo');
    });
    const serve = (body: object) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      );

    it('is set for a newer build on another runtime', async () => {
      serve({ ...newerBuild, runtimeVersion: '0.1.7' });
      const { fetchPublishedApk } = await import('../src/lib/updateCheck');
      expect(await fetchPublishedApk()).toMatchObject({
        runtimeVersion: '0.1.7',
        needsInstall: true,
      });
    });

    it('is not set for a newer build on this phone’s own runtime — that one comes over the air', async () => {
      serve({ ...newerBuild, runtimeVersion: '0.1.6' });
      const { fetchPublishedApk } = await import('../src/lib/updateCheck');
      expect(await fetchPublishedApk()).toMatchObject({ newer: true, needsInstall: false });
    });

    it('is not set for an older build on another runtime', async () => {
      serve({ ...sidecar, builtAt: '2000-01-01T00:00:00.000Z', runtimeVersion: '0.1.5' });
      const { fetchPublishedApk } = await import('../src/lib/updateCheck');
      expect(await fetchPublishedApk()).toMatchObject({ needsInstall: false });
    });

    it('falls back to build time for a release that does not state its runtime', async () => {
      serve(newerBuild);
      const { fetchPublishedApk } = await import('../src/lib/updateCheck');
      expect(await fetchPublishedApk()).toMatchObject({ needsInstall: true });
    });
  });
});
