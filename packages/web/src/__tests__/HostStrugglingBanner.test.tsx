// HostStrugglingBanner — per-chat banner for a host that is online but coping badly.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HostConditionEvent } from '@patch/wire';
import { HostStrugglingBanner } from '../components/HostStrugglingBanner.js';
import { usePresenceStore } from '../stores/presenceStore.js';

const GB = 1024 ** 3;
const condition = (over: Partial<HostConditionEvent> = {}): HostConditionEvent => ({
  type: 'host.condition',
  hostId: 'h1',
  state: 'struggling',
  critical: false,
  reasons: ['memory'],
  topProcesses: [{ name: 'vitest', count: 5, rssBytes: 11 * GB }],
  ...over,
});

describe('HostStrugglingBanner', () => {
  beforeEach(() => {
    usePresenceStore.setState({
      hosts: {
        h1: {
          hostId: 'h1',
          online: true,
          lastSeenAt: null,
          host: null,
          registeredName: 'Netcup',
          accounts: {},
          claudeSettings: null,
          folders: null,
        },
      },
    });
  });

  it('renders nothing while the host is coping', () => {
    const { container } = render(<HostStrugglingBanner hostId="h1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the host, the cause and the biggest processes', () => {
    usePresenceStore.getState().setHostCondition(condition());
    render(<HostStrugglingBanner hostId="h1" />);
    expect(screen.getByTestId('host-struggling-banner')).toHaveTextContent(
      'Netcup is low on memory — chats may be slow (5 vitest, 11 GB)',
    );
  });

  it('says new turns are on hold when critical', () => {
    usePresenceStore.getState().setHostCondition(condition({ critical: true, topProcesses: [] }));
    render(<HostStrugglingBanner hostId="h1" />);
    expect(screen.getByTestId('host-struggling-banner')).toHaveTextContent(
      'Netcup is low on memory — new turns are on hold',
    );
  });

  it('goes away when the host recovers or drops offline', () => {
    const s = usePresenceStore.getState();
    s.setHostCondition(condition());
    s.setHostCondition(condition({ state: 'online', reasons: [], topProcesses: [] }));
    expect(usePresenceStore.getState().hosts.h1?.condition).toBeNull();
    s.setHostCondition(condition());
    s.setHostOnline('h1', false);
    expect(usePresenceStore.getState().hosts.h1?.condition).toBeNull();
  });
});
