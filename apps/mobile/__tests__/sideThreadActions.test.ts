// lib/sideThreadActions.ts — what a refused send leaves behind.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));

import { offQuoteLabel, startSideThread } from '../src/lib/sideThreadActions';
import { useSideThreadsStore } from '../src/stores/sideThreadsStore';
import { useUiStore } from '../src/stores/uiStore';

beforeEach(() => {
  send.mockReset();
  useSideThreadsStore.setState({ activeTabByChatId: {}, pendingNewTab: {}, draftByChatId: {} });
  useUiStore.setState({ errors: [] });
});

describe('startSideThread', () => {
  it('expects the new tab once the request is sent', () => {
    startSideThread('c1', 3, 'why?');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.side_request' }));
    expect(useSideThreadsStore.getState().pendingNewTab['c1']).toBe(true);
  });

  it('a send that throws says so and does not leave a new tab expected', () => {
    send.mockImplementation(() => {
      throw new Error('PatchWs: not connected');
    });
    startSideThread('c1', 3, 'why?');
    expect(useUiStore.getState().errors.at(-1)?.message).toContain('not connected');
    expect(useSideThreadsStore.getState().pendingNewTab['c1']).toBeFalsy();
  });

  it("so another surface's branch does not swallow the unsent draft", () => {
    send.mockImplementation(() => {
      throw new Error('PatchWs: not connected');
    });
    useSideThreadsStore.getState().openDraft('c1', { seq: 3, quotedMessage: 'q' });
    startSideThread('c1', 3, 'why?');
    useSideThreadsStore.getState().openThread('c1', 'someone-elses-branch');
    expect(useSideThreadsStore.getState().draftByChatId['c1']).toBeDefined();
  });
});

describe('offQuoteLabel', () => {
  it('quotes a short message whole', () => {
    expect(offQuoteLabel('why?')).toBe('Off "why?"');
  });

  it('cuts a long one on a code point, never through half an emoji', () => {
    const label = offQuoteLabel(`${'a'.repeat(89)}😀 and the rest`);
    expect(label).toBe(`Off "${'a'.repeat(89)}😀"`);
  });
});
