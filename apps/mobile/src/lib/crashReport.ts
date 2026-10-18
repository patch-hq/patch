// Crash capture: what the phone does when something throws.
//
// A crash on the phone otherwise leaves no text anywhere the developer can
// read. Every caught crash — the chat-screen error boundary, the global JS
// handler, and a native crash found on the next launch — goes through
// `recordCrash`, which
//   1. persists the report to MMKV synchronously (a fatal error may kill the
//      process before any network call finishes), then
//   2. POSTs it to the server (`/api/client-crashes`, stored in the server's
//      data dir and logged at error level), removing it from MMKV on success.
// `flushPendingCrashes` re-sends whatever a previous run could not deliver.
//
// NO FALLBACK: a report that cannot be delivered stays queued and is surfaced
// through the error toasts; it is never dropped quietly. The one exception is a
// 4xx: the server rejected the report itself, so resending can never succeed —
// it is surfaced once and removed from the queue.

import { NativeModules, Platform } from 'react-native';
import { CLIENT_CRASH_LIMITS } from '@patch/wire';
import { api, ApiError, type CrashReport } from '../api/rest';
import { store } from './credential';
import { mobileBuildInfo } from './buildInfo';
import { useUiStore } from '../stores/uiStore';

const PENDING_KEY = 'patch.crash.pending';
/** Oldest reports are dropped past this, so a crash loop cannot fill storage. */
const MAX_PENDING = 20;

let context: { chatId?: string } = {};

/** The chat currently on screen, attached to any crash while it is open. */
export function setCrashContext(next: { chatId?: string }): void {
  context = next;
}

function readPending(): CrashReport[] {
  const raw = store().getString(PENDING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CrashReport[];
  } catch (err) {
    // Our own queue is corrupt: say so, and start a clean one.
    useUiStore.getState().pushError(`crash queue unreadable, discarded: ${String(err)}`);
    return [];
  }
}

function writePending(list: CrashReport[]): void {
  store().set(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
}

export function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { message: String(err) };
}

/** Cut every field to the server's cap, keeping the head (the throw site). */
export function fitToServerLimits(report: CrashReport): CrashReport {
  const out: CrashReport = { ...report };
  for (const key of Object.keys(CLIENT_CRASH_LIMITS) as (keyof typeof CLIENT_CRASH_LIMITS)[]) {
    const value = out[key];
    if (typeof value === 'string' && value.length > CLIENT_CRASH_LIMITS[key]) {
      out[key] = value.slice(0, CLIENT_CRASH_LIMITS[key]);
    }
  }
  return out;
}

async function send(report: CrashReport): Promise<void> {
  try {
    await api.reportCrash(fitToServerLimits(report));
  } catch (err) {
    useUiStore.getState().pushError(`crash report not delivered: ${String(err)}`);
    // A 4xx will never succeed on retry; keep it queued only for 5xx/network.
    if (!(err instanceof ApiError && err.status >= 400 && err.status < 500)) return;
  }
  writePending(
    readPending().filter((r) => r.occurredAt !== report.occurredAt || r.message !== report.message),
  );
}

/** Persist a crash and send it to the server. Resolves once delivery was attempted. */
export function recordCrash(
  partial: Omit<CrashReport, 'occurredAt' | 'build'> & { occurredAt?: number },
): Promise<void> {
  const info = mobileBuildInfo();
  const report: CrashReport = {
    ...(context.chatId && !partial.chatId ? { chatId: context.chatId } : {}),
    ...partial,
    occurredAt: partial.occurredAt ?? Date.now(),
    build: `${info.version}${info.gitSha ? `+${info.gitSha}` : ''}`,
  };
  writePending([...readPending(), report]);
  return send(report);
}

/** Re-send every report an earlier run persisted but could not deliver. */
export async function flushPendingCrashes(): Promise<void> {
  for (const report of readPending()) await send(report);
}

interface ErrorUtilsLike {
  getGlobalHandler: () => (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler: (h: (error: unknown, isFatal?: boolean) => void) => void;
}

/** Record every uncaught JS error, then hand it to the previous handler. */
export function installGlobalCrashHandler(): void {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!utils) throw new Error('ErrorUtils missing — cannot install the crash handler');
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    void recordCrash({ source: 'global', ...describeError(error), fatal: isFatal === true });
    previous(error, isFatal);
  });
}

interface PatchCrashModule {
  takeLastCrash: () => Promise<{ message: string; stack: string; occurredAt: number } | null>;
}

/**
 * Native (Kotlin/Java or process-level) crash of the previous run, if any. The
 * PatchCrash module wrote it to disk as the process died; reading it hands it
 * over and clears it. Android only — there is nothing native to read elsewhere.
 */
export async function collectNativeCrash(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const mod = (NativeModules as Record<string, unknown>)['PatchCrash'] as
    | PatchCrashModule
    | undefined;
  if (!mod) {
    throw new Error(
      'PatchCrash native module missing — is PatchCrashPackage registered and the prebuild current?',
    );
  }
  const crash = await mod.takeLastCrash();
  if (!crash) return;
  await recordCrash({
    source: 'native',
    message: crash.message,
    stack: crash.stack,
    occurredAt: crash.occurredAt,
    fatal: true,
  });
}

/** Everything the app does at startup for crash capture. */
export function startCrashCapture(): void {
  installGlobalCrashHandler();
  void flushPendingCrashes();
  collectNativeCrash().catch((err) =>
    useUiStore.getState().pushError(`native crash check failed: ${String(err)}`),
  );
}
