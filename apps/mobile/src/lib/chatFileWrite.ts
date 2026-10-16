// Writing a chat-folder file from the phone (spec/14 § File browser). The
// server has no HTTP write for a chat's files: a surface sends `file.write`
// over its socket and the host answers nothing. So a save is two steps with no
// ack between them, and `confirmWritten` is the second: read the file back
// until it holds what was sent, or say it never did. NO FALLBACK: an
// unconfirmed save is reported, never assumed.

import { getWs } from '../api/ws';

/** Send the new content of `path` (relative to the chat folder) to its host. */
export function writeChatFile(chatId: string, path: string, content: string): void {
  getWs().send({ type: 'file.write', chatId, path, content });
}

export const CONFIRM_ATTEMPTS = 8;
export const CONFIRM_DELAY_MS = 250;

/** True once `read()` returns `expected`; false if it never does within the attempts. */
export async function confirmWritten(
  read: () => Promise<string>,
  expected: string,
  attempts: number = CONFIRM_ATTEMPTS,
  delayMs: number = CONFIRM_DELAY_MS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if ((await read()) === expected) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
