// The chat screen's error boundary: a render error shows a short message and
// records error + stack + chat id, instead of taking the app down.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { actSync, byTestId, findHost, renderRN, textOf } from './testUtils/render';

const { recordCrash } = vi.hoisted(() => ({ recordCrash: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/crashReport', async (orig) => ({
  ...(await orig<typeof import('../src/lib/crashReport')>()),
  recordCrash,
}));

import { ChatErrorBoundary } from '../src/components/ChatErrorBoundary';

let shouldThrow = true;
function Bomb(): React.ReactElement {
  if (shouldThrow) throw new Error('cannot read property of undefined');
  return <>{'fine'}</>;
}

afterEach(() => {
  recordCrash.mockClear();
  shouldThrow = true;
});

describe('ChatErrorBoundary', () => {
  it('shows the error and records it with the chat id', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onBack = vi.fn();
    const r = renderRN(
      <ChatErrorBoundary chatId="chat-7" onBack={onBack}>
        <Bomb />
      </ChatErrorBoundary>,
    );
    expect(textOf(findHost(r.root, byTestId('chat-error-message')))).toBe(
      'cannot read property of undefined',
    );
    expect(recordCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'boundary',
        chatId: 'chat-7',
        message: 'cannot read property of undefined',
        stack: expect.stringContaining('Bomb'),
        componentStack: expect.any(String),
      }),
    );
    findHost(r.root, byTestId('chat-error-back')).props['onPress']();
    expect(onBack).toHaveBeenCalled();

    shouldThrow = false;
    actSync(() => findHost(r.root, byTestId('chat-error-retry')).props['onPress']());
    expect(r.root.findAll((n) => n.children.includes('fine')).length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
