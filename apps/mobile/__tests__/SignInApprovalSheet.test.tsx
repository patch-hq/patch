// The phone half of "sign in from another device": a request pops up, Allow
// shows the code to type on the new device, Deny turns it away, and a failed
// answer is shown rather than swallowed.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, byLabel, hasText, actAsync, actSync } from './testUtils/render';
import { SignInApprovalSheet } from '../src/components/SignInApprovalSheet';
import { useSignInStore } from '../src/stores/signInStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { api } from '../src/api/rest';

vi.mock('../src/api/rest', () => ({
  api: { signInPending: vi.fn(), signInApprove: vi.fn(), signInDeny: vi.fn() },
}));

const soon = (): number => Date.now() + 60_000;

beforeEach(() => {
  useSignInStore.getState().reset();
  usePresenceStore.getState().setIdentity('acct', 'srf');
  vi.mocked(api.signInPending).mockResolvedValue({ requests: [] });
  vi.mocked(api.signInApprove).mockReset();
  vi.mocked(api.signInDeny).mockReset();
});

describe('SignInApprovalSheet', () => {
  it('renders nothing with no request', async () => {
    const r = renderRN(<SignInApprovalSheet />);
    await actAsync(async () => {});
    expect(r.toJSON()).toBeNull();
  });

  it('shows a request, and Allow reveals the code', async () => {
    vi.mocked(api.signInApprove).mockResolvedValue({ code: '482913', label: 'Chrome on Mac' });
    const r = renderRN(<SignInApprovalSheet />);
    await actAsync(async () => {});
    actSync(() =>
      useSignInStore.getState().add({ id: 'r1', label: 'Chrome on Mac', expiresAt: soon() }),
    );
    expect(hasText(r.root, 'Approve a Patch sign-in from Chrome on a Mac?')).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byLabel('Allow')).props.onPress();
    });
    expect(api.signInApprove).toHaveBeenCalledWith('r1');
    expect(hasText(r.root, '482913')).toBe(true);
    actSync(() => findHost(r.root, byLabel('Done')).props.onPress());
    expect(r.toJSON()).toBeNull();
  });

  it('Deny turns it away and clears it', async () => {
    vi.mocked(api.signInDeny).mockResolvedValue({ ok: true });
    const r = renderRN(<SignInApprovalSheet />);
    await actAsync(async () => {});
    actSync(() => useSignInStore.getState().add({ id: 'r2', label: 'Firefox', expiresAt: soon() }));
    await actAsync(async () => {
      findHost(r.root, byLabel('Deny')).props.onPress();
    });
    expect(api.signInDeny).toHaveBeenCalledWith('r2');
    expect(r.toJSON()).toBeNull();
  });

  it('shows a failed answer', async () => {
    vi.mocked(api.signInApprove).mockRejectedValue(new Error('no such pending sign-in request'));
    const r = renderRN(<SignInApprovalSheet />);
    await actAsync(async () => {});
    actSync(() => useSignInStore.getState().add({ id: 'r3', label: 'x', expiresAt: soon() }));
    await actAsync(async () => {
      findHost(r.root, byLabel('Allow')).props.onPress();
    });
    expect(hasText(r.root, 'no such pending sign-in request')).toBe(true);
  });

  it('a failed pending check can be dismissed', async () => {
    vi.mocked(api.signInPending).mockRejectedValue(new Error('offline'));
    const r = renderRN(<SignInApprovalSheet />);
    await actAsync(async () => {});
    expect(hasText(r.root, 'Could not check for sign-in requests: offline')).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byLabel('Dismiss')).props.onPress();
    });
    expect(r.toJSON()).toBeNull();
  });
});
