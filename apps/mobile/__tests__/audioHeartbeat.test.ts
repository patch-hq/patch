// Every audio session on the phone answers the host's heartbeat (spec/07 § A
// dropped call comes back): the host judges the device by what it hears.

import { describe, expect, it, vi } from 'vitest';
import { answerHeartbeat } from '../src/lib/audioHeartbeat';

const OPEN = 1;
const CLOSED = 3;

describe('answerHeartbeat', () => {
  it('echoes a heartbeat with its number and no round trip', () => {
    const ws = { readyState: OPEN, send: vi.fn() };
    answerHeartbeat(ws, { type: 'audio.heartbeat', sessionId: 's1', n: 9, rttMs: 30 });
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toEqual({
      type: 'audio.heartbeat',
      sessionId: 's1',
      n: 9,
    });
  });

  it('ignores every other frame, and a closed socket', () => {
    const ws = { readyState: OPEN, send: vi.fn() };
    answerHeartbeat(ws, { type: 'audio.tts_end', sessionId: 's1' });
    answerHeartbeat(
      { readyState: CLOSED, send: ws.send },
      {
        type: 'audio.heartbeat',
        sessionId: 's1',
        n: 1,
      },
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('a send that fails is logged, not thrown', () => {
    const ws = {
      readyState: OPEN,
      send: () => {
        throw new Error('socket gone');
      },
    };
    expect(() =>
      answerHeartbeat(ws, { type: 'audio.heartbeat', sessionId: 's1', n: 0 }),
    ).not.toThrow();
  });
});
