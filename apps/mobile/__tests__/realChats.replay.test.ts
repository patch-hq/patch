// Replays real chat logs (host `~/.patch/chats/<id>/events.jsonl`) through the
// store the chat screen reads. Skipped unless PATCH_REAL_CHATS names the chats
// directory — it exists to find the event shapes that throw on a real phone.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useChatStore } from '../src/stores/chatStore';

const dir = process.env['PATCH_REAL_CHATS'];

describe.skipIf(!dir || !existsSync(dir))('real chat replay', () => {
  it('applies every logged event without throwing', () => {
    const failures = new Map<string, { count: number; chatId: string; type: string }>();
    let chats = 0;
    for (const id of readdirSync(dir as string)) {
      const file = join(dir as string, id, 'events.jsonl');
      if (!existsSync(file)) continue;
      useChatStore.getState()._reset();
      chats++;
      const events: unknown[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const rec = JSON.parse(line)?.rec;
        if (rec?.k === 'event') events.push(rec.event);
      }
      for (const ev of events) {
        try {
          useChatStore.getState().applyEvents([ev as never]);
        } catch (err) {
          const key = `${(err as Error).message}`.slice(0, 200);
          const f = failures.get(key) ?? {
            count: 0,
            chatId: id,
            type: String((ev as { type?: unknown }).type),
          };
          f.count++;
          failures.set(key, f);
        }
      }
    }
    console.log(`replayed ${chats} chats; failures:`, JSON.stringify([...failures], null, 1));
    expect([...failures.keys()]).toEqual([]);
  }, 600_000);
});

import React from 'react';
import { vi } from 'vitest';
import { renderRN, actSync, queryHost, byTestId, textOf } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    reportCrash: vi.fn(),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

describe.skipIf(!dir || !existsSync(dir))('real chat render', () => {
  it('renders every logged chat on the chat screen without the error boundary firing', async () => {
    const { default: ChatDetailScreen } = await import('../app/chats/[chatId]');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHost('online');
    const failures = new Map<string, { count: number; chatId: string }>();
    let n = 0;
    for (const id of readdirSync(dir as string)) {
      const file = join(dir as string, id, 'events.jsonl');
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const events = lines
        .map((l) => JSON.parse(l)?.rec)
        .filter((r) => r?.k === 'event')
        .map((r) => r.event);
      if (events.length === 0 || (events.length > 1500 && !process.env['PATCH_REAL_CHATS_BIG']))
        continue;
      useChatStore.getState()._reset();
      useChatStore.getState().hydrate([
        {
          chatId: id,
          name: 'x',
          folder: '~/p',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 1,
        },
      ]);
      useChatStore.getState().applyEvents(events);
      __setLocalSearchParams({ chatId: id });
      n++;
      const r = renderRN(React.createElement(ChatDetailScreen));
      const err = queryHost(r.root, byTestId('chat-error-message'));
      if (err) {
        const key = textOf(err).slice(0, 200);
        const f = failures.get(key) ?? { count: 0, chatId: id };
        f.count++;
        failures.set(key, f);
      }
      actSync(() => r.unmount());
    }
    console.log(`rendered ${n} chats; failures:`, JSON.stringify([...failures], null, 1));
    expect([...failures.keys()]).toEqual([]);
  }, 1_800_000);
});
