// Surfaces display the status the server sends and never derive it
// (spec/05 § Chat status, spec/12 § Chat status). This scans every surface's
// source (web, mobile, CLI) and fails when one starts working a chat's status
// out again: reading the retired `activity` field, holding an optimistic or
// tool-call status of its own, or treating a declared question, a pending
// permission or the lifecycle `errored` flag as a status.
//
// A chat's status is `chatStatus` on its row, read as `chatStatus.state` (or
// through a surface's `statusOf` / `isRunning` helpers). Anything else that
// decides "working", "waiting" or "failed" belongs on the server.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const SURFACE_DIRS = [
  'packages/web/src',
  'apps/mobile/src',
  'apps/mobile/app',
  'packages/cli/src',
  'packages/desktop/src',
];

/** What a surface must not do, and why. */
const RULES: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\.activity\b/,
    why: 'reads the retired `activity`; read `chatStatus.state`',
  },
  {
    pattern: /\bactivity\s*:\s*['"]|\bactivity\s*:\s*(?:c|r|row|event|prior|existing)\.activity/,
    why: 'stores an `activity` on a row; store the server `chatStatus`',
  },
  { pattern: /\boptimisticSend\b/, why: 'shows an assumed status before the server sends one' },
  { pattern: /\bopenToolCalls\b/, why: 'counts tool calls as the chat status' },
  {
    pattern: /\b(?:clearsLimitPause|IN_FLIGHT_CHAT_ACTIVITIES|ChatActivity)\b/,
    why: 'works a status out from activity',
  },
  {
    pattern: /statusKind\s*===\s*'question'\s*&&\s*\w+\.statusDeclared/,
    why: 'treats a declared question as a status; the server sends `waiting_for_user`',
  },
  {
    pattern: /\bstatus\s*===\s*'errored'/,
    why: 'treats the lifecycle `errored` flag as a status; the server sends `failed`',
  },
];

/** Lines that use the words for something other than a chat's status. */
const ALLOWED: RegExp[] = [/question_activity/, /patch\.activity/, /\bactivity:\s*ActivityPage\b/];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The code on a line, without a trailing `//` comment; a comment line is skipped. */
function codeOf(line: string): string | null {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return null;
  const i = line.indexOf(' // ');
  return i >= 0 ? line.slice(0, i) : line;
}

function findStatusDerivations(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = codeOf(line);
      if (code === null || ALLOWED.some((a) => a.test(code))) return;
      for (const rule of RULES) {
        if (rule.pattern.test(code)) {
          hits.push(`${relative(ROOT, file)}:${i + 1} ${rule.why}: ${code.trim()}`);
        }
      }
    });
  }
  return hits;
}

describe('surfaces display the server status and never derive it', () => {
  const files = SURFACE_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));

  it('scans every surface', () => {
    for (const d of ['packages/web/src', 'apps/mobile/src', 'packages/cli/src']) {
      expect(files.some((f) => f.startsWith(join(ROOT, d)))).toBe(true);
    }
  });

  it('no surface works a chat status out for itself', () => {
    expect(findStatusDerivations(files)).toEqual([]);
  });

  it('catches each kind of derivation it guards against', () => {
    const dir = join(ROOT, 'packages/wire/test/fixtures');
    const hits = findStatusDerivations([join(dir, 'status-derivation.fixture.txt')]);
    expect(hits.length).toBe(RULES.length);
  });
});
