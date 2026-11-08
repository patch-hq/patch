// The first-meeting speech prompt (spec/02 § Speech set-up): two routes, either
// one starts the meeting that was refused.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { SpeechSetupModal } from '../components/SpeechSetupModal.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useSpeechSetupStore } from '../stores/speechSetupStore.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import { api } from '../api/rest.js';
import { reportHost, clearHosts } from './presenceHelpers.js';

const startMeeting = vi.fn(async () => {});
vi.mock('../lib/meetingControl.js', () => ({
  startMeeting: (...a: unknown[]) => startMeeting(...(a as [])),
}));
vi.mock('../api/rest.js', () => ({ api: { setProviderKey: vi.fn(async () => ({})) } }));

const comp = (id: string, bytes: number, state: string, progress?: number) => ({
  id,
  label: id,
  bytes,
  state,
  ...(progress !== undefined ? { progress } : {}),
});

describe('SpeechSetupModal', () => {
  const send = vi.fn();
  beforeEach(() => {
    send.mockReset();
    startMeeting.mockClear();
    setActiveWs({ send } as unknown as PatchWs);
    clearHosts();
    reportHost('h1', {
      hostName: 'laptop',
      components: [
        comp('whisper', 1_500_000_000, 'not-installed'),
        comp('kokoro', 340_000_000, 'not-installed'),
      ],
    } as never);
    usePresenceStore.getState().setHostOnline('h1', true);
    usePresenceStore.getState().setConnection?.('connected' as never);
    useSpeechSetupStore.getState().open({ chatId: 'c1', hostId: 'h1' });
  });
  afterEach(() => {
    cleanup();
    useSpeechSetupStore.getState().close();
  });

  it('offers both routes and states the download size', () => {
    render(<SpeechSetupModal />);
    expect(screen.getByTestId('speech-setup-key')).toBeInTheDocument();
    expect(screen.getByTestId('speech-setup-download')).toBeInTheDocument();
    expect(screen.getByTestId('speech-setup')).toHaveTextContent('1.8 GB');
  });

  it('saving a key stores it and starts the meeting again', async () => {
    render(<SpeechSetupModal />);
    fireEvent.change(screen.getByTestId('speech-setup-key'), { target: { value: 'gsk_abc' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('speech-setup-save-key'));
    });
    expect(api.setProviderKey).toHaveBeenCalledWith('groq', 'gsk_abc');
    expect(startMeeting).toHaveBeenCalledWith('c1');
    expect(useSpeechSetupStore.getState().request).toBeNull();
  });

  it('downloading sends the installs, and the meeting starts once whisper is installed', () => {
    render(<SpeechSetupModal />);
    fireEvent.click(screen.getByTestId('speech-setup-download'));
    expect(send).toHaveBeenCalledWith({
      type: 'host.component_install',
      hostId: 'h1',
      componentId: 'whisper',
    });
    expect(send).toHaveBeenCalledWith({
      type: 'host.component_install',
      hostId: 'h1',
      componentId: 'kokoro',
    });
    expect(startMeeting).not.toHaveBeenCalled();
    act(() => {
      reportHost('h1', {
        hostName: 'laptop',
        components: [
          comp('whisper', 1_500_000_000, 'installed'),
          comp('kokoro', 340_000_000, 'downloading', 0.5),
        ],
      } as never);
    });
    expect(startMeeting).toHaveBeenCalledWith('c1');
  });
});
