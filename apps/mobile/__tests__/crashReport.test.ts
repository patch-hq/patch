// lib/crashReport.ts — every caught crash is persisted first, then sent to the
// server; undelivered ones stay queued and are re-sent on the next launch.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { reportCrash } = vi.hoisted(() => ({ reportCrash: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: { reportCrash },
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { CLIENT_CRASH_LIMITS } from '@patch/wire';
import { ApiError } from '../src/api/rest';
import { store } from '../src/lib/credential';
import {
  recordCrash,
  flushPendingCrashes,
  installGlobalCrashHandler,
  collectNativeCrash,
  setCrashContext,
} from '../src/lib/crashReport';
import { NativeModules, Platform } from 'react-native';
import { useUiStore } from '../src/stores/uiStore';
import { clearExitLog, readExitLog, setTelemetryEnabled } from '../src/lib/exitLog';

const pending = (): unknown[] => JSON.parse(store().getString('patch.crash.pending') ?? '[]');

beforeEach(() => {
  reportCrash.mockReset();
  store().delete('patch.crash.pending');
  store().delete('patch.exitSession.v1');
  clearExitLog();
  setTelemetryEnabled(true);
  setCrashContext({});
  Platform.OS = 'test';
  delete (NativeModules as Record<string, unknown>)['PatchCrash'];
});

describe('recordCrash', () => {
  it('sends the error, stack and open chat id, and clears the queue on success', async () => {
    reportCrash.mockResolvedValue({ ok: true });
    setCrashContext({ chatId: 'chat-9' });
    await recordCrash({ source: 'global', message: 'boom', stack: 'at x' });
    expect(reportCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'global',
        message: 'boom',
        stack: 'at x',
        chatId: 'chat-9',
      }),
    );
    expect(pending()).toEqual([]);
  });

  it('keeps an undeliverable report queued, says so, and resends it later', async () => {
    reportCrash.mockRejectedValueOnce(new Error('offline'));
    await recordCrash({ source: 'boundary', message: 'boom', chatId: 'c' });
    expect(pending()).toHaveLength(1);
    expect(JSON.stringify(useUiStore.getState().errors)).toContain('crash report not delivered');
    reportCrash.mockResolvedValue({ ok: true });
    await flushPendingCrashes();
    expect(reportCrash).toHaveBeenCalledTimes(2);
    expect(pending()).toEqual([]);
  });
});

describe('server size caps', () => {
  it('truncates an oversized message, stack and componentStack to the server limits', async () => {
    reportCrash.mockResolvedValue({ ok: true });
    await recordCrash({
      source: 'boundary',
      message: 'm'.repeat(CLIENT_CRASH_LIMITS.message + 500),
      stack: 's'.repeat(CLIENT_CRASH_LIMITS.stack + 500),
      componentStack: 'c'.repeat(CLIENT_CRASH_LIMITS.componentStack + 500),
      route: 'r'.repeat(CLIENT_CRASH_LIMITS.route + 1),
    });
    const body = reportCrash.mock.calls[0]![0] as Record<string, string>;
    expect(body['message']).toHaveLength(CLIENT_CRASH_LIMITS.message);
    expect(body['stack']).toHaveLength(CLIENT_CRASH_LIMITS.stack);
    expect(body['componentStack']).toHaveLength(CLIENT_CRASH_LIMITS.componentStack);
    expect(body['route']).toHaveLength(CLIENT_CRASH_LIMITS.route);
    expect(body['message']!.startsWith('mmm')).toBe(true);
  });

  it('surfaces a server 4xx once and drops the report instead of retrying forever', async () => {
    reportCrash.mockRejectedValue(new ApiError(400, 'invalid crash report', null));
    await recordCrash({ source: 'global', message: 'bad' });
    expect(JSON.stringify(useUiStore.getState().errors)).toContain('crash report not delivered');
    expect(pending()).toEqual([]);
    await flushPendingCrashes();
    expect(reportCrash).toHaveBeenCalledTimes(1);
  });

  it('keeps a report queued on a 5xx', async () => {
    reportCrash.mockRejectedValue(new ApiError(503, 'down', null));
    await recordCrash({ source: 'global', message: 'x' });
    expect(pending()).toHaveLength(1);
  });
});

describe('installGlobalCrashHandler', () => {
  it('records the uncaught error and still calls the previous handler', () => {
    reportCrash.mockResolvedValue({ ok: true });
    const previous = vi.fn();
    let installed: (e: unknown, fatal?: boolean) => void = () => {};
    (globalThis as Record<string, unknown>)['ErrorUtils'] = {
      getGlobalHandler: () => previous,
      setGlobalHandler: (h: typeof installed) => (installed = h),
    };
    installGlobalCrashHandler();
    const err = new Error('uncaught');
    installed(err, true);
    expect(previous).toHaveBeenCalledWith(err, true);
    expect(reportCrash).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'global', message: 'uncaught', fatal: true }),
    );
  });
});

describe('collectNativeCrash', () => {
  it('reports the previous run’s native crash', async () => {
    reportCrash.mockResolvedValue({ ok: true });
    Platform.OS = 'android';
    (NativeModules as Record<string, unknown>)['PatchCrash'] = {
      takeLastCrash: async () => ({ message: 'NPE', stack: 'at Foo', occurredAt: 5 }),
    };
    await collectNativeCrash();
    expect(reportCrash).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'native', message: 'NPE', stack: 'at Foo', occurredAt: 5 }),
    );
  });

  it('does nothing when there was no crash, and throws if the module is missing', async () => {
    Platform.OS = 'android';
    (NativeModules as Record<string, unknown>)['PatchCrash'] = { takeLastCrash: async () => null };
    await collectNativeCrash();
    expect(reportCrash).not.toHaveBeenCalled();
    delete (NativeModules as Record<string, unknown>)['PatchCrash'];
    await expect(collectNativeCrash()).rejects.toThrow('PatchCrash native module missing');
  });
});

describe('sharing off', () => {
  it('logs the crash on the phone and sends nothing', async () => {
    setTelemetryEnabled(false);
    await recordCrash({ source: 'global', message: 'boom' });
    expect(reportCrash).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
    expect(readExitLog().map((e) => e.kind)).toEqual(['crash']);
  });
});
