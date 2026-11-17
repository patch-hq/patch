import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { watchPeerLiveness } from '../src/audio/peer-liveness.js';

class FakeWs extends EventEmitter {
  ping = vi.fn();
  terminate = vi.fn(() => this.emit('close'));
}
const fake = (): FakeWs & WebSocket => new FakeWs() as FakeWs & WebSocket;

afterEach(() => vi.useRealTimers());

describe('watchPeerLiveness', () => {
  test('a silent peer is terminated after the timeout', () => {
    vi.useFakeTimers();
    const ws = fake();
    const onDead = vi.fn();
    watchPeerLiveness(ws, { timeoutMs: 30_000, pingIntervalMs: 10_000, onDead });
    vi.advanceTimersByTime(29_000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  test('frames and pongs keep the peer alive', () => {
    vi.useFakeTimers();
    const ws = fake();
    watchPeerLiveness(ws, { timeoutMs: 30_000, pingIntervalMs: 10_000 });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(10_000);
      ws.emit(i % 2 ? 'message' : 'pong');
    }
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  test('stops pinging once the socket closes', () => {
    vi.useFakeTimers();
    const ws = fake();
    watchPeerLiveness(ws, { timeoutMs: 30_000, pingIntervalMs: 10_000 });
    ws.emit('close');
    vi.advanceTimersByTime(120_000);
    expect(ws.ping).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});
