// A chat's own Claude conversation file (spec/04 § History): one file under the
// chat's own config dir, migrated once and resumed in place. Patch never edits
// it: no reseed, no stripping, nothing written into it.

import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  chatClaudeDir,
  chatTranscriptPath,
  createClaudeSessionStore,
  entriesSince,
  findTranscript,
  transcriptSize,
} from '../src/claudeSessionStore.js';
import { encodeFolder } from '../src/history.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'patch-claude-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A reply the model wrote — the store hands it back untouched. */
const REAL_REPLY = {
  role: 'assistant',
  model: 'claude-opus-5-5',
  usage: { input_tokens: 3, output_tokens: 2 },
  content: [{ type: 'text', text: 'hello' }],
};

const jl = (...es: object[]): string => es.map((e) => JSON.stringify(e)).join('\n') + '\n';
const lines = (p: string): Array<Record<string, unknown>> =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function mk() {
  const chatDir = join(tmp(), 'chats', 'c1');
  const claudeProjectsRoot = tmp();
  const store = createClaudeSessionStore({
    chatId: 'c1',
    folder: '/w',
    chatDir,
    claudeProjectsRoot,
    logger: silent,
  });
  return {
    chatDir,
    claudeProjectsRoot,
    store,
    own: (s: string) => chatTranscriptPath(chatDir, '/w', s),
  };
}
const key = (sessionId: string) => ({ projectKey: 'p', sessionId });

describe('the chat’s own conversation file', () => {
  it('lives under the chat’s own Claude config dir', () => {
    const { chatDir, own } = mk();
    expect(own('s1')).toBe(join(chatDir, 'claude', 'projects', encodeFolder('/w'), 's1.jsonl'));
    expect(chatClaudeDir(chatDir)).toBe(join(chatDir, 'claude'));
  });

  it('load returns null for a session that exists nowhere', async () => {
    const { store } = mk();
    expect(await store.load(key('never-seen'))).toBeNull();
  });
});

describe('migration of an existing chat, once', () => {
  const entries = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: REAL_REPLY },
  ];

  it('never reads the retired native/claude copy; the shared store is the only source', async () => {
    const { chatDir, claudeProjectsRoot, store, own } = mk();
    mkdirSync(join(chatDir, 'native', 'claude'), { recursive: true });
    writeFileSync(join(chatDir, 'native', 'claude', 's1.jsonl'), jl(...entries));
    expect(
      findTranscript({ chatDir, folder: '/w', sessionId: 's1', claudeProjectsRoot }),
    ).toBeNull();
    await store.prepare('s1');
    expect(existsSync(own('s1'))).toBe(false);
    expect(await store.load(key('s1'))).toBeNull();
  });

  it('copies a session that only lives in the shared store, with its sub-agent files', async () => {
    const { claudeProjectsRoot, store, own } = mk();
    const proj = join(claudeProjectsRoot, encodeFolder('/w'));
    mkdirSync(join(proj, 's1', 'subagents'), { recursive: true });
    writeFileSync(join(proj, 's1.jsonl'), jl(...entries));
    writeFileSync(
      join(proj, 's1', 'subagents', 'agent-1.jsonl'),
      jl({ type: 'user', uuid: 'sub' }),
    );
    await store.prepare('s1');
    expect(lines(own('s1'))).toHaveLength(2);
    expect(existsSync(join(own('s1'), '..', 's1', 'subagents', 'agent-1.jsonl'))).toBe(true);
  });

  it('is findable before it is migrated (a resume check must not lose it)', () => {
    const { chatDir, claudeProjectsRoot } = mk();
    mkdirSync(join(claudeProjectsRoot, encodeFolder('/w')), { recursive: true });
    writeFileSync(join(claudeProjectsRoot, encodeFolder('/w'), 's1.jsonl'), jl(...entries));
    expect(
      findTranscript({ chatDir, folder: '/w', sessionId: 's1', claudeProjectsRoot })?.source,
    ).toBe('shared');
    expect(
      findTranscript({ chatDir, folder: '/w', sessionId: 'zz', claudeProjectsRoot }),
    ).toBeNull();
  });

  it('migrating makes the session’s file appear under the chat dir only — no temp resume dir', async () => {
    const { claudeProjectsRoot, store } = mk();
    mkdirSync(join(claudeProjectsRoot, encodeFolder('/w')), { recursive: true });
    writeFileSync(join(claudeProjectsRoot, encodeFolder('/w'), 's1.jsonl'), jl(...entries));
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'));
    await store.prepare('s1');
    await store.prepare('s1');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'))).toEqual(before);
  });
});

describe('Patch never edits the file', () => {
  it('prepare and load leave harness-written entries exactly as Claude Code wrote them', async () => {
    const { store, own } = mk();
    mkdirSync(join(own('s1'), '..'), { recursive: true });
    const written = jl(
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'do it' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: REAL_REPLY },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      },
    );
    writeFileSync(own('s1'), written);
    await store.prepare('s1');
    expect(readFileSync(own('s1'), 'utf8')).toBe(written);
    expect(existsSync(`${own('s1')}.stripped`)).toBe(false);
    const loaded = await store.load(key('s1'));
    expect(loaded?.map((e) => e.uuid)).toEqual(['u1', 'a1', 'a2']);
  });
});

describe('what Claude wrote after the host looked', () => {
  it('entriesSince returns only what was appended past a size', async () => {
    const { own } = mk();
    mkdirSync(join(own('s1'), '..'), { recursive: true });
    writeFileSync(own('s1'), jl({ type: 'user', uuid: 'u1' }));
    const size = transcriptSize(own('s1'));
    writeFileSync(own('s1'), jl({ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }));
    expect(entriesSince(own('s1'), size).map((e) => e.uuid)).toEqual(['u2']);
    expect(entriesSince(join(own('s1'), 'nope'), 0)).toEqual([]);
  });
});
