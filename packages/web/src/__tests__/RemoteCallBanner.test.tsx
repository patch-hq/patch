// Call handoff, web side (spec/07 § A call can move between devices): a call
// live on another surface shows as a banner with Switch here; switching opens
// this surface's call with takeOver; the banner follows the host's events.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RemoteCallBanner } from '../components/RemoteCallBanner.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { __setAudioOpenerForTests } from '../lib/voiceController.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';

const remote = {
  sessionId: 's1',
  surfaceId: 'phone',
  surfaceKind: 'mobile',
  chatId: 'c1',
  startedAt: 1,
};

describe('RemoteCallBanner', () => {
  beforeEach(() => {
    useVoiceStore.setState({ call: null, remoteCalls: {}, session: null });
    __setAudioOpenerForTests(null);
  });

  it('is hidden with no remote call, and shows device and chat when there is one', () => {
    render(<RemoteCallBanner />);
    expect(screen.queryByTestId('remote-call')).toBeNull();
    act(() => useVoiceStore.getState().setRemoteCall(remote, true));
    expect(screen.getByTestId('remote-call').textContent).toContain('your phone');
    expect(screen.getByTestId('remote-call').textContent).toContain('New chat');
  });

  it('names the chat the way the sidebar does: Manager for the manager thread, markdown stripped', () => {
    const chats = useChatStore.getState().chats;
    useChatStore.setState({
      chats: {
        ...chats,
        c1: { ...(chats['c1'] ?? {}), name: '**Fix** the boiler' } as never,
        [SPECIAL_THREAD_IDS.manager]: { name: 'manager' } as never,
      },
    });
    render(<RemoteCallBanner />);
    act(() => useVoiceStore.getState().setRemoteCall(remote, true));
    expect(screen.getByTestId('remote-call').textContent).toContain('Fix the boiler');
    act(() => {
      useVoiceStore.getState().setRemoteCall(remote, false);
      useVoiceStore
        .getState()
        .setRemoteCall({ ...remote, chatId: SPECIAL_THREAD_IDS.manager }, true);
    });
    expect(screen.getByTestId('remote-call').textContent).toContain('· Manager');
    useChatStore.setState({ chats });
  });

  it('disappears when the other call ends', () => {
    render(<RemoteCallBanner />);
    act(() => useVoiceStore.getState().setRemoteCall(remote, true));
    act(() => useVoiceStore.getState().setRemoteCall(remote, false));
    expect(screen.queryByTestId('remote-call')).toBeNull();
  });

  it('is hidden while this surface is on its own call', () => {
    render(<RemoteCallBanner />);
    act(() => {
      useVoiceStore.getState().setRemoteCall(remote, true);
      useVoiceStore.getState().startCall('c1');
    });
    expect(screen.queryByTestId('remote-call')).toBeNull();
  });

  it('Switch here opens a call on that chat with takeOver', async () => {
    const opener = vi.fn().mockResolvedValue({ end: vi.fn(), sessionId: 'x', chatId: 'c1' });
    __setAudioOpenerForTests(opener);
    useChatStore.setState({ chats: {} });
    render(<RemoteCallBanner />);
    act(() => useVoiceStore.getState().setRemoteCall(remote, true));
    await act(async () => {
      fireEvent.click(screen.getByTestId('remote-call-switch'));
    });
    expect(opener).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', role: 'voice-call', takeOver: true }),
    );
  });
});
