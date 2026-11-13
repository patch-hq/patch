// chat.delegate_update.runStartedAt — the run clock is the host's, not the
// time this surface first saw the update, so a reload does not restart it.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

function update(extra: Record<string, unknown>, seq = 2): void {
  useChatStore.getState().applyEvent({
    type: 'chat.delegate_update',
    chatId: 'c1',
    delegateId: 'd1',
    label: 'agent',
    status: 'running',
    seq,
    ...extra,
  } as never);
}

describe('chatStore — delegate run clock', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', hostId: 'h', chatId: 'c1', folder: '~/p' });
  });

  it('uses the host runStartedAt as since', () => {
    update({ runStartedAt: 1_000 });
    expect(useChatStore.getState().delegateUpdates['c1']!['d1']!.since).toBe(1_000);
  });

  it('a follow-up wake replaces the old since and is flagged', () => {
    update({ runStartedAt: 1_000 });
    update({ runStartedAt: 9_000, followUp: true }, 3);
    const d = useChatStore.getState().delegateUpdates['c1']!['d1']!;
    expect(d.since).toBe(9_000);
    expect(d.followUp).toBe(true);
  });
});
