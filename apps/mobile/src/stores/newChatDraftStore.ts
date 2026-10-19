// New-chat drafts (spec/15 § New chat flow, spec/14 § New chat drafts) — a
// not-yet-spawned new chat: an id of its own, the host + folder it will spawn
// on, an optional model, and unsent composer text. Mirrors web's
// `stores/draftStore.ts`, synced through the SAME server store (reusing
// composer-drafts.ts's plumbing, spec/14) so the phone's Drafts list is the
// same list desktop shows, live.
//
// SERVER-OWNED: editing debounces a `new_chat_draft.set` to the server; every
// other open surface hears the change as `new_chat_draft.updated`/`removed`.
// MMKV is kept as a write-through cache purely so a relaunch offline doesn't
// lose what's there — the server is the source of truth once reachable.
//
// A draft only exists while it has TEXT (`hasDraftText`, shared with
// composer drafts): a blank just-opened draft, and one typed into and then
// emptied again, are the same thing and neither is listed, kept, nor sent to
// the server.
//
// NO FALLBACK: a corrupt/absent cache yields an empty set, never a
// silently-wrong draft.

import { create } from 'zustand';
import type { WireEvent } from '@patch/wire';
import { store } from '../lib/credential';
import { getWs } from '../api/ws';
import { useUiStore } from './uiStore';

/** How long after the last local edit we wait before telling the server. */
export const DRAFT_SEND_DEBOUNCE_MS = 400;

const CACHE_KEY = 'patch.newChatDrafts.v1';
/** The mobile single-draft key composer-drafts.ts used before this build
 * (`NEW_CHAT_DRAFT_KEY` in `lib/newChat.ts`) — read once, then removed. */
const OLD_SINGLE_DRAFT_KEY = 'patch.composerDraft:new';

const SAVE_FAILED_MESSAGE = 'Couldn’t save your draft — it will be lost if you reload.';
const NOT_CONNECTED_MESSAGE = 'PatchWs: not connected';

/** True when `text` is a real draft — not empty, not whitespace-only. Same
 * rule as `lib/composerDraft.ts`'s `hasDraftText`. */
export function hasDraftText(text: string): boolean {
  return text.trim() !== '';
}

export interface NewChatDraft {
  id: string;
  folder: string;
  hostId?: string;
  model?: string;
  text: string;
  updatedAt: number;
}

interface CachedShape {
  drafts: Record<string, NewChatDraft>;
  order: string[];
}

function parseCached(raw: string): CachedShape {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) return { drafts: {}, order: [] };
  const p = parsed as { drafts?: unknown; order?: unknown };
  const drafts: Record<string, NewChatDraft> = {};
  if (p.drafts && typeof p.drafts === 'object') {
    for (const [id, d] of Object.entries(p.drafts as Record<string, unknown>)) {
      const dd = d as Partial<NewChatDraft>;
      if (typeof dd.folder === 'string' && typeof dd.text === 'string') {
        drafts[id] = {
          id,
          folder: dd.folder,
          text: dd.text,
          ...(typeof dd.model === 'string' ? { model: dd.model } : {}),
          ...(typeof dd.hostId === 'string' ? { hostId: dd.hostId } : {}),
          updatedAt: typeof dd.updatedAt === 'number' ? dd.updatedAt : 0,
        };
      }
    }
  }
  const order = Array.isArray(p.order)
    ? (p.order as unknown[]).filter((x): x is string => typeof x === 'string' && x in drafts)
    : Object.keys(drafts);
  for (const id of Object.keys(drafts)) if (!order.includes(id)) order.push(id);
  return { drafts, order };
}

function loadCache(): CachedShape {
  try {
    const raw = store().getString(CACHE_KEY);
    if (!raw) return { drafts: {}, order: [] };
    return parseCached(raw);
  } catch {
    return { drafts: {}, order: [] };
  }
}

function persist(drafts: Record<string, NewChatDraft>, order: string[]): void {
  try {
    store().set(CACHE_KEY, JSON.stringify({ drafts, order }));
  } catch (err) {
    useUiStore.getState().pushError(`${SAVE_FAILED_MESSAGE} (${(err as Error).message})`);
  }
}

function makeId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Migrate the phone's old single new-chat draft (text only — folder/model
 * were never persisted on the phone) into one real draft, owed to the server.
 */
function migrateOldSingleDraft(): { cached: CachedShape; pending: string[] } | null {
  let text: string | undefined;
  try {
    text = store().getString(OLD_SINGLE_DRAFT_KEY);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  try {
    store().delete(OLD_SINGLE_DRAFT_KEY);
  } catch {
    // Best-effort cleanup only.
  }
  if (!hasDraftText(text)) return { cached: { drafts: {}, order: [] }, pending: [] };
  const id = makeId();
  const draft: NewChatDraft = { id, folder: '', text, updatedAt: Date.now() };
  const cached = { drafts: { [id]: draft }, order: [id] };
  persist(cached.drafts, cached.order);
  return { cached, pending: [id] };
}

interface PendingRemote {
  entry: NewChatDraft | null;
  updatedAt: number;
}

interface NewChatDraftState {
  drafts: Record<string, NewChatDraft>;
  order: string[];
  focused: Record<string, boolean>;
  pendingRemote: Record<string, PendingRemote>;
  create(folder?: string): string;
  update(
    id: string,
    patch: Partial<Pick<NewChatDraft, 'folder' | 'text' | 'model' | 'hostId'>>,
  ): void;
  remove(id: string): void;
  pruneBlank(keepId?: string): void;
  get(id: string): NewChatDraft | undefined;
  setFocused(id: string, isFocused: boolean): string | undefined;
  applyDraftList(
    entries: {
      id: string;
      folder: string;
      hostId?: string;
      model?: string;
      text: string;
      updatedAt: number;
    }[],
  ): void;
  applyDraftUpdated(entry: {
    id: string;
    folder: string;
    hostId?: string;
    model?: string;
    text: string;
    updatedAt: number;
  }): void;
  applyDraftCleared(id: string, updatedAt: number): void;
  resendPendingOnReconnect(): void;
  _reset(): void;
}

const localEditAt = new Map<string, number>();
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingOp = new Set<string>();

function cancelSendTimer(id: string): void {
  const timer = sendTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    sendTimers.delete(id);
  }
}

function armSendTimer(id: string): void {
  cancelSendTimer(id);
  sendTimers.set(
    id,
    setTimeout(() => {
      sendTimers.delete(id);
      flushPending(id);
    }, DRAFT_SEND_DEBOUNCE_MS),
  );
}

function flushPending(id: string): void {
  if (!pendingOp.has(id)) return;
  const draft = useNewChatDraftStore.getState().drafts[id];
  const event: WireEvent =
    draft && hasDraftText(draft.text)
      ? {
          type: 'new_chat_draft.set',
          draft: {
            id,
            folder: draft.folder,
            text: draft.text,
            ...(draft.hostId !== undefined ? { hostId: draft.hostId } : {}),
            ...(draft.model !== undefined ? { model: draft.model } : {}),
          },
        }
      : { type: 'new_chat_draft.remove', id };
  try {
    getWs().send(event);
    pendingOp.delete(id);
  } catch (err) {
    if ((err as Error).message === NOT_CONNECTED_MESSAGE) return;
    useUiStore.getState().pushError(`${SAVE_FAILED_MESSAGE} (${(err as Error).message})`);
  }
}

const migrated = migrateOldSingleDraft();
const initial = migrated?.cached ?? loadCache();
for (const id of migrated?.pending ?? []) pendingOp.add(id);

export const useNewChatDraftStore = create<NewChatDraftState>((set, get) => ({
  drafts: initial.drafts,
  order: initial.order,
  focused: {},
  pendingRemote: {},

  create(folder) {
    const id = makeId();
    const draft: NewChatDraft = { id, folder: folder ?? '', text: '', updatedAt: Date.now() };
    const drafts = { ...get().drafts, [id]: draft };
    const order = [id, ...get().order];
    persist(drafts, order);
    set({ drafts, order });
    return id;
  },

  update(id, patch) {
    const cur = get().drafts[id];
    if (!cur) return;
    const next: NewChatDraft = { ...cur, ...patch, updatedAt: Date.now() };
    const drafts = { ...get().drafts, [id]: next };
    const order = [id, ...get().order.filter((x) => x !== id)];
    persist(drafts, order);
    set({ drafts, order });
    localEditAt.set(id, Date.now());
    pendingOp.add(id);
    armSendTimer(id);
  },

  remove(id) {
    cancelSendTimer(id);
    localEditAt.set(id, Date.now());
    if (get().drafts[id]) {
      const drafts = { ...get().drafts };
      delete drafts[id];
      const order = get().order.filter((x) => x !== id);
      persist(drafts, order);
      set({ drafts, order });
    }
    if (id in get().pendingRemote) {
      const pendingRemote = { ...get().pendingRemote };
      delete pendingRemote[id];
      set({ pendingRemote });
    }
    pendingOp.add(id);
    flushPending(id);
  },

  pruneBlank(keepId) {
    const cur = get().drafts;
    const dead = Object.keys(cur).filter((id) => id !== keepId && !hasDraftText(cur[id]!.text));
    if (dead.length === 0) return;
    const drafts = { ...cur };
    for (const id of dead) delete drafts[id];
    const order = get().order.filter((x) => !dead.includes(x));
    persist(drafts, order);
    set({ drafts, order });
  },

  get(id) {
    return get().drafts[id];
  },

  setFocused(id, isFocused) {
    const wasFocused = get().focused[id] === true;
    set({ focused: { ...get().focused, [id]: isFocused } });
    if (isFocused || !wasFocused) return undefined;
    const pending = get().pendingRemote[id];
    if (!pending) return undefined;
    const pendingRemote = { ...get().pendingRemote };
    delete pendingRemote[id];
    set({ pendingRemote });
    if (pending.updatedAt <= (localEditAt.get(id) ?? 0)) return undefined;
    if (pending.entry === null) {
      const drafts = { ...get().drafts };
      delete drafts[id];
      const order = get().order.filter((x) => x !== id);
      persist(drafts, order);
      set({ drafts, order });
      return '';
    }
    const drafts = { ...get().drafts, [id]: pending.entry };
    const order = get().order.includes(id) ? get().order : [id, ...get().order];
    persist(drafts, order);
    set({ drafts, order });
    return pending.entry.text;
  },

  applyDraftList(entries) {
    const incoming = new Map(entries.map((e) => [e.id, e]));
    const drafts = { ...get().drafts };
    const pendingRemote = { ...get().pendingRemote };
    const focused = get().focused;
    let order = get().order;
    for (const e of entries) {
      const entry: NewChatDraft = {
        id: e.id,
        folder: e.folder,
        text: e.text,
        updatedAt: e.updatedAt,
        ...(e.hostId !== undefined ? { hostId: e.hostId } : {}),
        ...(e.model !== undefined ? { model: e.model } : {}),
      };
      if (focused[e.id]) {
        pendingRemote[e.id] = { entry, updatedAt: e.updatedAt };
        continue;
      }
      if (pendingOp.has(e.id)) continue;
      drafts[e.id] = entry;
      if (!order.includes(e.id)) order = [e.id, ...order];
    }
    for (const id of Object.keys(drafts)) {
      if (incoming.has(id) || pendingOp.has(id) || focused[id] || !hasDraftText(drafts[id]!.text)) {
        continue;
      }
      delete drafts[id];
      order = order.filter((x) => x !== id);
    }
    persist(drafts, order);
    set({ drafts, order, pendingRemote });
  },

  applyDraftUpdated(entry) {
    pendingOp.delete(entry.id);
    const draft: NewChatDraft = {
      id: entry.id,
      folder: entry.folder,
      text: entry.text,
      updatedAt: entry.updatedAt,
      ...(entry.hostId !== undefined ? { hostId: entry.hostId } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
    };
    if (get().focused[entry.id]) {
      set({
        pendingRemote: {
          ...get().pendingRemote,
          [entry.id]: { entry: draft, updatedAt: entry.updatedAt },
        },
      });
      return;
    }
    const drafts = { ...get().drafts, [entry.id]: draft };
    const order = get().order.includes(entry.id) ? get().order : [entry.id, ...get().order];
    persist(drafts, order);
    set({ drafts, order });
  },

  applyDraftCleared(id, updatedAt) {
    pendingOp.delete(id);
    if (get().focused[id]) {
      set({ pendingRemote: { ...get().pendingRemote, [id]: { entry: null, updatedAt } } });
      return;
    }
    if (!(id in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[id];
    const order = get().order.filter((x) => x !== id);
    persist(drafts, order);
    set({ drafts, order });
  },

  resendPendingOnReconnect() {
    for (const id of [...pendingOp]) flushPending(id);
  },

  _reset() {
    for (const timer of sendTimers.values()) clearTimeout(timer);
    sendTimers.clear();
    pendingOp.clear();
    localEditAt.clear();
    try {
      store().delete(CACHE_KEY);
      store().delete(OLD_SINGLE_DRAFT_KEY);
    } catch {
      // Nothing to clear if storage is unavailable.
    }
    set({ drafts: {}, order: [], focused: {}, pendingRemote: {} });
  },
}));
