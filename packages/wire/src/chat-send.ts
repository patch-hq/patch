// Agent-to-agent messages between chats (`patch_send_to`, spec/03 § Cross-chat
// tools). The sending host tags the delivered turn with where it came from, so
// the recipient's agent knows who to answer and every surface can draw the
// turn as a "From <chat>" card rather than an anonymous machine turn. This is
// the one format for that tag: written by the host, read by every surface —
// the same arrangement as `agent-return.ts`.

export interface ChatSend {
  /** The sending chat's id — what the card's link opens. */
  chatId: string;
  /** The sending chat's name when it was sent; null when it had none. */
  title: string | null;
  message: string;
}

const CHAT_SEND = /^\[from (?:([^\n]*?); )?chat ([^\s\]]+)\] ([\s\S]*)$/;

export function formatChatSend(
  fromChatId: string,
  fromTitle: string | null,
  message: string,
): string {
  // One line, no bracket: the tag must stay parseable whatever the chat is called.
  const title = (fromTitle ?? '').replace(/[\s\]]+/g, ' ').trim();
  return title === ''
    ? `[from chat ${fromChatId}] ${message}`
    : `[from ${title}; chat ${fromChatId}] ${message}`;
}

/** `null` when the text is not a tagged send — an ordinary message stays one. */
export function parseChatSend(content: string): ChatSend | null {
  const m = CHAT_SEND.exec(content);
  if (!m) return null;
  return { chatId: m[2] ?? '', title: m[1] ?? null, message: (m[3] ?? '').trim() };
}

/** Is this tool id `patch_send_to`, bare or as its MCP id? */
export function isSendToTool(tool: string | undefined): boolean {
  return tool === 'patch_send_to' || tool === 'mcp__patch__patch_send_to';
}

/**
 * The target and message of a `patch_send_to` call, for the "Sent to" card.
 * Null when the call is not one or its args are not its shape — the call then
 * renders as an ordinary tool row.
 */
export function sendToCall(
  tool: string | undefined,
  args: unknown,
): { chatId: string; message: string } | null {
  if (!isSendToTool(tool)) return null;
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const chatId = a['chatId'];
  const message = a['message'];
  if (typeof chatId !== 'string' || chatId === '') return null;
  if (typeof message !== 'string' || message === '') return null;
  return { chatId, message };
}
