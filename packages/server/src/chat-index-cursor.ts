// Opaque position cursor for `GET /api/chats` paging (spec/04 § Chat index
// paging). It carries the sort key of the last row a page returned plus the
// list it came from, so the next page is "every row after this key" in the
// same list — stable while rows move, appear or disappear in between.
import { z } from 'zod';
import type { ChatOrderKey } from './chat-registry.js';

const CursorSchema = z.object({
  v: z.literal(1),
  f: z.string(),
  p: z.boolean(),
  pa: z.number().nullable(),
  u: z.number(),
  id: z.string().min(1),
});

export interface ChatIndexCursor {
  /** The list's filter and order, so a cursor cannot be replayed against another list. */
  filter: string;
  key: ChatOrderKey;
}

export function encodeChatIndexCursor(c: ChatIndexCursor): string {
  const body = {
    v: 1,
    f: c.filter,
    p: c.key.pinned,
    pa: c.key.pinnedAt,
    u: c.key.lastUpdated,
    id: c.key.chatId,
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** `null` when the string is not a cursor this server issued. */
export function decodeChatIndexCursor(raw: string): ChatIndexCursor | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = CursorSchema.safeParse(json);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    filter: d.f,
    key: { pinned: d.p, pinnedAt: d.pa, lastUpdated: d.u, chatId: d.id },
  };
}
