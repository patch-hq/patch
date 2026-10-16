// spec/09 § Whose turn it was, spec/06 § patch_activity — a turn the host
// started itself rather than a person (a self-wake firing, a Manager-sweep
// nudge/wake, a `patch_delegate` relay, the todo list advancing) rides
// `SendInputOptions.origin: 'machine'` the same way a job's fire rides
// `jobTrigger`. This suite drives `sendInput` the way those callers do and
// reads the persisted `chat.message` back off the wire, the same shape a
// surface renders from and `userMessages.ts` reads for `patch_activity`.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Env = { type: string; [k: string]: unknown };

function recordingBackend(): { backend: SdkBackend; prompts: string[] } {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<Env> {
      prompts.push(opts.prompt);
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts };
}

function setup(backend: SdkBackend) {
  const home = mkdtempSync(join(tmpdir(), 'patch-machineorigin-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-machineoriginfolder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
  });
  return { daemon, folder, events };
}

/** The persisted user-role `chat.message` frames for this chat, in order. */
function userMessages(events: WireEvent[], chatId: string): ChatMessageEvent[] {
  return events.filter(
    (e): e is ChatMessageEvent =>
      e.type === 'chat.message' && e.chatId === chatId && e.role === 'user',
  );
}

describe('machine-origin turn (spec/09 § Whose turn it was)', () => {
  it('an ordinary composer turn carries no origin', async () => {
    const { backend } = recordingBackend();
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'plan the veg beds', localId: 'u1' });
    await tick();

    expect(userMessages(events, chatId).map((m) => m.origin)).toEqual([undefined]);
  });

  it("the host's own turn (self-wake, sweep nudge/wake, delegate relay, todo advance) carries origin: 'machine'", async () => {
    const { backend } = recordingBackend();
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    // Turn 1: Tom's own message — the chat is not fresh.
    await daemon.sendInput({ chatId, message: 'watch this for me', localId: 'u1' });
    await tick();
    // Turn 2: the host firing into the SAME chat on its own behalf — exactly
    // what deliverWake/deliverSweepMessage/deliverToParent/the todo
    // auto-advance all do via this same option.
    await daemon.sendInput({
      chatId,
      message: 'Checking in — still working?',
      localId: 'm1',
      origin: 'machine',
    });
    await tick();

    const msgs = userMessages(events, chatId);
    expect(msgs.map((m) => m.content)).toEqual([
      'watch this for me',
      'Checking in — still working?',
    ]);
    expect(msgs[0]?.origin).toBeUndefined();
    expect(msgs[1]?.origin).toBe('machine');
  });

  it('a machine-origin turn that queues behind a running turn still carries it once it runs', async () => {
    const gates: Array<() => void> = [];
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<Env> {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: 'result', sessionId: 'sess' };
        yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
      },
    };
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    const first = daemon.sendInput({ chatId, message: 'from Tom', localId: 'u1' });
    await tick();
    const second = daemon.sendInput({
      chatId,
      message: 'Carry on.',
      localId: 'm1',
      origin: 'machine',
    });
    await tick();
    gates.shift()?.();
    await tick();
    gates.shift()?.();
    await Promise.all([first, second]);
    await tick();

    const msgs = userMessages(events, chatId);
    expect(msgs.map((m) => m.content)).toEqual(['from Tom', 'Carry on.']);
    expect(msgs[0]?.origin).toBeUndefined();
    expect(msgs[1]?.origin).toBe('machine');
  });

  it("a job's fire (jobTrigger) is NOT also a machine-origin turn — it counts as the user's own turn (spec/09)", async () => {
    const { backend } = recordingBackend();
    const { daemon, folder, events } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({
      chatId,
      message: '{"route":"36","etaMinutes":4}',
      localId: 'j1',
      jobTrigger: true,
    });
    await tick();

    const msgs = userMessages(events, chatId);
    expect(msgs[0]?.jobTrigger).toBe(true);
    expect(msgs[0]?.origin).toBeUndefined();
  });
});
