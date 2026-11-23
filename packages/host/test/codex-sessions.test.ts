import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { CodexSessions } from '../src/codexSessions.js';

describe('CodexSessions pending marker', () => {
  it.each(['', '{"id": "trunc', 'not json'])(
    'treats an unreadable marker (%j) as no pending turn, logs it and recovers',
    (garbage) => {
      const root = mkdtempSync(join(tmpdir(), 'patch-codex-sessions-'));
      try {
        const error = vi.fn();
        const sessions = new CodexSessions(root, { error } as any);
        const sid = 'codex-abc';
        writeFileSync(join(root, `${sid}.jsonl.pending`), garbage);
        expect(sessions.pending(sid)).toBeNull();
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][0]).toMatchObject({ sessionId: sid });
        sessions.setPending(sid, { id: 'x', prompt: 'p' });
        expect(sessions.pending(sid)).toEqual({ id: 'x', prompt: 'p' });
        expect(readdirSync(root).filter((f) => f.endsWith('.new'))).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
