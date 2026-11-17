// Browser surface half of the `desktop` notify channel (spec/09 § `### desktop`).
// The Electron shell raises a native toast over its preload bridge; a plain
// browser tab has no bridge, so it raises a web Notification instead. The
// browser only allows that after the user grants permission from a click, so
// the grant lives in Settings → Notifications and a denied or ungranted state
// is reported there, not papered over here.

export type BrowserNotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export interface BrowserNotifyPayload {
  body: string;
  chatId: string;
  kind?: string;
}

/** Notification kinds whose `chatId` is a real chat a click can open. */
const CHAT_KINDS: ReadonlySet<string | undefined> = new Set([undefined, 'message', 'call', 'ask']);

export function browserNotificationState(): BrowserNotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestBrowserNotifications(): Promise<BrowserNotificationState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return await Notification.requestPermission();
}

/** Open the chat a notification is about, inside the running SPA (router basename `/app`). */
function openChat(chatId: string): void {
  window.history.pushState({}, '', `/app/chats/${encodeURIComponent(chatId)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Raise a web Notification. Throws when permission has not been granted so the
 * caller surfaces it — a notification that silently never appears is the bug
 * this exists to fix.
 */
export function showBrowserNotification(payload: BrowserNotifyPayload): void {
  const state = browserNotificationState();
  if (state !== 'granted') {
    throw new Error(`browser notifications are ${state}; allow them in Settings → Notifications`);
  }
  const n = new Notification('Patch', { body: payload.body, tag: payload.chatId });
  n.onclick = (): void => {
    window.focus();
    if (CHAT_KINDS.has(payload.kind) && payload.chatId) openChat(payload.chatId);
    n.close();
  };
}
