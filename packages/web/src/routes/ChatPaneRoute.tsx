// ChatPaneRoute — bridges the URL to the pane/tab layout (spec/14 § Panes and
// tabs). Mounted at `/chats/:chatId`, same as the old direct `ChatRoute`
// mount it replaces.
//
// A navigation to `/chats/:chatId` (a sidebar Link, browser back/forward, a
// deep link, a reload) shows that chat in a group (spec/14 § Groups): the group
// already showing it, else the focused group switches to it. `?seq=` rides along as a one-shot jump, then is
// stripped from the URL (mirrors the jump-to param's own clear-immediately
// rule, moved up from `ChatRoute`).
//
// This is one-directional: switching the focused tab by means OTHER than a
// URL navigation (clicking a different pane or tab, a middle-click open, a
// context-menu split) does not push the browser's address bar to match.
// `layoutStore`'s own `localStorage` persistence — not the URL — is what
// "the whole layout survives a reload" (spec/14 § Panes and tabs) actually
// rests on, and it does not need the address bar's cooperation. Reflecting
// the OTHER way was tried and dropped: it needs `navigate()` fired from a
// reaction to a layoutStore change, and that reaction races the render
// `<StrictMode>` always does (in dev AND in `main.tsx`'s production tree)
// to check for impure renders — the resulting history write is reliably
// lost often enough to be a real bug, not a flaky test. A sidebar click
// bypasses the same hazard from the other side (see `Sidebar.tsx`'s
// `handleRowClick`, which opens the tab directly rather than trusting
// react-router to re-run this route's effect whenever the URL merely
// LOOKS unchanged).
import { useEffect } from 'react';
import type { JSX } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PaneArea } from '../components/PaneArea.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import type { PatchWs } from '../api/ws.js';

export function ChatPaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const { chatId = '' } = useParams<{ chatId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const seqParam = searchParams.get('seq');
  const showChat = useLayoutStore((s) => s.showChat);

  useEffect(() => {
    // A group may ALREADY be showing this chat — most often the layout a reload
    // just restored (spec/14 § Groups — "the whole layout persists"): showing
    // it again would move focus off the group the user left focused. A genuine
    // navigation to a chat no group shows never hits this.
    const state = useLayoutStore.getState();
    const alreadyShowing = state.groups.some((g) => g.chatId === chatId);
    if (alreadyShowing && seqParam === null) return;

    const seq =
      seqParam !== null && Number.isInteger(Number(seqParam)) ? Number(seqParam) : undefined;
    showChat(chatId, seq !== undefined ? { seq } : {});
    if (seqParam !== null) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('seq');
          return next;
        },
        { replace: true },
      );
    }
  }, [chatId, seqParam, showChat, setSearchParams]);

  return <PaneArea ws={ws} />;
}
