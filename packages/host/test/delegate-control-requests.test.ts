import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import {
  handleDelegateControlRequest,
  type DelegateControlDeps,
} from '../src/delegateControlRequests.js';

const logger = pino({ level: 'silent' });

function run(
  action: 'pause' | 'resume' | 'stop' | 'spin_off',
  over: Partial<DelegateControlDeps> = {},
) {
  const sent: WireEvent[] = [];
  const deps: DelegateControlDeps = {
    hasChat: () => true,
    isDelegateOf: () => true,
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    spinOff: vi.fn(() => 'sub-1'),
    ...over,
  };
  const done = handleDelegateControlRequest(
    {
      type: 'patch.delegate_control.request',
      requestId: 'r1',
      chatId: 'p',
      delegateId: 'sub-1',
      action,
    },
    deps,
    (e) => sent.push(e),
    logger,
  );
  return { sent, deps, done };
}

describe('patch.delegate_control.request', () => {
  it.each(['pause', 'resume', 'stop'] as const)(
    '%s calls through and reports applied',
    async (a) => {
      const { sent, deps, done } = run(a);
      await done;
      expect(deps[a]).toHaveBeenCalledWith('p', 'sub-1');
      expect(sent).toEqual([
        { type: 'patch.delegate_control.response', requestId: 'r1', ok: true, applied: true },
      ]);
    },
  );

  it('spin_off returns the new chat id', async () => {
    const { sent, done } = run('spin_off');
    await done;
    expect(sent[0]).toMatchObject({ ok: true, applied: true, spunOffChatId: 'sub-1' });
  });

  it('refuses an unknown chat and a delegate that is not the chat’s own', async () => {
    const a = run('stop', { hasChat: () => false });
    await a.done;
    expect(a.sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
    const b = run('stop', { isDelegateOf: () => false });
    await b.done;
    expect(b.sent[0]).toMatchObject({ ok: false, error: { code: 'not_a_delegate' } });
    expect(b.deps.stop).not.toHaveBeenCalled();
  });

  it('reports a failure instead of swallowing it', async () => {
    const { sent, done } = run('pause', {
      pause: async () => {
        throw new Error('boom');
      },
    });
    await done;
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal', message: 'boom' } });
  });
});
