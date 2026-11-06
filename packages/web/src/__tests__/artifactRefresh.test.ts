// spec/14 § Artifacts — when the agent republishes a page, an open artifact tab
// for that same page reloads; any other artifact is left alone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { onArtifactRefresh } from '../lib/artifactRefresh.js';

const artifact = (artifactId: string, seq: number): WireEvent =>
  ({
    type: 'chat.artifact',
    chatId: 'chat_a',
    artifactId,
    title: 'Page',
    url: `/api/chats/chat_a/artifact/${artifactId}?sig=abc`,
    path: `out/${artifactId}.html`,
    updatedAt: 1_700_000_000_000 + seq,
    seq,
  }) as WireEvent;

describe('republishing an artifact', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('notifies listeners with the republished page path', () => {
    const listener = vi.fn();
    const off = onArtifactRefresh(listener);
    useChatStore.getState().applyEvent(artifact('aaa', 1));
    expect(listener).not.toHaveBeenCalled(); // first publish is not a refresh
    useChatStore.getState().applyEvent(artifact('aaa', 2));
    off();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('/api/chats/chat_a/artifact/aaa');
  });
});
