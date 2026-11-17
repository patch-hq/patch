// Orange "an agent is working" state for the icons outside the chat list: the
// browser favicon and the desktop menu-bar (tray) icon. The chat list and chat
// header already show it through the working StatusBadge; this reuses the same
// definition (`deriveBadge === 'working'`) so the three never disagree.

import { useEffect } from 'react';
import { deriveBadge, useChatStore } from '../stores/chatStore.js';

const FAVICON_IDLE = '/app/favicon.svg';
const FAVICON_WORKING = '/app/favicon-working.svg';

interface TrayBridge {
  setAgentWorking?: (working: boolean) => void;
}

/** True while any non-archived chat's badge is `working`. */
export function useAnyAgentWorking(): boolean {
  return useChatStore((s) =>
    Object.values(s.chats).some((c) => c.status !== 'archived' && deriveBadge(c) === 'working'),
  );
}

export function setFavicon(working: boolean): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) throw new Error('favicon <link rel="icon"> missing from index.html');
  link.href = working ? FAVICON_WORKING : FAVICON_IDLE;
}

/** Mount once in the app shell: mirrors the working state onto favicon + tray. */
export function useAgentWorkingIndicator(): void {
  const working = useAnyAgentWorking();
  useEffect(() => {
    setFavicon(working);
    (window as unknown as { patch?: TrayBridge }).patch?.setAgentWorking?.(working);
  }, [working]);
}
