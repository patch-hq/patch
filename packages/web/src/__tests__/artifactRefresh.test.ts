// spec/14 § Artifacts — when the agent republishes the artifact the desktop
// panel is showing, the panel reloads it; any other artifact is left alone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { _resetArtifactPanel, rememberArtifact } from '../lib/artifactPanel.js';

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

const origin = window.location.origin;

describe('republishing the artifact on show', () => {
  let openPanel: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useChatStore.getState()._reset();
    _resetArtifactPanel();
    openPanel = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openPanel, closePanel: vi.fn() };
  });
  afterEach(() => {
    delete (window as unknown as { patch?: unknown }).patch;
    _resetArtifactPanel();
  });

  it('reloads the panel with the republished URL', () => {
    useChatStore.getState().applyEvent(artifact('aaa', 1));
    rememberArtifact('chat_a', `${origin}/api/chats/chat_a/artifact/aaa?sig=abc`);
    useChatStore.getState().applyEvent(artifact('aaa', 2));
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(openPanel).toHaveBeenCalledWith(`${origin}/api/chats/chat_a/artifact/aaa?sig=abc`);
  });

  it('leaves the panel alone when a different artifact is republished', () => {
    rememberArtifact('chat_a', `${origin}/api/chats/chat_a/artifact/aaa?sig=abc`);
    useChatStore.getState().applyEvent(artifact('bbb', 2));
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('does nothing when no panel is open', () => {
    useChatStore.getState().applyEvent(artifact('aaa', 2));
    expect(openPanel).not.toHaveBeenCalled();
  });
});
