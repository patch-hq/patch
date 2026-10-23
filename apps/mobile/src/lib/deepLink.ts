// Pure resolver for `patch://` deep links — Android launcher long-press
// shortcuts (spec/15 ## Mobile equivalent of the menu bar) plus the chat
// scheme links. Kept standalone + pure so it is unit-testable without a
// React Native renderer; the root layout feeds it the incoming URL and acts
// on the returned action.
//
//   patch://voice-note?chat=<id>   → open the global voice-note overlay
//   patch://new-chat               → navigate to the new-chat sheet
//   patch://chats/<id>             → navigate to a chat detail
//   patch://home                   → the tab navigator's root (Chats tab), where the tab bar is painted
//   patch://settings/<page>        → navigate to a settings page (the emulator smoke reads the running version from updates)
//
// A `?credential=` link is handled separately (bootstrap.maybeAcceptDevCredential)
// and resolves to null here.

import * as Linking from 'expo-linking';

export type DeepLinkAction =
  | { kind: 'voice-note'; chatId: string }
  | { kind: 'navigate'; route: string }
  | null;

export function resolveDeepLink(url: string | null | undefined): DeepLinkAction {
  if (!url) return null;
  const parsed = Linking.parse(url);
  // expo-router/Linking strips the scheme; `hostname` carries the first path
  // segment for `patch://<segment>/...`, and `path` carries the rest.
  const host = parsed.hostname ?? '';
  const path = (parsed.path ?? '').replace(/^\/+/, '');
  const head = host || path.split('/')[0] || '';

  if (head === 'voice-note') {
    const chat = parsed.queryParams?.['chat'];
    const chatId = typeof chat === 'string' && chat.length > 0 ? chat : 'thread_manager';
    return { kind: 'voice-note', chatId };
  }
  if (head === 'new-chat') {
    return { kind: 'navigate', route: '/new-chat' };
  }
  if (head === 'chats') {
    // `patch://chats/<id>` — host='chats', path='<id>'  OR  path='chats/<id>'.
    const rest = host === 'chats' ? path : path.split('/').slice(1).join('/');
    // `''.split('/')` still yields `['']` — `[0]` is never actually
    // undefined; the `?? fallback` only satisfies TypeScript's
    // noUncheckedIndexedAccess, never a real path.
    /* v8 ignore next */
    const chatId = rest.split('/')[0] ?? '';
    if (chatId.length > 0) return { kind: 'navigate', route: `/chats/${chatId}` };
  }
  if (head === 'home') {
    return { kind: 'navigate', route: '/(tabs)/chats' };
  }
  if (head === 'settings') {
    const rest = host === 'settings' ? path : path.split('/').slice(1).join('/');
    const page = rest.split('/')[0] ?? '';
    if (page.length > 0) return { kind: 'navigate', route: `/settings/${page}` };
  }
  return null;
}

const CHAT_LINK = /^(?:patch:\/\/|\/)chats\/([^/?#\s]+)$/;

/** The in-app route for a markdown link to another chat (`/chats/<id>` or `patch://chats/<id>`), else null. */
export function chatLinkRoute(href: string): string | null {
  const m = CHAT_LINK.exec(href);
  if (!m || m[1] === 'new') return null;
  return `/chats/${m[1]}`;
}
