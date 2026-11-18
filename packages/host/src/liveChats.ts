// The host's list of chats with live or owed work (spec/02 § Chat loading).
//
// Start-up loads these and no others, so it reads only what it needs to resume
// work instead of every chat the host has ever held. The list is a plain file
// beside the chats; every other chat is opened when a frame names it.
//
// The list may name a chat that has since gone quiet (it is trimmed on a
// timer and at shutdown) but must never miss one that has work: a chat is added
// the moment it gains work, synchronously, and only ever removed after
// the host has looked at it and found none.
//
// No fallback: a list that is missing means a host from before the list
// existed, and the host builds it once from a full scan (logged). A list that
// exists but cannot be read is an error, not a reason to scan quietly.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { backRecord } from '@patch/wire';
import type { ChatMeta } from './meta.js';

/** What a chat's own meta says about owed work. Wakes and watches live in their own files. */
export function metaHasLiveWork(m: ChatMeta): boolean {
  if ((m.pendingTurns?.length ?? 0) > 0) return true;
  if (m.status === 'deleted') return false;
  // A turn cut off by a restart leaves the chat interrupted until its user continues it.
  if (m.interrupted === true) return true;
  if (m.snoozedUntil !== undefined && m.snoozedUntil !== null) return true;
  // A snooze that came back stays one set until its first interaction clears
  // it (spec/04 § Snooze → Back): every member must be loaded to clear together.
  if (backRecord(m.snoozeRecords) !== null) return true;
  if (m.subagent !== undefined && m.subagent.outcome === undefined) return true;
  // A turn parked on exhausted credit re-sends when the account resets.
  if (m.lastError?.outOfCredit === true) return true;
  return false;
}

export class LiveChats {
  private ids = new Set<string>();
  /** Set once the list is known to be complete: loaded from disk, or built from a scan. */
  private established = false;
  private readonly path: string;

  constructor(
    path: string,
    private readonly logger: Logger,
  ) {
    this.path = path;
  }

  /** Read the persisted list. `undefined` when there is none yet. Throws if it is unreadable. */
  load(): string[] | undefined {
    if (!existsSync(this.path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { chats?: unknown }).chats) ||
      !(parsed as { chats: unknown[] }).chats.every((c) => typeof c === 'string')
    ) {
      throw new Error(`live-chats list is malformed: ${this.path}`);
    }
    const chats = (parsed as { chats: string[] }).chats;
    this.ids = new Set(chats);
    this.established = true;
    return [...chats];
  }

  /** Replace the whole list (after a full scan). */
  reset(ids: Iterable<string>): void {
    this.ids = new Set(ids);
    this.established = true;
    this.write();
  }

  has(chatId: string): boolean {
    return this.ids.has(chatId);
  }

  list(): string[] {
    return [...this.ids];
  }

  /** The chat gained work. Written before returning, so a crash a moment later still finds it. */
  add(chatId: string): void {
    if (this.ids.has(chatId)) return;
    this.ids.add(chatId);
    this.write();
  }

  /** The chat was looked at and has no work. */
  remove(chatId: string): void {
    if (!this.ids.delete(chatId)) return;
    this.write();
  }

  private write(): void {
    // Until the list is complete, a file holding only what happened since would
    // read as the whole list at the next start.
    if (!this.established) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ chats: [...this.ids].sort() }), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.logger.debug({ count: this.ids.size }, 'live-chats list written');
  }
}
