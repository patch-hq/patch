import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';

// A turn is told by its own facts (spec/12 § Chat status), never by a chat.state.
const started = (chatId: string, turnId: string): WireEvent => ({
  type: 'chat.turn_started',
  chatId,
  turnId,
  seq: -1,
  at: 1,
});
const ended = (
  chatId: string,
  turnId: string,
  outcome: 'completed' | 'stopped' | 'failed' | 'interrupted' = 'completed',
): WireEvent => ({ type: 'chat.turn_ended', chatId, turnId, seq: -1, at: 2, outcome });
/** A chat.state the host emits mid-turn (a summary, a status): it settles nothing. */
const frame = (chatId: string) =>
  ({ type: 'chat.state', chatId, permissionMode: 'auto', lastUpdated: 1 }) as unknown as WireEvent;
const msg = (chatId: string, role: 'user' | 'assistant', content: string, localId?: string) =>
  ({
    type: 'chat.message',
    chatId,
    role,
    content,
    seq: 1,
    ...(localId !== undefined ? { localId } : {}),
  }) as unknown as WireEvent;

describe('voice reply bridge — a turn identified by its localId', () => {
  it('is not settled or filled by another turn that is running when it is registered', async () => {
    const bridge = createVoiceReplyBridge();
    // A turn is already running on the chat; ours is queued behind it.
    bridge.observe(started('c', 'other'));
    const reply = bridge.awaitReply('c', undefined, 'mine');
    bridge.observe(msg('c', 'assistant', "the other turn's text"));
    bridge.observe(ended('c', 'other'));
    expect(bridge.pendingCount()).toBe(1);
    // Our turn starts: its own user message arms the waiter.
    bridge.observe(started('c', 'ours'));
    bridge.observe(msg('c', 'user', 'ls the folder', 'mine'));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(ended('c', 'ours'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('leaves out what the voice itself wrote into the chat while the agent worked', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c', undefined, 'mine');
    bridge.observe(msg('c', 'user', 'ls', 'mine'));
    bridge.observe(msg('c', 'assistant', "[voice • web] It's started."));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(ended('c', 't'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('a turn registered without a localId is armed by the turn starting', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c');
    bridge.observe(frame('c'));
    bridge.observe(started('c', 't'));
    bridge.observe(msg('c', 'assistant', 'hello'));
    bridge.observe(ended('c', 't'));
    await expect(reply).resolves.toBe('hello');
  });

  it("keeps the turn's text when the host emits state after the reply (summaries, status)", async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c');
    bridge.observe(started('c', 't'));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(frame('c'));
    bridge.observe(ended('c', 't'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('keeps it for a turn identified by localId too', async () => {
    const bridge = createVoiceReplyBridge();
    const reply = bridge.awaitReply('c', undefined, 'mine');
    bridge.observe(started('c', 't'));
    bridge.observe(msg('c', 'user', 'ls', 'mine'));
    bridge.observe(msg('c', 'assistant', 'ten files'));
    bridge.observe(frame('c'));
    bridge.observe(ended('c', 't'));
    await expect(reply).resolves.toBe('ten files');
  });

  it('a turn that ends failed or interrupted is not an answer', async () => {
    const bridge = createVoiceReplyBridge();
    const failed = bridge.awaitReply('c');
    bridge.observe(started('c', 't'));
    bridge.observe(msg('c', 'assistant', 'half a thought'));
    bridge.observe(ended('c', 't', 'interrupted'));
    await expect(failed).rejects.toThrow('interrupted');
    expect(bridge.pendingCount()).toBe(0);
  });
});

describe('voice reply bridge — acceptance', () => {
  it('reports the turn as accepted only when its own message arrives, not when another turn runs', () => {
    const bridge = createVoiceReplyBridge();
    let accepted = 0;
    void bridge.awaitReply('c', undefined, 'mine', () => (accepted += 1)).catch(() => undefined);
    bridge.observe(started('c', 'other'));
    bridge.observe(msg('c', 'user', 'other', 'theirs'));
    expect(accepted).toBe(0);
    bridge.observe(msg('c', 'user', 'ls', 'mine'));
    expect(accepted).toBe(1);
  });
});

describe('voice reply bridge — acknowledging receipt', () => {
  it('reports the hand-off accepted when the host acks it, while it is still queued behind a running turn', () => {
    const bridge = createVoiceReplyBridge();
    let accepted = 0;
    bridge.observe({
      type: 'chat.state',
      chatId: 'c',
      activity: 'running',
    } as unknown as WireEvent);
    void bridge.awaitReply('c', undefined, 'mine', () => (accepted += 1)).catch(() => {});
    bridge.observe({
      type: 'chat.input_ack',
      chatId: 'c',
      localId: 'other',
    } as unknown as WireEvent);
    expect(accepted).toBe(0);
    bridge.observe({
      type: 'chat.input_ack',
      chatId: 'c',
      localId: 'mine',
    } as unknown as WireEvent);
    expect(accepted).toBe(1);
    // The turn starting later does not report it a second time.
    bridge.observe(msg('c', 'user', 'x', 'mine'));
    expect(accepted).toBe(1);
  });
});
