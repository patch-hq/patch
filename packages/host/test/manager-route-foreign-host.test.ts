// A host that does not run the Manager may still carry a stale local
// `thread_manager` (from before the Manager moved). patch_send_to / peek /
// history addressed to it must go to the host that runs the Manager, never
// to that stale copy (spec/06 § Where special threads run).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const KEY = 'local-secret';
const auth = { authorization: `Bearer ${KEY}` };

async function setup(runsManager: boolean) {
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-mgr-'))),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'x',
    emit: () => {},
    logger: pino({ level: 'silent' }),
    now: () => 1_700_000_000_000,
  });
  // The stale local copy: present and answering.
  const localState = { chatId: 'thread_manager', lastMessages: [], activity: 'idle' };
  vi.spyOn(daemon.chatState, 'get').mockReturnValue(localState as never);
  vi.spyOn(daemon.chatState, 'resolve').mockReturnValue(localState as never);
  const submitInput = vi.spyOn(daemon, 'submitInput').mockResolvedValue(undefined as never);
  const readHistory = vi.spyOn(daemon, 'readHistory').mockReturnValue({ events: [] } as never);
  const sendToRemoteChat = vi.fn(async () => {});
  const peekRemoteChat = vi.fn(async () => ({ chat_state: {}, events: [], truncated: false }));
  const historyRemoteChat = vi.fn(async () => ({ events: [] }));
  const app = await buildControl({
    localKey: KEY,
    daemon,
    jobs: new MemoryJobsStore({ now: () => 1_700_000_000_000 }),
    runsManager: () => runsManager,
    sendToRemoteChat,
    peekRemoteChat: peekRemoteChat as never,
    historyRemoteChat: historyRemoteChat as never,
  });
  return { app, submitInput, readHistory, sendToRemoteChat, peekRemoteChat, historyRemoteChat };
}

describe('thread_manager addressed from a host that does not run the Manager', () => {
  it('send_to relays and never touches the local copy', async () => {
    const s = await setup(false);
    const res = await s.app.inject({
      method: 'POST',
      url: '/internal/send-to',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { chatId: 'thread_manager', message: 'hi', callerChatId: 'c1' },
    });
    expect(res.statusCode).toBe(200);
    expect(s.sendToRemoteChat).toHaveBeenCalledTimes(1);
    expect(s.submitInput).not.toHaveBeenCalled();
    await s.app.close();
  });

  it('peek relays', async () => {
    const s = await setup(false);
    const res = await s.app.inject({
      method: 'GET',
      url: '/internal/peek/thread_manager?callerChatId=c1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(s.peekRemoteChat).toHaveBeenCalledTimes(1);
    await s.app.close();
  });

  it('history relays and never reads the local copy', async () => {
    const s = await setup(false);
    const res = await s.app.inject({
      method: 'GET',
      url: '/internal/history/thread_manager?callerChatId=c1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(s.historyRemoteChat).toHaveBeenCalledTimes(1);
    expect(s.readHistory).not.toHaveBeenCalled();
    await s.app.close();
  });

  it('on the Manager host everything stays local', async () => {
    const s = await setup(true);
    const res = await s.app.inject({
      method: 'POST',
      url: '/internal/send-to',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { chatId: 'thread_manager', message: 'hi', callerChatId: 'c1' },
    });
    expect(res.statusCode).toBe(200);
    expect(s.submitInput).toHaveBeenCalledTimes(1);
    expect(s.sendToRemoteChat).not.toHaveBeenCalled();
    await s.app.close();
  });
});
