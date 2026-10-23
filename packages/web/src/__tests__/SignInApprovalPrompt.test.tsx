import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SignInApprovalPrompt } from '../components/SignInApprovalPrompt.js';
import { api } from '../api/rest.js';
import { useSignInStore } from '../stores/signInStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

beforeEach(() => {
  useSignInStore.getState().reset();
  usePresenceStore.getState().setIdentity('acct', 'srf');
  vi.spyOn(api, 'signInPending').mockResolvedValue({ requests: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const soon = (): number => Date.now() + 60_000;

describe('SignInApprovalPrompt', () => {
  it('renders nothing with no request', async () => {
    render(<SignInApprovalPrompt />);
    await waitFor(() => expect(api.signInPending).toHaveBeenCalled());
    expect(screen.queryByTestId('signin-prompt')).toBeNull();
  });

  it('pops up for a live request, and Allow shows the code', async () => {
    const approve = vi
      .spyOn(api, 'signInApprove')
      .mockResolvedValue({ code: '482913', label: 'Chrome on Mac' });
    render(<SignInApprovalPrompt />);
    act(() =>
      useSignInStore.getState().add({ id: 'r1', label: 'Chrome on Mac', expiresAt: soon() }),
    );
    expect((await screen.findByTestId('signin-prompt')).textContent).toContain(
      'Approve a Patch sign-in from Chrome on a Mac?',
    );
    fireEvent.click(screen.getByTestId('signin-allow'));
    expect((await screen.findByTestId('signin-code-value')).textContent).toBe('482913');
    expect(approve).toHaveBeenCalledWith('r1');
    fireEvent.click(screen.getByTestId('signin-done'));
    expect(screen.queryByTestId('signin-code')).toBeNull();
  });

  it('Deny turns it away and dismisses the prompt', async () => {
    const deny = vi.spyOn(api, 'signInDeny').mockResolvedValue({ ok: true });
    render(<SignInApprovalPrompt />);
    act(() =>
      useSignInStore.getState().add({ id: 'r2', label: 'Firefox on Linux', expiresAt: soon() }),
    );
    fireEvent.click(await screen.findByTestId('signin-deny'));
    await waitFor(() => expect(screen.queryByTestId('signin-prompt')).toBeNull());
    expect(deny).toHaveBeenCalledWith('r2');
  });

  it('picks up a request made while it was away', async () => {
    vi.spyOn(api, 'signInPending').mockResolvedValue({
      requests: [{ id: 'r3', label: 'Safari on iOS', expiresAt: soon() }],
    });
    render(<SignInApprovalPrompt />);
    expect((await screen.findByTestId('signin-prompt')).textContent).toContain(
      'Safari on an iOS device',
    );
  });

  it('shows a failed answer instead of swallowing it', async () => {
    vi.spyOn(api, 'signInApprove').mockRejectedValue(new Error('no such pending sign-in request'));
    render(<SignInApprovalPrompt />);
    act(() => useSignInStore.getState().add({ id: 'r4', label: 'x', expiresAt: soon() }));
    fireEvent.click(await screen.findByTestId('signin-allow'));
    expect((await screen.findByTestId('signin-error')).textContent).toMatch(/no such pending/);
  });

  it('a failed pending check logs and shows no popup, then recovers on a later good check', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = vi.spyOn(api, 'signInPending').mockRejectedValue(new Error('HTTP 502'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<SignInApprovalPrompt />);
      await waitFor(() => expect(logged).toHaveBeenCalled());
      expect(String(logged.mock.calls[0]?.join(' '))).toMatch(/sign-in requests.*HTTP 502/);
      expect(screen.queryByTestId('signin-prompt')).toBeNull();

      pending.mockResolvedValue({ requests: [{ id: 'r9', label: 'Firefox', expiresAt: soon() }] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(await screen.findByTestId('signin-allow')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
