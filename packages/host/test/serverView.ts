// What the server makes of a host's frames (spec/12 § Chat status). A host no
// longer says whether a chat is running: it reports facts (a turn started or
// ended, a question raised or answered, turns it holds queued), and the server
// derives the status and stamps its old-style `activity` on each `chat.state`.
// Tests that check what a turn looks like downstream read the frames through
// this, the same reading the server's `legacyActivity` gives.

import type { ChatActivity, WireEvent } from '@patch/wire';

interface Chat {
  turns: Set<string>;
  asks: Map<string, boolean>;
  failed: boolean;
}

/**
 * Each `chat.state` in `events`, with the activity the server would put on it.
 * `from` keeps only the frames at or after that index, read with everything
 * before it as context.
 */
export function asServerSees(events: readonly WireEvent[], from = 0): WireEvent[] {
  const chats = new Map<string, Chat>();
  const of = (chatId: string): Chat => {
    let c = chats.get(chatId);
    if (!c) chats.set(chatId, (c = { turns: new Set(), asks: new Map(), failed: false }));
    return c;
  };
  const out: WireEvent[] = [];
  for (const [index, e] of events.entries()) {
    if (e.type === 'chat.turn_started') {
      const c = of(e.chatId);
      c.turns.add(e.turnId);
      c.failed = false;
    } else if (e.type === 'chat.turn_ended') {
      const c = of(e.chatId);
      c.turns.delete(e.turnId);
      c.failed = e.outcome === 'failed';
    } else if (e.type === 'chat.permission_request') {
      of(e.chatId).asks.set(e.requestId, e.request.tool === 'AskUserQuestion');
    } else if (e.type === 'chat.permission_response' && e.chatId !== undefined) {
      of(e.chatId).asks.delete(e.requestId);
    } else if (e.type === 'patch.browser_handoff.state' && e.shared !== true) {
      const c = of(e.chatId);
      if (e.status === 'waiting') c.asks.set(`handoff:${e.handoffId}`, false);
      else c.asks.delete(`handoff:${e.handoffId}`);
    } else if (e.type === 'chat.state') {
      const c = of(e.chatId);
      let activity: ChatActivity;
      if (c.turns.size > 0) activity = c.asks.size > 0 ? 'awaiting-permission' : 'running';
      else if ([...c.asks.values()].some((question) => !question)) activity = 'awaiting-permission';
      else if ((e.queuedTurns ?? 0) > 0) activity = 'running';
      else if (c.failed) activity = 'errored';
      else activity = 'idle';
      if (index >= from) out.push({ ...e, activity });
    }
  }
  return out;
}

/** The activities the server shows for one chat, a repeat of the last counted once. */
export function serverActivities(events: readonly WireEvent[], chatId: string): ChatActivity[] {
  return asServerSees(events)
    .filter((e) => e.type === 'chat.state' && e.chatId === chatId)
    .map((e) => (e as { activity: ChatActivity }).activity)
    .filter((a, i, all) => i === 0 || all[i - 1] !== a);
}
