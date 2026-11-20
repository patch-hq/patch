// spec/02 § Context compression — the compaction boundary, end to end through
// the host: the SDK stream message, the wire event, and the replay of a
// persisted boundary.
//
// The two representations here are NOT interchangeable and are both taken from
// the real thing rather than guessed:
//   - the SDK STREAM message is snake_case (`compact_metadata`, `pre_tokens`),
//     matching the zod schema the `claude` binary validates it against.
//   - the on-disk JSONL Claude Code writes is camelCase (`compactMetadata`,
//     `preTokens`) and carries a `content` string.
// Sample on-disk line, copied from a real transcript:
//   {"type":"system","subtype":"compact_boundary","content":"Conversation
//    compacted","compactMetadata":{"trigger":"auto","preTokens":168165},...}
// Real boundaries carry no post-count and no duration, so the "pre-count only"
// case below is the COMMON one, not an edge case.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { translateSdkMessage } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-compact-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore };
}

describe('translateSdkMessage — compaction boundary', () => {
  it('carries the figures and a one-line record when the SDK reports both counts', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 168165,
        post_tokens: 42118,
        duration_ms: 3200,
      },
      uuid: 'u1',
      session_id: 's1',
    });
    expect(env).toMatchObject({
      type: 'system',
      content: 'Context compressed · 168k → 42k',
      compaction: {
        trigger: 'auto',
        preTokens: 168165,
        postTokens: 42118,
        durationMs: 3200,
      },
    });
  });

  it('reports what it was given when the SDK sends only the pre-count', () => {
    // The shape every real boundary observed on disk actually has.
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 168165 },
      uuid: 'u1',
      session_id: 's1',
    });
    expect(env).toMatchObject({
      type: 'system',
      content: 'Context compressed · from 168k',
      compaction: { trigger: 'auto', preTokens: 168165 },
    });
    // Absent, not zero — a surface must be able to tell "not reported" from "0".
    expect(env?.compaction).not.toHaveProperty('postTokens');
    expect(env?.compaction).not.toHaveProperty('durationMs');
  });

  it('keeps a manual compaction distinguishable from an automatic one', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 90000 },
    });
    expect(env?.compaction).toMatchObject({ trigger: 'manual', preTokens: 90000 });
  });

  it('renders a sub-1k count as the exact number rather than 0k', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 940, post_tokens: 120 },
    });
    expect(env?.content).toBe('Context compressed · 940 → 120');
  });

  it('rolls a count that rounds to 1000k over to M', () => {
    const [env] = translateSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 999_600, post_tokens: 999_499 },
    });
    expect(env?.content).toBe('Context compressed · 1M → 999k');
  });

  it.each([
    ['no compact_metadata at all', { type: 'system', subtype: 'compact_boundary' }],
    [
      'a metadata block that is not an object',
      { type: 'system', subtype: 'compact_boundary', compact_metadata: 'nope' },
    ],
    [
      'a missing pre-count',
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } },
    ],
    [
      'a non-numeric pre-count',
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 'lots' },
      },
    ],
    [
      'an unrecognised trigger',
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'sideways', pre_tokens: 10 },
      },
    ],
  ])('throws on a boundary with %s rather than inventing figures', (_label, msg) => {
    expect(() => translateSdkMessage(msg)).toThrow(/compact_boundary/);
  });

  it('leaves every other system message alone', () => {
    expect(translateSdkMessage({ type: 'system', subtype: 'init', tools: [] })[0]).toMatchObject({
      type: 'system',
    });
    expect(translateSdkMessage({ type: 'system', subtype: 'init' })[0]).not.toHaveProperty(
      'compaction',
    );
  });
});

describe('Host — compaction boundary on the wire', () => {
  it('emits the boundary as a system chat.message carrying the figures', async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'before' },
      {
        type: 'system',
        content: 'Context compressed · from 168k',
        compaction: { trigger: 'auto', preTokens: 168165 },
      },
      { type: 'assistant', content: 'after', sessionId: 'sess-C' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ role: string; content: string; seq: number; compaction?: unknown }>;
    // seq 0 user turn, 1 'before', 2 the boundary, 3 'after'.
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({
      role: 'system',
      content: 'Context compressed · from 168k',
      seq: 2,
      compaction: { trigger: 'auto', preTokens: 168165 },
    });
    // It takes a real seq like any other transcript entry, so it replays in place.
    expect(messages[3]?.seq).toBe(3);
    expect(metaStore.read(chatId)?.nextSeq).toBe(4);
    // And it is part of the chat's own state, not just a live fan-out.
    const snapshots = daemon.chatState.get(chatId)?.lastMessages ?? [];
    expect(snapshots.some((m) => m.role === 'system' && m.content.includes('168k'))).toBe(true);
  });

  it('resets the context reading to the post-compaction count', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([
      {
        type: 'system',
        content: 'Context compressed · 969k → 19k',
        compaction: { trigger: 'auto', preTokens: 969000, postTokens: 19000 },
      },
      { type: 'assistant', content: 'after', sessionId: 'sess-D' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    expect(daemon.chatState.get(chatId)?.context?.usedTokens).toBe(19000);
  });

  it('drops a stale context reading when the boundary reports no post-count', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([
      {
        type: 'system',
        content: 'Context compressed · 969k → 19k',
        compaction: { trigger: 'auto', preTokens: 969000, postTokens: 19000 },
      },
      { type: 'assistant', content: 'one', sessionId: 'sess-E' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    sdk.enqueue([
      {
        type: 'system',
        content: 'Context compressed · from 981k',
        compaction: { trigger: 'auto', preTokens: 981000 },
      },
    ]);
    await daemon.sendInput({ chatId, message: 'again' });
    await new Promise((r) => setTimeout(r, 30));
    expect(daemon.chatState.get(chatId)?.context?.usedTokens).toBeUndefined();
  });

  it('still drops a content-less system envelope', async () => {
    // Every other system envelope (init, stream_event leftovers) carries no
    // chat-visible content and must stay invisible.
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'system' }, { type: 'assistant', content: 'hi' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
