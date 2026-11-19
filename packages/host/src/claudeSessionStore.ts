// A chat's Claude conversation file (spec/04 § History).
//
// Each chat has ONE stable Claude config dir, `~/.patch/chats/<chatId>/claude`,
// which Claude Code reads and writes directly on every turn and every resume
// (`CLAUDE_CONFIG_DIR`). Its transcript is
// `<claudeDir>/projects/<encoded folder>/<sessionId>.jsonl` — the only live
// copy, with no throwaway `claude-resume-*` materialisation in between.
//
// This module is the host's side of that file, used BEFORE a turn spawns: a
// session that still lives in the old per-chat mirror
// (`native/claude/<sessionId>.jsonl`) or Claude Code's shared
// `~/.claude/projects` is copied, unchanged, into the chat's dir once.
//
// Patch never edits the file (spec/04 § History): it does not rebuild,
// reseed, strip or annotate a session. What Claude Code wrote is what Claude
// Code resumes.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { encodeFolder } from './history.js';

/** `~/.patch/chats/<chatId>/claude` — the chat's own `CLAUDE_CONFIG_DIR`. */
export function chatClaudeDir(chatDir: string): string {
  return join(chatDir, 'claude');
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
 * Claude Code's shared projects dir (a chat not migrated yet — the next resume
 * copies it in). `null` when none exists.
 */
export function findTranscript(opts: {
  chatDir: string;
  folder: string;
  sessionId: string;
  claudeProjectsRoot: string;
}): { path: string; source: 'chat' | 'shared' } | null {
  const own = chatTranscriptPath(opts.chatDir, opts.folder, opts.sessionId);
  if (nonEmpty(own)) return { path: own, source: 'chat' };
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
}

export interface SessionKey {
  projectKey?: string;
  sessionId: string;
}

export interface ClaudeSessionStore {
  /** The conversation `key` resumes from, as Claude Code wrote it, or null if none. */
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
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

  return {
    async load(key) {
      const found = findTranscript({
        chatDir: opts.chatDir,
        folder: opts.folder,
        sessionId: key.sessionId,
        claudeProjectsRoot: opts.claudeProjectsRoot,
      });
      if (found === null) return null;
      const entries = parseJsonl(readFileSync(found.path, 'utf8'));
      if (entries.length === 0) return null;
      return entries;
    },

    async prepare(sessionId) {
      mkdirSync(join(chatClaudeDir(opts.chatDir), 'projects'), { recursive: true });
      migrate(sessionId);
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
