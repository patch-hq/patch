// A server or host restart must never leave the phone frozen: a socket that
// goes silent while still OPEN, or a dial that never completes, is detected and
// redialled (mirrors the web client's zombie-socket watchdog).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppState } from 'react-native';
import {
  PatchWs,
  resetWs,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_LIVENESS_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
} from '../src/api/ws';
import { saveCredential } from '../src/lib/credential';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';

beforeEach(() => {
  installFakeWebSocket();
  vi.useFakeTimers();
  saveCredential('a.b.c');
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connecting');
  AppState.currentState = 'active';
});

afterEach(() => {
  resetWs();
  vi.useRealTimers();
  restoreWebSocket();
  vi.restoreAllMocks();
});

const authOk = JSON.stringify({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
const ack = JSON.stringify({ type: 'surface.heartbeat_ack' });

describe('dead-link watchdog', () => {
  it('redials a socket that stays OPEN but goes silent after acking heartbeats', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    const first = FakeWebSocket.last();
    first.emitOpen();
    first.emitMessage(authOk);
    first.emitMessage(ack);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(HEARTBEAT_LIVENESS_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS * 2);

    expect(first.close).toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    ws.close();
  });

  it('leaves the socket alone while acks keep arriving', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    const first = FakeWebSocket.last();
    first.emitOpen();
    first.emitMessage(authOk);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      first.emitMessage(ack);
    }
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    ws.close();
  });

  it('stays disarmed with a server that never acks', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    const first = FakeWebSocket.last();
    first.emitOpen();
    first.emitMessage(authOk);
    vi.advanceTimersByTime(HEARTBEAT_LIVENESS_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS * 3);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    ws.close();
  });
});

describe('connect timeout', () => {
  it('abandons a dial that never opens and dials again', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    const first = FakeWebSocket.last();
    expect(first.readyState).toBe(0);

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 10);

    expect(first.close).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    ws.close();
  });

  it('does not fire once the socket has opened', () => {
    const ws = new PatchWs('ws://test/ws');
    ws.connect();
    FakeWebSocket.last().emitOpen();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    ws.close();
  });
});
