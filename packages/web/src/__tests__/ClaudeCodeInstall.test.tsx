import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';
import { connectDoneText, isGuideItemDone } from '../lib/guide.js';

const sent = vi.fn();
vi.mock('../routes/settings/hostWrite.js', () => ({
  sendToHost: (...a: unknown[]) => {
    sent(...a);
    return true;
  },
}));

import { ClaudeCodeInstall } from '../routes/settings/ClaudeCodeInstall.js';

function host(state: string, error?: string): HostPresence {
  return {
    hostId: 'h1',
    online: true,
    host: {
      hostName: 'Mac',
      backends: [{ id: 'claude-code', label: 'Claude Code', version: null, state, error }],
    },
  } as unknown as HostPresence;
}

afterEach(() => {
  cleanup();
  sent.mockClear();
  usePresenceStore.setState({ hosts: {} });
});

describe('Settings → Claude Code install', () => {
  it('a failed install says why in plain words and Retry asks the host again', () => {
    usePresenceStore.setState({
      hosts: {
        h1: host('failed', "Couldn't download Claude Code. Check your internet connection."),
      },
    });
    render(<ClaudeCodeInstall />);
    expect(screen.getByTestId('claude-code-install-h1')).toHaveTextContent(/Check your internet/);
    fireEvent.click(screen.getByTestId('claude-code-reinstall-h1'));
    expect(sent).toHaveBeenCalledWith(expect.anything(), {
      type: 'host.backend_install',
      hostId: 'h1',
      backendId: 'claude-code',
    });
  });

  it('an installed Claude Code can be reinstalled', () => {
    usePresenceStore.setState({ hosts: { h1: host('present') } });
    render(<ClaudeCodeInstall />);
    fireEvent.click(screen.getByTestId('claude-code-reinstall-h1'));
    expect(sent.mock.calls[0]![1]).toMatchObject({ reinstall: true });
  });

  it('shows progress while installing, with the button held', () => {
    usePresenceStore.setState({ hosts: { h1: host('installing') } });
    render(<ClaudeCodeInstall />);
    expect(screen.getByTestId('claude-code-reinstall-h1')).toBeDisabled();
  });
});

describe('guide with Claude Code missing', () => {
  const p = { connected: true, hasChat: false, claudeCodeMissing: true };
  it('is not called ready', () => {
    expect(isGuideItemDone('connect', p)).toBe(false);
    expect(connectDoneText(p).line).not.toMatch(/You can send messages/);
  });
});
