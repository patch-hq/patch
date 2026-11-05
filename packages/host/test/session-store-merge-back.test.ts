// A resume run killed before the SDK flushed its transcript mirror leaves the
// work only in a `claude-resume-*` temp dir. The next resume must see it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createClaudeSessionStore } from '../src/claudeSessionStore.js';

const row = (uuid: string, parentUuid: string | null, text: string) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r) + '\n').join('');

describe('claude session store merges leftover resume transcripts', () => {
  it('appends rows only a killed run wrote, once, before loading', async () => {
    const home = mkdtempSync(join(tmpdir(), 'merge-back-'));
    const nativeDir = join(home, 'native');
    const tmpRoot = join(home, 'tmp');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 's1.jsonl'), jsonl([row('a', null, 'one')]));
    const proj = join(tmpRoot, 'claude-resume-xyz', 'projects', 'p');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 's1.jsonl'),
      jsonl([row('a', null, 'one'), row('b', 'a', 'two'), row('c', 'b', 'three')]),
    );
    const store = createClaudeSessionStore({
      chatId: 'c',
      folder: home,
      nativeDir,
      claudeProjectsRoot: join(home, 'none'),
      logger: pino({ level: 'silent' }),
      resumeTmpRoot: tmpRoot,
    });
    const loaded = await store.load!({ projectKey: 'p', sessionId: 's1' });
    expect(loaded?.map((e) => e.uuid)).toEqual(['a', 'b', 'c']);
    await store.load!({ projectKey: 'p', sessionId: 's1' });
    const onDisk = readFileSync(join(nativeDir, 's1.jsonl'), 'utf8').trim().split('\n');
    expect(onDisk).toHaveLength(3);
  });

  it('does nothing when no temp dir exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'merge-back-'));
    const nativeDir = join(home, 'native');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 's1.jsonl'), jsonl([row('a', null, 'one')]));
    const store = createClaudeSessionStore({
      chatId: 'c',
      folder: home,
      nativeDir,
      claudeProjectsRoot: join(home, 'none'),
      logger: pino({ level: 'silent' }),
      resumeTmpRoot: join(home, 'missing'),
    });
    const loaded = await store.load!({ projectKey: 'p', sessionId: 's1' });
    expect(loaded).toHaveLength(1);
  });
});
