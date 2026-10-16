// frontChat — tell the desktop shell which chat is open in this window, so it
// can publish the chat in the FRONT window to a well-known local file
// (desktop/src/front-chat.ts). A window's title is only its folder
// ("portfolio — patch"), so anything watching which window is in front cannot
// otherwise say which chat is being looked at.
//
// Reported on every change of the open chat (id, name, folder) and every time
// the window gains focus. A background window reports nothing on change: the
// file describes the front window, and a hidden window's rename must not
// overwrite it. Undefined bridge (a plain browser) is a no-op by design — the
// browser has no shell to report to.
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { deriveChatTitle } from './chatTitle.js';
import { getDesktopBridge } from './desktopBridge.js';

export interface FrontChatReport {
  chatId: string | null;
  name: string | null;
  folder: string | null;
}

export function useFrontChatReport(): void {
  const chatId = useChatStore((s) => s.activeChatId);
  const rawName = useChatStore((s) =>
    s.activeChatId === null ? null : (s.chats[s.activeChatId]?.name ?? null),
  );
  const folder = useChatStore((s) =>
    s.activeChatId === null ? null : (s.chats[s.activeChatId]?.folder ?? null),
  );
  const name = chatId === null ? null : deriveChatTitle(rawName);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.reportOpenChat) return;
    const report = (): void => bridge.reportOpenChat?.({ chatId, name, folder });
    if (document.hasFocus()) report();
    window.addEventListener('focus', report);
    return () => window.removeEventListener('focus', report);
  }, [chatId, name, folder]);
}
