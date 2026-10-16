// batchStore — spec/15 § Batch view. The batch itself is server-owned
// (`BatchStore` on the server, `GET /api/batch`) — the same account-wide
// batch web's own sidebar shows, not a device-local one. This store is a
// thin polling mirror of that REST resource, plus the purely-local "which
// view the Chats column is showing" preference (`mode`), persisted the same
// way the Chats tab's own collapsible sections are (MMKV).

import { create } from 'zustand';
import { store } from '../lib/credential';
import { api, type BatchCheckInChoice, type BatchRecord } from '../api/rest';

export type BatchMode = 'regular' | 'batch';

const MODE_KEY = 'patch.batch.mode';

function loadMode(): BatchMode {
  const m = store().getString(MODE_KEY);
  return m === 'batch' ? m : 'regular';
}

function persistMode(m: BatchMode): void {
  store().set(MODE_KEY, m);
}

interface BatchState {
  mode: BatchMode;
  batch: BatchRecord | null;
  carryover: string[];
  loaded: boolean;

  setMode(m: BatchMode): void;
  refresh(): Promise<void>;
  start(checkIn: BatchCheckInChoice): Promise<void>;
  removeMember(chatId: string): Promise<void>;
  checkInNow(): Promise<void>;
  markOpened(chatId: string): Promise<void>;

  // Test / lifecycle helper.
  _reset(): void;
}

/**
 * Bumped when a change (start / remove / check in / mark opened) begins and
 * again when it lands. A poll that was in flight across either was answered
 * from before the change and must not overwrite it; the next poll corrects.
 */
let changeEpoch = 0;

export const useBatchStore = create<BatchState>((set) => ({
  mode: loadMode(),
  batch: null,
  carryover: [],
  loaded: false,

  setMode(m) {
    persistMode(m);
    set({ mode: m });
  },

  async refresh() {
    const epoch = changeEpoch;
    const res = await api.getBatch();
    if (epoch !== changeEpoch) return;
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async start(checkIn) {
    changeEpoch++;
    const res = await api.startBatch(checkIn);
    changeEpoch++;
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async removeMember(chatId) {
    changeEpoch++;
    const res = await api.removeBatchMember(chatId);
    changeEpoch++;
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async checkInNow() {
    changeEpoch++;
    const res = await api.checkInBatchNow();
    changeEpoch++;
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  async markOpened(chatId) {
    changeEpoch++;
    const res = await api.markBatchOpened(chatId);
    changeEpoch++;
    set({ batch: res.batch, carryover: res.carryover, loaded: true });
  },

  _reset() {
    changeEpoch++;
    set({ mode: 'regular', batch: null, carryover: [], loaded: false });
  },
}));
