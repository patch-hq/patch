// New Pad on the phone (spec/14 § Pads — Starting a Pad, way (c)): the pure
// parts of the screen. The phone cannot DOM-capture a live Patch screen, so a
// Patch pad here starts only from screens an earlier Pad already captured
// (the library), exactly like any other app.

import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { Href } from 'expo-router';
import type { PadCreateBody, PadLibrary } from '../api/rest';
import type { ChatRow } from '../stores/types';
import { deriveChatTitle } from './labels';

export const PATCH_APP = 'Patch';

/** Patch first, then every app the library holds. */
export function padApps(library: PadLibrary | null): string[] {
  return [...new Set([PATCH_APP, ...(library?.apps.map((a) => a.app) ?? [])])];
}

const SEP = '\u0000';
export function libraryKey(padId: string, screenId: string): string {
  return `${padId}${SEP}${screenId}`;
}

export function canCreate(s: { name: string; chatId: string; busy: boolean }): boolean {
  return s.name.trim() !== '' && s.chatId !== '' && !s.busy;
}

export function buildCreateBody(s: {
  name: string;
  /** '' is Blank. */
  app: string;
  device: 'desktop' | 'phone';
  chatId: string;
  selected: readonly string[];
}): PadCreateBody {
  const from = s.selected.map((k) => {
    const [padId, screenId] = k.split(SEP) as [string, string];
    return { padId, screenId };
  });
  return {
    name: s.name.trim(),
    ...(s.app !== '' ? { app: s.app } : {}),
    device: s.device,
    chatId: s.chatId,
    ...(from.length ? { from } : {}),
  };
}

/** Chats a Pad can belong to: not archived, not a special thread, newest first. */
export function padChatOptions(chats: Record<string, ChatRow>): { id: string; label: string }[] {
  const special = Object.values(SPECIAL_THREAD_IDS) as string[];
  return Object.values(chats)
    .filter((c) => c.status !== 'archived' && !special.includes(c.chatId))
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
    .map((c) => ({ id: c.chatId, label: deriveChatTitle(c) }));
}

/** The New Pad screen, optionally with a chat and app preselected. */
export function newPadHref(params?: { chatId: string; app: string }): Href {
  return (params ? { pathname: '/pads/new', params } : '/pads/new') as Href;
}
