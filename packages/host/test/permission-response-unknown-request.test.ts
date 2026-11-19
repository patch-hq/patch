// A surface answers a question card by resolving it on screen at once (greyed,
// "answered") and then waiting for the host's `chat.permission_response`
// echo, redelivering until it sees one. If the host no longer holds the
// request — it restarted, or the request was settled some other way — the old
// code only logged a warning and sent nothing, so the card sat greyed forever
// and the surface resent the answer every few seconds for good.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

function setup(lines: Array<Record<string, unknown>> = []) {
  const home = mkdtempSync(join(tmpdir(), 'patch-unknown-resp-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-unknown-resp-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: pino(
      { level: 'info' },
      { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) },
    ),
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    permissionModeDefault: 'default',
  });
  return { daemon, events, folder };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type Echo = { requestId: string; approve: boolean; decision?: string; chatId?: string };
const echoes = (events: WireEvent[]): Echo[] =>
  events.filter((e) => e.type === 'chat.permission_response') as unknown as Echo[];

describe('a permission response for a request the host no longer holds', () => {
  it('is answered with a deny echo for the chat, so the surface stops waiting', () => {
    const { daemon, events } = setup();
    daemon.submitPermissionResponse({
      requestId: 'gone',
      chatId: 'chat-9',
      decision: 'approve_with_edits',
      editedNewString: '{"Which?":"A"}',
    });
    expect(echoes(events)).toEqual([
      {
        type: 'chat.permission_response',
        chatId: 'chat-9',
        requestId: 'gone',
        approve: false,
        decision: 'deny',
      },
    ]);
  });

  it('with no chatId to address it, still logs and sends nothing', () => {
    const { daemon, events } = setup();
    daemon.submitPermissionResponse({ requestId: 'gone', decision: 'approve' });
    expect(echoes(events)).toHaveLength(0);
  });

  it('re-sends the ORIGINAL outcome for a redelivered answer, never flipping it to deny', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = events.find((e) => e.type === 'chat.permission_request') as unknown as {
      requestId: string;
    };
    const answer = {
      requestId: req.requestId,
      chatId,
      decision: 'approve_with_edits' as const,
      editedNewString: JSON.stringify({ 'Which?': 'A' }),
    };
    daemon.submitPermissionResponse(answer);
    await tick();
    daemon.submitPermissionResponse(answer); // the surface's retry timer
    const all = echoes(events);
    expect(all).toHaveLength(2);
    expect(all[1]?.approve).toBe(true);
    expect(all[1]?.decision).toBe('approve_with_edits');
    expect(all[1]?.chatId).toBe(chatId);
  });

  it('logs each answer in arrival order, so an approve landing after a sweep is traceable', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const { daemon, events, folder } = setup(lines);
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = events.find((e) => e.type === 'chat.permission_request') as unknown as {
      requestId: string;
    };
    daemon.submitPermissionResponse({
      requestId: req.requestId,
      chatId,
      decision: 'deny',
      by: 'cancelled',
    });
    daemon.submitPermissionResponse({ requestId: req.requestId, chatId, decision: 'approve' });
    const answers = lines.filter((l) => l['msg'] === 'permission answer received');
    expect(answers.map((l) => [l['decision'], l['by'], l['held']])).toEqual([
      ['deny', 'cancelled', true],
      ['approve', 'user', false],
    ]);
    expect(answers[1]?.['settledAs']).toBe('deny');
  });
});
