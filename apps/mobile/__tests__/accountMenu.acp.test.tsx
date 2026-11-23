// The composer's account menu on a chat on an ACP agent (spec/10 § Choosing an
// account): the agent's own accounts, each with its state, so the chat can be
// locked to one — never another agent's or another provider's.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { renderRN, byTestId, findHost, queryHost, textOf } from './testUtils/render';
import { AccountMenu } from '../src/components/AccountMenu';
import { resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});
beforeEach(() => {
  resetHosts();
  seedSettings({
    shared: {
      version: 1,
      hosts: [],
      secrets: {
        claude: [{ id: 'c1', label: 'Claude', connected: true }],
        codex: [],
        providerKeys: [],
        acp: [
          { id: 'g1', agentId: 'gemini', label: 'Work', last4: '1111', state: { state: 'ready' } },
          {
            id: 'g2',
            agentId: 'gemini',
            label: 'Home',
            last4: '2222',
            state: { state: 'limited' },
          },
          { id: 'o1', agentId: 'other', label: 'Other', last4: '3333' },
        ],
      },
    },
  });
});

describe('the account menu on an ACP chat', () => {
  it('lists the agent’s own accounts with their state, and locks the chat to one', () => {
    const onSelect = vi.fn();
    const r = renderRN(
      <AccountMenu
        visible
        backendId="acp"
        model="acp/gemini/auto"
        hostId={null}
        selectedId="g1"
        strategySelected={false}
        onSelect={onSelect}
        onDismiss={() => undefined}
      />,
    );
    mounted.push(r);
    expect(queryHost(r.root, byTestId('account-option-g1'))).not.toBeNull();
    expect(textOf(findHost(r.root, byTestId('account-option-g2')))).toContain('Limited');
    expect(queryHost(r.root, byTestId('account-option-o1'))).toBeNull();
    expect(queryHost(r.root, byTestId('account-option-c1'))).toBeNull();
    act(() => findHost(r.root, byTestId('account-option-g2')).props['onPress']());
    expect(onSelect).toHaveBeenCalledWith('g2');
  });
});
