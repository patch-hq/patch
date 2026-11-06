// spec/17 § Commands — "`<id>` accepts the full ULID or a unique prefix".
//
// The host and server routes take exact ids only, so a prefix (or a name) is resolved
// here, against the same chat list `patch chats list` reads on this transport
// (archived included — `get`/`archive --archived false` on an archived chat
// must still find it). Anything that is not a partial ULID (a full id, or a
// special thread's `thread_manager`-style id) is passed through untouched.

import type { Transport } from '../transport/index.js';
import { pickPath } from './_common.js';

const ULID_LENGTH = 26;
const ULID_PREFIX = /^[0-9A-HJKMNP-TV-Z]+$/;
const SPECIAL_THREAD = /^thread_[a-z]+$/;

/**
 * Resolves against every host's chats: no caller ever names a host. Over the
 * host socket that is the account-wide `/internal/chats`, which needs the
 * calling chat's id (PATCH_CHAT_ID); over REST the listing is account-wide
 * already. `id` is a full id, a unique id prefix, or a chat's exact name.
 */
export async function resolveChatId(t: Transport, id: string): Promise<string> {
  if (SPECIAL_THREAD.test(id)) return id;
  if (id.length >= ULID_LENGTH && ULID_PREFIX.test(id.toUpperCase())) return id;
  const path = pickPath(t, '/internal/chats', '/api/chats');
  let qs = '?archived=include';
  if (t.kind === 'uds') {
    const caller = process.env['PATCH_CHAT_ID'];
    if (!caller) {
      throw new Error(
        'finding a chat over the host socket needs PATCH_CHAT_ID (run it inside a chat), or use --remote with a CLI credential',
      );
    }
    qs += `&callerChatId=${encodeURIComponent(caller)}`;
  }
  const { chats } = await t.get<{ chats: { chatId: string; name?: string }[] }>(`${path}${qs}`);
  const upper = id.toUpperCase();
  const byId = ULID_PREFIX.test(upper) ? chats.filter((c) => c.chatId.startsWith(upper)) : [];
  if (byId.length === 1) return byId[0]!.chatId;
  if (byId.length > 1) {
    throw new Error(
      `${id} is ambiguous: it starts ${byId.length} chats (${byId.map((c) => c.chatId).join(', ')})`,
    );
  }
  const lower = id.toLowerCase();
  const byName = chats.filter((c) => c.name?.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!.chatId;
  if (byName.length > 1) {
    throw new Error(
      `${id} is ambiguous: ${byName.length} chats have that name (${byName.map((c) => c.chatId).join(', ')})`,
    );
  }
  throw new Error(`no chat on this account has an id starting ${id} or is named ${id}`);
}
