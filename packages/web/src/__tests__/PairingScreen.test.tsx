import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { PairingScreen } from '../components/PairingScreen.js';
import { api, ApiError } from '../api/rest.js';
import { clearCredential, loadCredential } from '../lib/credential.js';

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'EdDSA' })}.${b64url(payload)}.sig`;
}

beforeEach(() => {
  vi.spyOn(api, 'signInRequest').mockResolvedValue({ id: 'r1', secret: 's1', expiresAt: 1 });
  vi.spyOn(api, 'signInState').mockResolvedValue({ state: 'pending' });
});

afterEach(() => {
  cleanup();
  clearCredential();
  vi.restoreAllMocks();
});

describe('PairingScreen', () => {
  it('disables submit until text is entered', () => {
    render(<PairingScreen onPaired={() => {}} />);
    const submit = screen.getByTestId('pairing-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: '  ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'abc' } });
    expect(submit.disabled).toBe(false);
  });

  it('shows an error for a malformed token and does not call onPaired', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt' } });
    fireEvent.click(screen.getByTestId('pairing-submit'));
    expect(screen.getByTestId('pairing-error')).toBeTruthy();
    expect(screen.getByText(/doesn.t look like a credential token/)).toBeTruthy();
    expect(onPaired).not.toHaveBeenCalled();
    expect(loadCredential()).toBeNull();
  });

  it('clears the error once the user edits the input again', () => {
    render(<PairingScreen onPaired={() => {}} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt' } });
    fireEvent.click(screen.getByTestId('pairing-submit'));
    expect(screen.getByTestId('pairing-error')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt2' } });
    expect(screen.queryByTestId('pairing-error')).toBeNull();
  });

  it('saves a well-formed credential and calls onPaired', () => {
    const onPaired = vi.fn();
    const token = jwt({ surface_id: 'web-1' });
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: `  ${token}  ` } });
    fireEvent.click(screen.getByTestId('pairing-submit'));
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(loadCredential()).toBe(token);
    expect(screen.queryByTestId('pairing-error')).toBeNull();
  });
  // spec/14 § Keyboard shortcuts — `⌘↵` commits the field. Pasting a token and
  // reaching for the mouse is the wrong shape for a paste-and-go screen.
  it('⌘↵ in the paste box signs in, exactly as Continue does', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    const token = jwt({ surface_id: 'web-2' });
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: token } });
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter', metaKey: true });
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(loadCredential()).toBe(token);
  });

  it('⌘↵ on a malformed token reports it rather than signing in', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), { target: { value: 'not-a-jwt' } });
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter', metaKey: true });
    expect(screen.getByTestId('pairing-error')).toBeTruthy();
    expect(onPaired).not.toHaveBeenCalled();
    expect(loadCredential()).toBeNull();
  });

  it('⌘↵ on an empty box does nothing — Continue is disabled there too', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter', metaKey: true });
    expect(onPaired).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pairing-error')).toBeNull();
  });

  it('bare ↵ inserts a newline instead of signing in', () => {
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId('pairing-input'), {
      target: { value: jwt({ surface_id: 'web-3' }) },
    });
    fireEvent.keyDown(screen.getByTestId('pairing-input'), { key: 'Enter' });
    expect(onPaired).not.toHaveBeenCalled();
  });

  it('Continue names the chord that presses it', () => {
    render(<PairingScreen onPaired={() => {}} />);
    expect(screen.getByTestId('pairing-submit').getAttribute('title')).toBe('Ctrl+Enter');
  });
});

describe('PairingScreen — approval from another device', () => {
  it('asks on mount and takes a typed code for a credential', async () => {
    const onPaired = vi.fn();
    const token = jwt({ surface_id: 'web-9' });
    const redeem = vi.spyOn(api, 'signInRedeem').mockResolvedValue({ credential: token });
    render(<PairingScreen onPaired={onPaired} />);
    await screen.findByTestId('signin-waiting');
    expect(api.signInRequest).toHaveBeenCalledTimes(1);
    const input = screen.getByTestId('signin-code-input');
    fireEvent.change(input, { target: { value: '12a345' } });
    expect((input as HTMLInputElement).value).toBe('12345');
    expect((screen.getByTestId('signin-redeem') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('signin-redeem'));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(redeem).toHaveBeenCalledWith('r1', 's1', '123456');
    expect(loadCredential()).toBe(token);
  });

  it('says so when the code is wrong and stays signed out', async () => {
    const onPaired = vi.fn();
    vi.spyOn(api, 'signInRedeem').mockRejectedValue(
      new ApiError(403, 'wrong_code', { error: 'wrong_code' }),
    );
    render(<PairingScreen onPaired={onPaired} />);
    await screen.findByTestId('signin-waiting');
    fireEvent.change(screen.getByTestId('signin-code-input'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('signin-redeem'));
    expect((await screen.findByTestId('signin-code-error')).textContent).toMatch(/not right/);
    expect(onPaired).not.toHaveBeenCalled();
    expect(loadCredential()).toBeNull();
  });

  it('reports a denied request and offers to ask again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'signInState').mockResolvedValue({ state: 'denied' });
      render(<PairingScreen onPaired={() => {}} />);
      await screen.findByTestId('signin-waiting');
      await vi.advanceTimersByTimeAsync(2100);
      expect((await screen.findByTestId('signin-ended')).textContent).toMatch(/denied/);
      fireEvent.click(screen.getByTestId('signin-retry'));
      await waitFor(() => expect(api.signInRequest).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no account on the server, says so and opens the token box', async () => {
    vi.spyOn(api, 'signInRequest').mockRejectedValue(
      new ApiError(400, 'no account bootstrapped', { error: 'no account bootstrapped' }),
    );
    render(<PairingScreen onPaired={() => {}} />);
    expect((await screen.findByTestId('signin-ended')).textContent).toMatch(/no account/);
  });
});
