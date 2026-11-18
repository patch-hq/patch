// Settings → Hosts → Keep running (spec/05 § Keep running, spec/11 § Server on a Mac):
// the server this Mac runs can be turned off from here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeepRunningGroup } from '../routes/settings/KeepRunningGroup.js';

const state = { openAtLogin: true, keepAwake: true, holdingAwake: false, canOpenAtLogin: true };

function withBridge(bridge: unknown): void {
  (window as unknown as { patch?: unknown }).patch = bridge;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { patch?: unknown }).patch;
});

describe('KeepRunningGroup server row', () => {
  it('turns the server on this computer off', async () => {
    const turnOff = vi.fn().mockResolvedValue(undefined);
    withBridge({
      keepRunning: { get: async () => state, set: async () => state },
      localServer: { turnOff },
    });
    render(<KeepRunningGroup />);
    fireEvent.click(screen.getByTestId('keep-running-server-off'));
    await waitFor(() => expect(turnOff).toHaveBeenCalledOnce());
  });

  it('says why when it cannot be turned off', async () => {
    withBridge({
      keepRunning: { get: async () => state, set: async () => state },
      localServer: { turnOff: () => Promise.reject(new Error('launchctl disable failed')) },
    });
    render(<KeepRunningGroup />);
    fireEvent.click(screen.getByTestId('keep-running-server-off'));
    expect(await screen.findByRole('alert')).toHaveTextContent('launchctl disable failed');
  });

  it('has no server row where the shell does not run the server as a service', () => {
    withBridge({ keepRunning: { get: async () => state, set: async () => state } });
    render(<KeepRunningGroup />);
    expect(screen.queryByTestId('keep-running-server-off')).toBeNull();
  });
});
