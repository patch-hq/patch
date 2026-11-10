import { describe, it, expect, vi } from 'vitest';

const ws = vi.hoisted(() => ({ safeSend: vi.fn(), send: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => ws }));

import { sendQuestionActivity } from '../src/lib/questionActivity';

describe('sendQuestionActivity', () => {
  it('uses the best-effort send so a closed socket cannot throw from a timer', () => {
    ws.send.mockImplementation(() => {
      throw new Error('PatchWs: not connected');
    });
    expect(() => sendQuestionActivity('c1')).not.toThrow();
    expect(ws.safeSend).toHaveBeenCalledWith({ type: 'chat.question_activity', chatId: 'c1' });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
