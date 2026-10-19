// New-chat drafts (spec/14 § New chat drafts, spec/15 § New chat flow) — a
// not-yet-spawned new chat, synced through the SERVER so the phone's Drafts
// list is the same list desktop shows, live.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useNewChatDraftStore,
  hasDraftText,
  DRAFT_SEND_DEBOUNCE_MS,
} from '../src/stores/newChatDraftStore';
import { useUiStore } from '../src/stores/uiStore';
import { getWs } from '../src/api/ws';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

beforeEach(() => {
  vi.mocked(getWs).mockReset();
  vi.mocked(getWs).mockReturnValue({
    send: () => {
      throw new Error('PatchWs: not connected');
    },
  } as unknown as ReturnType<typeof getWs>);
  vi.useFakeTimers();
  __clearAllMmkv();
  useNewChatDraftStore.getState()._reset();
  useUiStore.setState({ errors: [] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('hasDraftText', () => {
  it('empty and whitespace-only are not drafts', () => {
    expect(hasDraftText('')).toBe(false);
    expect(hasDraftText('  \n ')).toBe(false);
    expect(hasDraftText('hi')).toBe(true);
  });
});

describe('newChatDraftStore', () => {
  it('creates a draft and returns its id', () => {
    const id = useNewChatDraftStore.getState().create('/home/tom/x');
    expect(useNewChatDraftStore.getState().drafts[id]).toMatchObject({
      id,
      folder: '/home/tom/x',
      text: '',
    });
    expect(useNewChatDraftStore.getState().order[0]).toBe(id);
  });

  it('a blank draft is never sent to the server', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    useNewChatDraftStore.getState().create('/f');
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it('updates text/folder/model/hostId and keeps the most-recent draft first', () => {
    const a = useNewChatDraftStore.getState().create();
    const b = useNewChatDraftStore.getState().create();
    useNewChatDraftStore.getState().update(a, { text: 'fix the build', hostId: 'd1' });
    expect(useNewChatDraftStore.getState().order[0]).toBe(a);
    expect(useNewChatDraftStore.getState().drafts[a]).toMatchObject({
      text: 'fix the build',
      hostId: 'd1',
    });
    expect(useNewChatDraftStore.getState().drafts[b]!.text).toBe('');
  });

  it('debounces a burst of edits, sending the full entry once after the pause', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    const id = useNewChatDraftStore.getState().create('/f');
    const s = useNewChatDraftStore.getState();
    s.update(id, { text: 'h' });
    s.update(id, { text: 'he', hostId: 'd1', model: 'opus' });
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith({
      type: 'new_chat_draft.set',
      draft: { id, folder: '/f', hostId: 'd1', model: 'opus', text: 'he' },
    });
  });

  it('emptying the text back out sends a discard', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    const id = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(id, { text: 'hi' });
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    send.mockClear();
    useNewChatDraftStore.getState().update(id, { text: '   ' });
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledWith({ type: 'new_chat_draft.remove', id });
  });

  it('remove discards immediately, not debounced', () => {
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    const id = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(id, { text: 'hi' });
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    send.mockClear();
    useNewChatDraftStore.getState().remove(id);
    expect(send).toHaveBeenCalledWith({ type: 'new_chat_draft.remove', id });
    expect(useNewChatDraftStore.getState().drafts[id]).toBeUndefined();
  });

  it('pruneBlank drops empty/whitespace drafts, sparing the one kept', () => {
    const untouched = useNewChatDraftStore.getState().create();
    const kept = useNewChatDraftStore.getState().create();
    const real = useNewChatDraftStore.getState().create();
    useNewChatDraftStore.getState().update(real, { text: 'still means something' });
    useNewChatDraftStore.getState().pruneBlank(kept);
    expect(useNewChatDraftStore.getState().drafts[untouched]).toBeUndefined();
    expect(useNewChatDraftStore.getState().drafts[kept]).toBeDefined();
    expect(useNewChatDraftStore.getState().drafts[real]).toBeDefined();
  });

  it('offline: keeps the draft locally and does not error', () => {
    const id = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(id, { text: 'typed offline' });
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    expect(useNewChatDraftStore.getState().drafts[id]!.text).toBe('typed offline');
    expect(useUiStore.getState().errors).toEqual([]);
  });

  it('reconnecting pushes a draft the server never confirmed', () => {
    const id = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(id, { text: 'typed offline' });
    vi.advanceTimersByTime(DRAFT_SEND_DEBOUNCE_MS);
    const send = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    useNewChatDraftStore.getState().resendPendingOnReconnect();
    expect(send).toHaveBeenCalledWith({
      type: 'new_chat_draft.set',
      draft: { id, folder: '/f', text: 'typed offline' },
    });
  });

  describe('receiving updates from the server', () => {
    it('applyDraftUpdated sets the draft with no local focus', () => {
      useNewChatDraftStore.getState().applyDraftUpdated({
        id: 'd1',
        folder: '/f',
        text: 'from another surface',
        updatedAt: 1000,
      });
      expect(useNewChatDraftStore.getState().drafts.d1).toMatchObject({
        folder: '/f',
        text: 'from another surface',
      });
    });

    it('applyDraftCleared drops the draft', () => {
      const id = useNewChatDraftStore.getState().create('/f');
      useNewChatDraftStore.getState().update(id, { text: 'hi' });
      useNewChatDraftStore.getState().applyDraftCleared(id, 1000);
      expect(useNewChatDraftStore.getState().drafts[id]).toBeUndefined();
    });

    it('applyDraftList never drops a write still owed to the server', () => {
      const id = useNewChatDraftStore.getState().create('/f');
      useNewChatDraftStore.getState().update(id, { text: 'not sent yet' });
      useNewChatDraftStore.getState().applyDraftList([]);
      expect(useNewChatDraftStore.getState().drafts[id]!.text).toBe('not sent yet');
    });
  });

  describe('a focused draft is never clobbered under the cursor', () => {
    it('an update while focused is held, applied on blur if newer than the last local edit', () => {
      const id = useNewChatDraftStore.getState().create('/f');
      const s = useNewChatDraftStore.getState();
      s.update(id, { text: 'my edit' });
      s.setFocused(id, true);
      s.applyDraftUpdated({
        id,
        folder: '/f',
        text: 'someone else’s newer text',
        updatedAt: Date.now() + 10_000,
      });
      expect(useNewChatDraftStore.getState().drafts[id]!.text).toBe('my edit');
      const applied = useNewChatDraftStore.getState().setFocused(id, false);
      expect(applied).toBe('someone else’s newer text');
      expect(useNewChatDraftStore.getState().drafts[id]!.text).toBe('someone else’s newer text');
    });
  });
});
