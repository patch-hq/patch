// batchStore — spec/14 § Batch mode. The batch itself is server-owned
// (`BatchStore` on the server, `GET /api/batch`): this store is a thin,
// polling mirror of that REST resource, plus the purely-local "which sidebar
// view is showing" preference (`mode`) every other view keeps the same way.
//
// There is nothing to compute here — no ready/done derivation, no
// notification-firing decision — because the server already decides when to
// check in and already suppresses the per-chat doorbell for a member
// (spec/09 § Chat completion). This store only shows what the server says.

import { create } from 'zustand';
import { api, type BatchCheckInChoice, type BatchRecord } from '../api/rest.js';

export type BatchMode = 'regular' | 'batch';
export type BatchSchedule = 'every-30' | 'half-hour';

const MODE_KEY = 'patch.batch.mode';

function loadMode(): BatchMode {
  /* v8 ignore next -- jsdom always defines localStorage; SSR guard unreachable under vitest. */
  if (typeof localStorage === 'undefined') return 'regular';
  const m = localStorage.getItem(MODE_KEY);
  return m === 'batch' ? m : 'regular';
}

function persistMode(m: BatchMode): void {
  /* v8 ignore next -- jsdom always defines localStorage; SSR guard unreachable under vitest. */
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(MODE_KEY, m);
}

function nextRelease(s: BatchSchedule, now = Date.now()): number {
  if (s === 'every-30') return now + 30 * 60_000;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d.getTime();
}

interface BatchState {
  mode: BatchMode;
  batch: BatchRecord | null;
  carryover: string[];
  /** True once the first `refresh()` has landed — distinguishes "no batch
   *  running" from "haven't asked the server yet" so the panel doesn't flash
   *  the empty state before the real answer arrives. */
  loaded: boolean;

  // Toggle + timer (design preview — the server takes these over once approved).
  enabled: boolean;
  schedule: BatchSchedule;
  /** Epoch ms of the next release; null when Batch is off. */
  nextReleaseAt: number | null;
  /** True once the current window has been released: the list is visible. */
  released: boolean;
  setEnabled(on: boolean): void;
  setSchedule(s: BatchSchedule): void;
  releaseNow(): void;

  setMode(m: BatchMode): void;
  refresh(): Promise<void>;
  start(checkIn: BatchCheckInChoice): Promise<void>;
  removeMember(chatId: string): Promise<void>;
  checkInNow(): Promise<void>;
  markOpened(chatId: string): Promise<void>;

  // Test / lifecycle helper.
  _reset(): void;
}

export const useBatchStore = create<BatchState>((set, get) => ({
  mode: loadMode(),
  batch: null,
  carryover: [],
  loaded: false,
  enabled: false,
  schedule: 'every-30',
  nextReleaseAt: null,
  released: false,
  setEnabled(on) {
    set({ enabled: on, released: false, nextReleaseAt: on ? nextRelease(get().schedule) : null });
  },
  setSchedule(s) {
    set({ schedule: s, nextReleaseAt: get().enabled ? nextRelease(s) : null });
  },
  releaseNow() {
    set({ released: true });
  },

  setMode(m) {
    persistMode(m);
    set({ mode: m });
  },

  async refresh() {
    const res = await api.getBatch();
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async start(checkIn) {
    const res = await api.startBatch(checkIn);
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async removeMember(chatId) {
    const res = await api.removeBatchMember(chatId);
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async checkInNow() {
    const res = await api.checkInBatchNow();
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async markOpened(chatId) {
    const res = await api.markBatchOpened(chatId);
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  _reset() {
    set({ mode: 'regular', batch: null, carryover: [], loaded: false, enabled: false, schedule: 'every-30', nextReleaseAt: null, released: false });
  },
}));
