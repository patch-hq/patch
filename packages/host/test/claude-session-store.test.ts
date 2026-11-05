// A chat's own Claude conversation file (spec/04 § History): one file under the
// chat's own config dir, migrated once, reseeded, stripped and resumed in place.

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
import type { LoggedEvent } from '@patch/wire';
import {
  chatClaudeDir,
  chatTranscriptPath,
  createClaudeSessionStore,
  entriesSince,
  findTranscript,
  legacyMirrorDir,
  transcriptSize,
} from '../src/claudeSessionStore.js';
import { encodeFolder } from '../src/history.js';
import type { TrackEntry } from '../src/nativeReconstruct.js';

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

function msg(role: 'user' | 'assistant', content: string): LoggedEvent {
  return { type: 'chat.message', chatId: 'c1', role, content, seq: 0 };
}

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

function mk(extra: { reseed?: Parameters<typeof createClaudeSessionStore>[0]['reseed'] } = {}) {
  const chatDir = join(tmp(), 'chats', 'c1');
  const claudeProjectsRoot = tmp();
  const store = createClaudeSessionStore({
    chatId: 'c1',
    folder: '/w',
    chatDir,
    claudeProjectsRoot,
    logger: silent,
    ...extra,
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

  it('an append after a torn last line (crash mid-write) starts on its own line', async () => {
    const { store, own } = mk();
    mkdirSync(join(own('s1'), '..'), { recursive: true });
    writeFileSync(
      own('s1'),
      `${JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } })}\n{"type":"assis`,
    );
    await store.append(key('s1'), [
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'again' } },
    ]);
    const got = readFileSync(own('s1'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return (JSON.parse(l) as { uuid?: string }).uuid;
        } catch {
          return 'torn';
        }
      });
    expect(got).toEqual(['u1', 'torn', 'u3']);
  });

  it('append dedupes by uuid across calls and across store instances', async () => {
    const { store, own, chatDir, claudeProjectsRoot } = mk();
    await store.append(key('s1'), [{ type: 'user', uuid: 'u1' }]);
    await store.append(key('s1'), [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]);
    const again = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      chatDir,
      claudeProjectsRoot,
      logger: silent,
    });
    await again.append(key('s1'), [{ type: 'assistant', uuid: 'u2' }]);
    expect(lines(own('s1'))).toHaveLength(2);
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

  it('copies the old per-chat mirror in on the first prepare, then leaves it', async () => {
    const { chatDir, store, own } = mk();
    mkdirSync(legacyMirrorDir(chatDir), { recursive: true });
    const legacy = join(legacyMirrorDir(chatDir), 's1.jsonl');
    writeFileSync(legacy, jl(...entries));
    expect(existsSync(own('s1'))).toBe(false);
    await store.prepare('s1');
    expect(lines(own('s1')).map((e) => e['uuid'])).toEqual(['u1', 'a1']);
    // From here on the chat's own file is the live one: a later change to the
    // old mirror is never copied over it.
    writeFileSync(legacy, jl({ type: 'user', uuid: 'stale' }));
    await store.prepare('s1');
    expect(lines(own('s1')).map((e) => e['uuid'])).toEqual(['u1', 'a1']);
  });

  it('prefers the old mirror to Claude Code’s shared store, as the old resume did', async () => {
    const { chatDir, claudeProjectsRoot, store, own } = mk();
    mkdirSync(legacyMirrorDir(chatDir), { recursive: true });
    writeFileSync(join(legacyMirrorDir(chatDir), 's1.jsonl'), jl(...entries));
    mkdirSync(join(claudeProjectsRoot, encodeFolder('/w')), { recursive: true });
    writeFileSync(
      join(claudeProjectsRoot, encodeFolder('/w'), 's1.jsonl'),
      jl({ type: 'user', uuid: 'old' }),
    );
    await store.prepare('s1');
    expect(lines(own('s1'))).toHaveLength(2);
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
    mkdirSync(legacyMirrorDir(chatDir), { recursive: true });
    writeFileSync(join(legacyMirrorDir(chatDir), 's1.jsonl'), jl(...entries));
    expect(
      findTranscript({ chatDir, folder: '/w', sessionId: 's1', claudeProjectsRoot })?.source,
    ).toBe('legacy');
    expect(
      findTranscript({ chatDir, folder: '/w', sessionId: 'zz', claudeProjectsRoot }),
    ).toBeNull();
  });

  it('migrating makes the session’s file appear under the chat dir only — no temp resume dir', async () => {
    const { chatDir, store } = mk();
    mkdirSync(legacyMirrorDir(chatDir), { recursive: true });
    writeFileSync(join(legacyMirrorDir(chatDir), 's1.jsonl'), jl(...entries));
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'));
    await store.prepare('s1');
    await store.prepare('s1');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'))).toEqual(before);
  });
});

describe('reseed', () => {
  it('writes the chat’s own track into the file, which later appends chain onto', async () => {
    const events: TrackEntry[] = [
      { record: { seq: 0, at: 1 }, event: msg('user', 'plant a codeword') },
      { record: { seq: 1, at: 2 }, event: msg('assistant', 'the codeword is banana') },
    ];
    const { chatDir, claudeProjectsRoot, store, own } = mk({
      reseed: { sessionId: 'sess-new', events, model: 'claude-opus-5' },
    });
    await store.prepare('sess-new');
    const seeded = lines(own('sess-new'));
    expect(seeded).toHaveLength(2);
    expect(JSON.stringify(seeded)).toContain('banana');
    await store.append(key('sess-new'), [
      {
        type: 'assistant',
        uuid: 'live-1',
        parentUuid: seeded[1]!['uuid'] as string,
        message: REAL_REPLY,
      },
    ]);
    // A retried reseed rewrites the seed and keeps what came after it.
    await store.prepare('sess-new');
    expect(lines(own('sess-new'))).toHaveLength(3);
    const plain = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      chatDir,
      claudeProjectsRoot,
      logger: silent,
    });
    expect(JSON.stringify(await plain.load(key('sess-new')))).toContain('banana');
  });

  it('replace: true drops a seed that was too big instead of keeping it', async () => {
    const big: TrackEntry[] = [
      { record: { seq: 0, at: 1 }, event: msg('user', 'first') },
      { record: { seq: 1, at: 2 }, event: msg('assistant', 'second') },
    ];
    const small: TrackEntry[] = [{ record: { seq: 1, at: 2 }, event: msg('assistant', 'second') }];
    const a = mk({ reseed: { sessionId: 'n', events: big, model: null } });
    await a.store.prepare('n');
    const b = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      chatDir: a.chatDir,
      claudeProjectsRoot: a.claudeProjectsRoot,
      logger: silent,
      reseed: { sessionId: 'n', events: small, model: null, replace: true },
    });
    await b.prepare('n');
    expect(JSON.stringify(lines(a.own('n')))).not.toContain('first');
  });
});

describe('harness-written entries', () => {
  it('are taken out of the file on resume and kept aside', async () => {
    const { store, own } = mk();
    mkdirSync(join(own('s1'), '..'), { recursive: true });
    writeFileSync(
      own('s1'),
      jl(
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'do it' } },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: REAL_REPLY },
        { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'next' } },
        {
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'u2',
          message: {
            role: 'assistant',
            model: '<synthetic>',
            content: [{ type: 'text', text: 'No response requested.' }],
          },
        },
      ),
    );
    await store.prepare('s1');
    expect(JSON.stringify(lines(own('s1')))).not.toContain('No response requested.');
    expect(readFileSync(`${own('s1')}.stripped`, 'utf8')).toContain('No response requested.');
    // Running it again changes nothing.
    const once = readFileSync(own('s1'), 'utf8');
    await store.prepare('s1');
    expect(readFileSync(own('s1'), 'utf8')).toBe(once);
  });
});

describe('what Claude wrote after the host looked', () => {
  it('entriesSince returns only what was appended past a size', async () => {
    const { store, own } = mk();
    await store.append(key('s1'), [{ type: 'user', uuid: 'u1' }]);
    const size = transcriptSize(own('s1'));
    await store.append(key('s1'), [{ type: 'assistant', uuid: 'u2' }]);
    expect(entriesSince(own('s1'), size).map((e) => e.uuid)).toEqual(['u2']);
    expect(entriesSince(join(own('s1'), 'nope'), 0)).toEqual([]);
  });
});
