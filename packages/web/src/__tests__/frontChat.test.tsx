// The renderer reports the open chat to the desktop shell on change and on
// window focus; a plain browser (no bridge) is untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useFrontChatReport } from '../lib/frontChat.js';
import { useChatStore } from '../stores/chatStore.js';

function Probe(): null {
  useFrontChatReport();
  return null;
}

const row = (chatId: string, name: string | null) => ({
  chatId,
  hostId: 'd1',
  permissionMode: 'bypassPermissions' as const,
  name,
  folder: '/p/portfolio',
  activity: 'idle' as const,
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  disabled: false,
  lastUpdated: 0,
});

describe('useFrontChatReport', () => {
  let report: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    report = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { reportOpenChat: report };
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useChatStore.getState().hydrate([row('c1', 'Fix login'), row('c2', 'Other')]);
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { patch?: unknown }).patch;
    vi.restoreAllMocks();
  });

  it('reports the chat on change and again on window focus', () => {
    act(() => useChatStore.setState({ activeChatId: 'c1' }));
    render(<Probe />);
    expect(report).toHaveBeenLastCalledWith({
      chatId: 'c1',
      name: 'Fix login',
      folder: '/p/portfolio',
    });
    act(() => useChatStore.setState({ activeChatId: 'c2' }));
    expect(report).toHaveBeenLastCalledWith({
      chatId: 'c2',
      name: 'Other',
      folder: '/p/portfolio',
    });
    report.mockClear();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('a window without focus does not report on change', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => useChatStore.setState({ activeChatId: 'c1' }));
    render(<Probe />);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports no chat when none is open', () => {
    act(() => useChatStore.setState({ activeChatId: null }));
    render(<Probe />);
    expect(report).toHaveBeenLastCalledWith({ chatId: null, name: null, folder: null });
  });

  it('is a no-op without a desktop bridge', () => {
    delete (window as unknown as { patch?: unknown }).patch;
    expect(() => render(<Probe />)).not.toThrow();
  });
});
