// The composer's account menu and Claude on Amazon Bedrock accounts (spec/15 §
// Composer → Account, spec/10 § Backend credentials): a Bedrock account is
// offered only for a chat on its own host, with the month's spend in place of
// the usage windows, and no host is ever asked to probe it.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { bedrockMonth } from '@patch/wire';
import { renderRN, byTestId, findHost, queryHost, textOf } from './testUtils/render';
import { AccountMenu } from '../src/components/AccountMenu';
import { reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));

const bedrock = (hostId: string, spentUsd = 18.42) => ({
  hostId,
  awsProfile: 'work',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu' as const,
  monthlyCapUsd: 100,
  spentUsd,
  spentMonth: bedrockMonth(Date.now()),
});

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});
beforeEach(() => {
  send.mockClear();
  resetHosts();
  reportHost('h1');
  reportHost('h2');
  seedSettings({
    shared: {
      version: 1,
      hosts: [],
      secrets: {
        claude: [
          { id: 'b1', label: 'Work AWS', connected: true, auto: false, bedrock: bedrock('h1') },
          { id: 'b2', label: 'Client AWS', connected: true, bedrock: bedrock('h2', 3) },
          { id: 'b3', label: 'Expired', connected: false, bedrock: bedrock('h1') },
        ],
        codex: [],
        providerKeys: [],
      },
    },
  });
});

function render(hostId: string | null): ReactTestRenderer {
  const r = renderRN(
    <AccountMenu
      visible
      backendId="claude-code"
      model="claude-sonnet-5"
      hostId={hostId}
      selectedId={null}
      strategySelected
      onSelect={() => undefined}
      onDismiss={() => undefined}
    />,
  );
  mounted.push(r);
  return r;
}

describe('the account menu and Bedrock accounts', () => {
  it('lists a Bedrock account only for a chat on its host, with its monthly spend', () => {
    const r = render('h1');
    expect(textOf(findHost(r.root, byTestId('account-option-b1')))).toContain(
      '$18.42 of $100 this month · estimated',
    );
    expect(queryHost(r.root, byTestId('account-option-b2'))).toBeNull();
    // A signed-out profile is not offered, like any account that is not connected.
    expect(queryHost(r.root, byTestId('account-option-b3'))).toBeNull();
  });

  it('lists none for a chat whose host is not known yet', () => {
    const r = render(null);
    expect(queryHost(r.root, byTestId('account-option-b1'))).toBeNull();
    expect(queryHost(r.root, byTestId('account-option-b2'))).toBeNull();
  });

  it('never asks a host to read a Bedrock account’s usage', () => {
    render('h1');
    expect(send).not.toHaveBeenCalled();
  });
});
