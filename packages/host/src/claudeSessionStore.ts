// A chat's Claude conversation file (spec/04 § History).
//
// Each chat has ONE stable Claude config dir, `~/.patch/chats/<chatId>/claude`,
// which Claude Code reads and writes directly on every turn and every resume
// (`CLAUDE_CONFIG_DIR`). Its transcript is
// `<claudeDir>/projects/<encoded folder>/<sessionId>.jsonl` — the only live
// copy, with no throwaway `claude-resume-*` materialisation in between.
//
// This module is the host's side of that file, used BEFORE a turn spawns:
//   - migrate: a session that still lives in the old per-chat mirror
//     (`native/claude/<sessionId>.jsonl`) or Claude Code's shared
//     `~/.claude/projects` is copied into the chat's dir once;
//   - reseed: a provider switch or explicit reconstruction writes the chat's
//     own log as a synthesized session;
//   - strip: the entries the harness wrote itself (`syntheticTurns.ts`) are
//     taken out of the file, so the model only resumes the conversation. What
//     is removed is kept in `<sessionId>.jsonl.stripped`.

import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { encodeFolder } from './history.js';
import {
  toClaudeSessionEntries,
  type ClaudeSessionEntry,
  type TrackEntry,
} from './nativeReconstruct.js';
import { markRestoredImages, stripSyntheticTurns } from './syntheticTurns.js';
import { newlineIfTorn } from './jsonlAppend.js';

/** `~/.patch/chats/<chatId>/claude` — the chat's own `CLAUDE_CONFIG_DIR`. */
export function chatClaudeDir(chatDir: string): string {
  return join(chatDir, 'claude');
}

/** The pre-migration per-chat mirror: `~/.patch/chats/<chatId>/native/claude`. */
export function legacyMirrorDir(chatDir: string): string {
  return join(chatDir, 'native', 'claude');
}

/** Where Claude Code keeps `sessionId`'s transcript inside the chat's own dir. */
export function chatTranscriptPath(chatDir: string, folder: string, sessionId: string): string {
  return join(chatClaudeDir(chatDir), 'projects', encodeFolder(folder), `${sessionId}.jsonl`);
}

function nonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/**
 * The transcript `sessionId` resumes from: the chat's own file; failing that
 * the old mirror or Claude Code's shared projects dir (a chat not migrated
 * yet — the next resume copies it in). `null` when none exists.
 */
export function findTranscript(opts: {
  chatDir: string;
  folder: string;
  sessionId: string;
  claudeProjectsRoot: string;
}): { path: string; source: 'chat' | 'legacy' | 'shared' } | null {
  const own = chatTranscriptPath(opts.chatDir, opts.folder, opts.sessionId);
  if (nonEmpty(own)) return { path: own, source: 'chat' };
  const legacy = join(legacyMirrorDir(opts.chatDir), `${opts.sessionId}.jsonl`);
  if (nonEmpty(legacy)) return { path: legacy, source: 'legacy' };
  const shared = join(
    opts.claudeProjectsRoot,
    encodeFolder(opts.folder),
    `${opts.sessionId}.jsonl`,
  );
  if (existsSync(shared)) return { path: shared, source: 'shared' };
  return null;
}

export interface ClaudeSessionStoreOptions {
  chatId: string;
  folder: string;
  /** `~/.patch/chats/<chatId>`. */
  chatDir: string;
  claudeProjectsRoot: string;
  logger: Logger;
  /** Set only when this query is a provider switch or an explicit reseed. */
  reseed?: {
    sessionId: string;
    events: readonly TrackEntry[];
    model: string | null;
    /** Replace the file outright (a retried handoff: nothing after the seed yet). */
    replace?: boolean;
  };
}

export interface SessionKey {
  projectKey?: string;
  sessionId: string;
}

export interface ClaudeSessionStore {
  /** The conversation `key` resumes from (stripped of harness entries), or null if none. */
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  /** Append entries (deduped by uuid) to the chat's own transcript for `key`. */
  append(key: SessionKey, entries: readonly SessionStoreEntry[]): Promise<void>;
  /** Make the chat's own transcript ready for Claude to resume `sessionId` in place. */
  prepare(sessionId: string): Promise<void>;
}

export function parseJsonl(text: string): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as SessionStoreEntry);
    } catch {
      // A damaged line is skipped rather than failing the whole resume over it.
    }
  }
  return out;
}

function writeAtomic(path: string, entries: readonly SessionStoreEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  renameSync(tmp, path);
}

export function createClaudeSessionStore(opts: ClaudeSessionStoreOptions): ClaudeSessionStore {
  const own = (sessionId: string): string =>
    chatTranscriptPath(opts.chatDir, opts.folder, sessionId);

  /** Copy a not-yet-migrated session into the chat's own dir. Once. */
  function migrate(sessionId: string): void {
    const target = own(sessionId);
    if (nonEmpty(target)) return;
    const found = findTranscript({
      chatDir: opts.chatDir,
      folder: opts.folder,
      sessionId,
      claudeProjectsRoot: opts.claudeProjectsRoot,
    });
    if (found === null || found.source === 'chat') return;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    copyFileSync(found.path, tmp);
    renameSync(tmp, target);
    // Sub-agent transcripts and tool results live in `<sessionId>/` beside it.
    const sibling = join(dirname(found.path), sessionId);
    if (found.source === 'shared' && existsSync(sibling)) {
      cpSync(sibling, join(dirname(target), sessionId), { recursive: true });
    }
    opts.logger.info(
      { chatId: opts.chatId, sessionId, from: found.source, path: found.path },
      'claude session: migrated into the chat’s own config dir',
    );
  }

  // The reseeded history must live in the file: Claude's live entries chain
  // onto its tail. Reseed uuids are content-derived, so a retried reseed
  // rewrites the same entries; anything already after them is kept.
  function reseed(r: NonNullable<ClaudeSessionStoreOptions['reseed']>): void {
    const seeded = toClaudeSessionEntries(r.events, {
      sessionId: r.sessionId,
      folder: opts.folder,
      model: r.model,
    }) as ClaudeSessionEntry[] as SessionStoreEntry[];
    const path = own(r.sessionId);
    const seededUuids = new Set<string>();
    for (const e of seeded) if (e.uuid) seededUuids.add(e.uuid);
    const existing = existsSync(path) && !r.replace ? parseJsonl(readFileSync(path, 'utf8')) : [];
    const kept = existing.filter((e) => !e.uuid || !seededUuids.has(e.uuid));
    writeAtomic(path, [...seeded, ...kept]);
    opts.logger.info(
      { chatId: opts.chatId, sessionId: r.sessionId, entries: seeded.length },
      "claude session: reseeded from the chat's own log",
    );
  }

  function stripInPlace(sessionId: string): void {
    const path = own(sessionId);
    if (!existsSync(path)) return;
    const entries = parseJsonl(readFileSync(path, 'utf8'));
    const result = stripSyntheticTurns(entries);
    const cleaned = markRestoredImages(result.entries);
    if (JSON.stringify(cleaned) === JSON.stringify(entries)) return;
    const kept = new Set<string>();
    for (const e of cleaned) if (e.uuid) kept.add(e.uuid);
    const removed = entries.filter((e) => e.uuid && !kept.has(e.uuid));
    if (removed.length > 0) {
      appendFileSync(`${path}.stripped`, removed.map((e) => JSON.stringify(e) + '\n').join(''));
    }
    writeAtomic(path, cleaned);
    if (result.synthetic > 0 || result.unansweredPrompts > 0 || result.danglingToolCalls > 0) {
      opts.logger.info(
        {
          chatId: opts.chatId,
          sessionId,
          synthetic: result.synthetic,
          injectedPrompts: result.injectedPrompts,
          unansweredPrompts: result.unansweredPrompts,
          danglingToolCalls: result.danglingToolCalls,
        },
        'claude session: kept harness-written turns out of the resumed context',
      );
    }
  }

  return {
    async append(key, entries) {
      migrate(key.sessionId);
      const path = own(key.sessionId);
      mkdirSync(dirname(path), { recursive: true });
      const seen = new Set<string>();
      if (existsSync(path)) {
        for (const e of parseJsonl(readFileSync(path, 'utf8'))) if (e.uuid) seen.add(e.uuid);
      }
      // Entries without a uuid (titles, tags, mode markers) are appended unconditionally.
      const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
      if (fresh.length === 0) return;
      appendFileSync(
        path,
        newlineIfTorn(path) + fresh.map((e) => JSON.stringify(e) + '\n').join(''),
      );
    },

    async load(key) {
      if (opts.reseed && key.sessionId === opts.reseed.sessionId) {
        return toClaudeSessionEntries(opts.reseed.events, {
          sessionId: opts.reseed.sessionId,
          folder: opts.folder,
          model: opts.reseed.model,
        }) as ClaudeSessionEntry[] as SessionStoreEntry[];
      }
      const found = findTranscript({
        chatDir: opts.chatDir,
        folder: opts.folder,
        sessionId: key.sessionId,
        claudeProjectsRoot: opts.claudeProjectsRoot,
      });
      if (found === null) return null;
      const entries = parseJsonl(readFileSync(found.path, 'utf8'));
      if (entries.length === 0) return null;
      return markRestoredImages(stripSyntheticTurns(entries).entries);
    },

    async prepare(sessionId) {
      mkdirSync(join(chatClaudeDir(opts.chatDir), 'projects'), { recursive: true });
      if (opts.reseed && sessionId === opts.reseed.sessionId) reseed(opts.reseed);
      else migrate(sessionId);
      stripInPlace(sessionId);
    },
  };
}

/**
 * Entries Claude wrote to `sessionId`'s transcript after `fromSize` bytes — the
 * way the host sees what never crossed the SDK stream (the `No response
 * requested.` Claude inserts on resuming an unanswered turn).
 */
export function entriesSince(path: string, fromSize: number): SessionStoreEntry[] {
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  return parseJsonl(buf.subarray(Math.min(fromSize, buf.length)).toString('utf8'));
}

export function transcriptSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}
