// The chat open in the FRONT window, published to a well-known local file so
// other tools (Foreman) can name the chat on a Patch stint. The window title is
// only the folder, and the renderer is the only thing that knows the chat.
//
// File: ~/.patch/front-chat.json
//   { chatId: string|null, name: string|null, folder: string|null, changedAt: ms }
// Written atomically (temp file + rename) so a reader never sees a torn file.
// A write failure throws to the caller — no silent fallback.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FrontChat {
  chatId: string | null;
  name: string | null;
  folder: string | null;
  changedAt: number;
}

export function frontChatPath(home: string): string {
  return join(home, '.patch', 'front-chat.json');
}

/** Validate a renderer payload; null when it is not a well-formed report. */
export function parseOpenChat(raw: unknown, now: number): FrontChat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const field = (v: unknown): string | null | undefined =>
    v === null || typeof v === 'string' ? v : undefined;
  const chatId = field(r.chatId);
  const name = field(r.name);
  const folder = field(r.folder);
  if (chatId === undefined || name === undefined || folder === undefined) return null;
  return { chatId, name, folder, changedAt: now };
}

export function writeFrontChat(home: string, chat: FrontChat): void {
  const file = frontChatPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(chat));
  renameSync(tmp, file);
}
