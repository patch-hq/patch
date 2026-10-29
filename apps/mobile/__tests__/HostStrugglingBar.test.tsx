// A host that is online but coping badly says so on its chats (twin of web's
// HostStrugglingBanner).

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderRN, queryHost, byTestId, textOf } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { HostStrugglingBar } from '../src/components/chatBars/HostStrugglingBar';

const GB = 1024 ** 3;

describe('HostStrugglingBar', () => {
  beforeEach(() => {
    usePresenceStore.setState({
      hosts: {
        h1: {
          hostId: 'h1',
          online: true,
          lastSeenAt: null,
          host: { hostName: 'Netcup' } as never,
          accounts: {},
        },
      },
    });
  });

  it('is empty while the host is coping', () => {
    const r = renderRN(<HostStrugglingBar hostId="h1" />);
    expect(queryHost(r.root, byTestId('host-struggling-bar'))).toBeNull();
  });

  it('names the host, the cause and the biggest processes, and clears on recovery', () => {
    const r = renderRN(<HostStrugglingBar hostId="h1" />);
    act(() => {
      usePresenceStore.getState().setHostCondition({
        type: 'host.condition',
        hostId: 'h1',
        state: 'struggling',
        critical: false,
        reasons: ['memory'],
        topProcesses: [{ name: 'vitest', count: 5, rssBytes: 11 * GB }],
      });
    });
    expect(textOf(queryHost(r.root, byTestId('host-struggling-bar'))!)).toContain(
      'Netcup is low on memory — chats may be slow (5 vitest, 11 GB)',
    );
    act(() => {
      usePresenceStore.getState().setHostOnline('h1', false);
    });
    expect(queryHost(r.root, byTestId('host-struggling-bar'))).toBeNull();
  });
});
