import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_LOST_AFTER_MS } from '@patch/wire/audio';
import { watchPeerLiveness } from '../src/audio/peer-liveness.js';

class FakeWs extends EventEmitter {
  ping = vi.fn();
  terminate = vi.fn(() => this.emit('close'));
}
const fake = (): FakeWs & WebSocket => new FakeWs() as FakeWs & WebSocket;

afterEach(() => vi.useRealTimers());

describe('watchPeerLiveness', () => {
  test('a peer heard from for nothing for the heartbeat lost time is terminated', () => {
    vi.useFakeTimers();
    const ws = fake();
    const onGone = vi.fn();
    watchPeerLiveness(ws, { onGone });
    vi.advanceTimersByTime(HEARTBEAT_LOST_AFTER_MS - HEARTBEAT_INTERVAL_MS);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith(HEARTBEAT_LOST_AFTER_MS);
  });

  test('frames keep the peer alive', () => {
    vi.useFakeTimers();
    const ws = fake();
    watchPeerLiveness(ws);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.emit('message');
    }
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  test('a pong does not count: the relay answers pings, not the device', () => {
    vi.useFakeTimers();
    const ws = fake();
    watchPeerLiveness(ws);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.emit('pong');
    }
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  test('stops watching once the socket closes', () => {
    vi.useFakeTimers();
    const ws = fake();
    watchPeerLiveness(ws);
    ws.emit('close');
    vi.advanceTimersByTime(60_000);
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});
