import { getWs } from '../api/ws';

/**
 * Tell the host the user is working on an open question. Best-effort: it runs
 * from a throttle timer, where a "not connected" throw is uncaught and crashes
 * the app, and a dropped ping is harmless (the next activity sends another).
 */
export function sendQuestionActivity(chatId: string): void {
  getWs().safeSend({ type: 'chat.question_activity', chatId });
}
