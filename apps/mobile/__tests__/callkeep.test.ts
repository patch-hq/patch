// lib/callkeep.ts — react-native-callkeep wrapper (spec/15 ## Manager
// incoming-call UX). Exercises setup + the answerCall/endCall native event
// handlers against the callkeep stub's event bus, and the
// show/end-active-call guards. No resetModules gymnastics: callkeep's
// `_initialised` guard means init is idempotent, so every test shares one
// module instance (matching how the real app calls initCallKeep() once).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import RNCallKeep, { __emitCallKeepEvent } from './stubs/callkeep';
import { initCallKeep, showIncomingCall, endActiveCall } from '../src/lib/callkeep';
import { getWs } from '../src/api/ws';
import { useUiStore } from '../src/stores/uiStore';
import { useVoiceStore, type IncomingCall } from '../src/stores/voiceStore';
import { startVoiceCall } from '../src/lib/voiceCall';

vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

let send: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  useUiStore.setState({ errors: [] });
  useVoiceStore.setState({ incomingCall: null, activeSession: null });
  vi.clearAllMocks();
  send = vi.fn();
  vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
  await initCallKeep();
  endActiveCall(); // every test rings afresh
});

/** Ring as the WS and push paths do. */
function ring(over: Partial<IncomingCall> = {}): void {
  showIncomingCall({
    callId: 'call1',
    chatId: 'chat1',
    message: undefined,
    receivedAt: Date.now(),
    ...over,
  });
}

describe('initCallKeep', () => {
  it('is idempotent — a second call does not re-run setup()', async () => {
    const setup = vi.spyOn(RNCallKeep, 'setup');
    await initCallKeep();
    await initCallKeep();
    expect(setup).not.toHaveBeenCalled(); // already initialised in beforeEach
  });
});

describe('showIncomingCall — not yet initialised', () => {
  it('throws (NO FALLBACK) if called before initCallKeep()', async () => {
    // A dedicated fresh module instance — the shared top-level `showIncomingCall`
    // import has already been initialised by every other test's beforeEach.
    vi.resetModules();
    const fresh = await import('../src/lib/callkeep');
    expect(() =>
      fresh.showIncomingCall({
        callId: 'call1',
        chatId: 'chat1',
        message: undefined,
        receivedAt: 0,
      }),
    ).toThrow(/not initialised/);
  });
});

describe('showIncomingCall / endActiveCall', () => {
  it('displays the incoming call and generates a fresh v4-ish uuid each time', () => {
    const display = vi.spyOn(RNCallKeep, 'displayIncomingCall');
    ring();
    expect(display).toHaveBeenCalledTimes(1);
    const [uuid, chatId, label, kind, hasVideo] = display.mock.calls[0]!;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chatId).toBe('chat1');
    expect(label).toBe('Patch');
    expect(kind).toBe('generic');
    expect(hasVideo).toBe(false);
  });

  it('endActiveCall ends the active call and is idempotent after', () => {
    const endCall = vi.spyOn(RNCallKeep, 'endCall');
    ring();
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    endActiveCall();
    expect(endCall).toHaveBeenCalledWith(uuid);
    endCall.mockClear();
    endActiveCall(); // nothing active — must not call endCall again
    expect(endCall).not.toHaveBeenCalled();
  });
});

describe('answerCall event', () => {
  it('sends chat.call_response accept, starts the call, and clears incoming', () => {
    useVoiceStore.getState().setIncoming({
      callId: 'call1',
      chatId: 'chat1',
      message: undefined,
      receivedAt: Date.now(),
    });
    ring();
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    __emitCallKeepEvent('answerCall', { callUUID: uuid });
    expect(send).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'call1',
      response: 'accept',
    });
    expect(startVoiceCall).toHaveBeenCalledWith('chat1', 'call', {});
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('ignores an answerCall for a stale/unknown callUUID', () => {
    __emitCallKeepEvent('answerCall', { callUUID: 'not-the-active-call' });
    expect(send).not.toHaveBeenCalled();
    expect(startVoiceCall).not.toHaveBeenCalled();
  });

  it('surfaces a send failure as a UI error but still starts the call', () => {
    send.mockImplementation(() => {
      throw new Error('ws down');
    });
    ring();
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    __emitCallKeepEvent('answerCall', { callUUID: uuid });
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('failed to send call response')),
    ).toBe(true);
    expect(startVoiceCall).toHaveBeenCalledWith('chat1', 'call', {});
  });
});

describe('agent calls', () => {
  it('answering opens the call with the reason the agent rang', () => {
    ring({ message: 'The build is red; roll back?' });
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    __emitCallKeepEvent('answerCall', { callUUID: uuid });
    expect(startVoiceCall).toHaveBeenCalledWith('chat1', 'call', {
      callReason: 'The build is red; roll back?',
    });
  });

  it('answer automatically: answered at once, in hands-free, holding transient focus', () => {
    const display = vi.spyOn(RNCallKeep, 'displayIncomingCall');
    const answer = vi.spyOn(RNCallKeep, 'answerIncomingCall').mockImplementation((uuid) => {
      __emitCallKeepEvent('answerCall', { callUUID: uuid });
    });
    ring({ message: 'Quick question', autoAnswer: true });
    const uuid = display.mock.calls.at(-1)![0];
    expect(answer).toHaveBeenCalledWith(uuid);
    expect(send).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'call1',
      response: 'accept',
    });
    expect(startVoiceCall).toHaveBeenCalledWith('chat1', 'hands-free', {
      callReason: 'Quick question',
      transientFocus: true,
    });
    answer.mockRestore();
  });

  it('the same ring over the live connection and as a push is shown and answered once', () => {
    const display = vi.spyOn(RNCallKeep, 'displayIncomingCall');
    const answer = vi.spyOn(RNCallKeep, 'answerIncomingCall');
    ring({ autoAnswer: true });
    ring({ autoAnswer: true });
    expect(display).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledTimes(1);
    answer.mockRestore();
  });
});

describe('endCall event', () => {
  it('sends chat.call_response decline and clears incoming for the active call', () => {
    useVoiceStore.getState().setIncoming({
      callId: 'call1',
      chatId: 'chat1',
      message: undefined,
      receivedAt: Date.now(),
    });
    ring();
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    __emitCallKeepEvent('endCall', { callUUID: uuid });
    expect(send).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'call1',
      response: 'decline',
    });
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  it('ignores an endCall for a stale/unknown callUUID', () => {
    __emitCallKeepEvent('endCall', { callUUID: 'unknown' });
    expect(send).not.toHaveBeenCalled();
  });

  it('endCall with no active callId does not send, just clears incoming', () => {
    ring();
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    endActiveCall(); // clears _activeCallId without touching listeners
    __emitCallKeepEvent('endCall', { callUUID: uuid });
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a send failure as a UI error', () => {
    send.mockImplementation(() => {
      throw new Error('ws down');
    });
    ring();
    const uuid = (RNCallKeep.displayIncomingCall as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    __emitCallKeepEvent('endCall', { callUUID: uuid });
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('failed to send call response')),
    ).toBe(true);
  });
});
