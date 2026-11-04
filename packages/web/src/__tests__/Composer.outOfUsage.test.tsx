// Send is refused while every account on the chat's host is out of usage — the
// turn would only park. Unknown is not spent: an account with no reading, or
// one still usable, never blocks.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { HostAccountSummary } from '@patch/wire';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { clearHosts, reportAccounts } from './presenceHelpers.js';

const spent = (id: string): HostAccountSummary => ({
  id,
  label: id,
  accountEmail: `${id}@example.com`,
  connected: true,
  usage: {
    session: { status: 'rejected', utilization: 1, resetsAt: Date.now() + 3_600_000 },
  },
});
const fine = (id: string): HostAccountSummary => ({
  id,
  label: id,
  accountEmail: `${id}@example.com`,
  connected: true,
  usage: { session: { status: 'allowed', utilization: 0.1 } },
});
const unread = (id: string): HostAccountSummary => ({
  id,
  label: id,
  accountEmail: `${id}@example.com`,
  connected: true,
});

function mount(onSend: (m: string) => Promise<boolean>) {
  render(<Composer chatId="c1" hostId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
  const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'hello' } });
  return input;
}

beforeEach(() => {
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  cleanup();
  clearHosts();
});

describe('Composer — out of usage', () => {
  it('disables Send and ignores Enter when every account is spent', () => {
    reportAccounts('d1', [spent('a'), spent('b')]);
    const calls: string[] = [];
    const input = mount(async (m) => (calls.push(m), true));
    const send = screen.getByTestId('send-btn') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toMatch(/out of usage/i);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calls).toEqual([]);
  });

  it('keeps Send enabled while one account has usage left', () => {
    reportAccounts('d1', [spent('a'), fine('b')]);
    mount(async () => true);
    expect((screen.getByTestId('send-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not block on an account with no reading', () => {
    reportAccounts('d1', [spent('a'), unread('b')]);
    mount(async () => true);
    expect((screen.getByTestId('send-btn') as HTMLButtonElement).disabled).toBe(false);
  });
});
