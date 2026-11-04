// A chat the new-chat screen created before anything was sent into it
// (spec/14 § New chat drafts). The header's Call / Files / Open editor, a voice
// note and an attachment upload all create the chat first and act second, so
// the chat exists server-side while it is still empty. Left that way — nothing
// sent, nothing typed — it is deleted rather than staying in the list as an
// empty "New chat" ("new chat should only save if you type, empty chat
// nothing").
//
// Checked when the user leaves it: every route change asks about each chat
// created this way, sparing the one now on screen. A chat that has a message,
// unsent words in its composer, or a voice note or call running on it is the
// user's, and stops being watched.
//
// The watch list is kept in localStorage: a reload, a quit or a crash while the
// empty chat is open used to lose it, leaving a bare "New chat" in the sidebar
// for good. After a restart the list is checked once the chat roster has loaded.

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { clearComposerDraft, useComposerDraftStore } from '../stores/composerDraftStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';

const STORAGE_KEY = 'patch.unsentNewChats';

function load(): Set<string> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return new Set();
  try {
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) {
      throw new Error('not a list of chat ids');
    }
    return new Set(ids as string[]);
  } catch (e) {
    // Re-derivable: worst case one empty chat stays until deleted by hand.
    console.error('unsentNewChat: discarding unreadable watch list', e);
    localStorage.removeItem(STORAGE_KEY);
    return new Set();
  }
}

const unsent = load();

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...unsent]));
}

/** The new-chat screen created `chatId` before anything was sent into it. */
export function markUnsentNewChat(chatId: string): void {
  unsent.add(chatId);
  save();
}

function hasContent(chatId: string): boolean {
  const chat = useChatStore.getState();
  if (chat.chats[chatId]?.preview) return true;
  if ((chat.timelines[chatId] ?? []).some((e) => e.kind === 'message' && e.role === 'user')) {
    return true;
  }
  return useComposerDraftStore.getState().get(chatId) !== '';
}

function inUse(chatId: string): boolean {
  const voice = useVoiceStore.getState();
  return voice.note?.chatId === chatId || voice.call?.chatId === chatId;
}

/** Delete every still-empty chat created by the new-chat screen, except `onScreen`. */
export function discardUnsentNewChats(onScreen: string | null): void {
  const { hydrated, chats } = useChatStore.getState();
  for (const chatId of [...unsent]) {
    // Before the roster has loaded an empty-looking chat may just be unloaded,
    // and a chat missing from a loaded roster is already gone.
    if (hydrated && chats[chatId] === undefined) {
      unsent.delete(chatId);
      continue;
    }
    if (hasContent(chatId)) {
      unsent.delete(chatId);
      continue;
    }
    if (chatId === onScreen || inUse(chatId)) continue;
    if (!hydrated) continue;
    unsent.delete(chatId);
    useChatStore.getState().removeChat(chatId);
    clearComposerDraft(chatId);
    // NO FALLBACK: a refused delete leaves a real empty chat behind, which the
    // user must hear about rather than find later.
    void api.deleteChat(chatId).catch((e: unknown) => {
      useUiStore
        .getState()
        .pushError(`could not remove the empty new chat: ${(e as Error).message}`);
    });
  }
}

/** Mounted once per window: checks on every route change. */
export function useDiscardUnsentNewChats(): void {
  const { pathname } = useLocation();
  const hydrated = useChatStore((s) => s.hydrated);
  useEffect(() => {
    const onScreen = /^\/chats\/([^/]+)$/.exec(pathname)?.[1] ?? null;
    discardUnsentNewChats(onScreen);
  }, [pathname, hydrated]);
}

/** Test seam — forget every watched chat. */
export function _resetUnsentNewChats(): void {
  unsent.clear();
  localStorage.removeItem(STORAGE_KEY);
}
