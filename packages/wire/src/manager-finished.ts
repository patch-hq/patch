// Finished chats → the Manager: what is waiting and when the last delivery
// went (spec/06 § Finished chats), as the server reports it on
// `GET /api/manager/finished` and every surface shows it.

export interface ManagerFinishedStatus {
  waiting: number;
  /** Chats in the delivery the home host has not confirmed yet. */
  sending: number;
  lastSent: { at: number; chats: number } | null;
  /** Why waiting chats are not being sent, while that is so. */
  held?: string;
}

/** `2 waiting · last sent 14:30`, `Nothing waiting · last sent 3 Nov 09:12`. */
export function finishedStatusLine(s: ManagerFinishedStatus, now: number = Date.now()): string {
  const parts = [s.waiting === 0 ? 'Nothing waiting' : `${s.waiting} waiting`];
  if (s.sending > 0) parts.push(`${s.sending} sending`);
  if (s.lastSent) {
    const d = new Date(s.lastSent.at);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const sameDay = d.toDateString() === new Date(now).toDateString();
    const day = sameDay ? '' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} `;
    parts.push(`last sent ${day}${time}`);
  }
  if (s.held) parts.push(s.held);
  return parts.join(' · ');
}
