// The reply to one delivered message, read from the server's record of the
// chat (spec/03 § Cross-chat tools, `patch.reply.request`). The server holds
// every chat's record whichever host runs it, so a caller on any host waits
// here for a chat on any other.
//
// A message delivered with `localId` becomes the chat's user message carrying
// that id, written as the turn that takes it starts (or into a running turn
// that steers it in). Its reply is what the chat's agent said after it, up to
// the end of the turn that took it: the first turn boundary at or past the
// message's seq, since a turn's end sits at the chat's highest seq when it
// ended. A failed turn, or a `chat.error` that names the message, is a failure,
// never an empty answer.

import type { ChatLogStore } from './chat-log-store.js';

export type RecordedReply =
  | { state: 'waiting' }
  | { state: 'answered'; text: string }
  | { state: 'failed'; message: string };

export function replyFromRecord(
  store: Pick<ChatLogStore, 'read' | 'turns'>,
  chatId: string,
  localId: string,
): RecordedReply {
  const events = store.read(chatId, -1);
  const asked = events.find(
    (e) => e.type === 'chat.message' && e.role === 'user' && e.localId === localId,
  );
  if (!asked || asked.type !== 'chat.message') return { state: 'waiting' };
  const at = asked.seq;
  const error = events.find(
    (e) => e.type === 'chat.error' && (e.causeSeq !== undefined ? e.causeSeq === at : e.seq > at),
  );
  if (error?.type === 'chat.error') return { state: 'failed', message: error.error.message };
  const ended = store.turns(chatId).find((t) => t.ended !== undefined && t.ended.seq >= at)?.ended;
  if (!ended) return { state: 'waiting' };
  if (ended.outcome === 'failed' || ended.outcome === 'interrupted') {
    return { state: 'failed', message: ended.error?.message ?? `the turn ended ${ended.outcome}` };
  }
  const said = events.flatMap((e) =>
    e.type === 'chat.message' &&
    e.role === 'assistant' &&
    e.seq > at &&
    e.seq <= ended.seq &&
    typeof e.content === 'string' &&
    // What a voice call said into the chat while the agent worked is not the agent's answer.
    !e.content.startsWith('[voice')
      ? [e.content]
      : [],
  );
  return { state: 'answered', text: said.join('\n') };
}
