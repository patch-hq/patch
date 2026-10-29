// HostOfflineBanner — per-chat banner shown when the server WS is up but
// the host is offline.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HostOfflineBanner } from '../components/HostOfflineBanner.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

describe('HostOfflineBanner', () => {
  beforeEach(() => {
    usePresenceStore.setState({ connection: 'offline', hostOnline: false, hostsSeeded: true });
  });

  it('renders nothing when the WS connection is not connected, even if the host is offline', () => {
    usePresenceStore.setState({ connection: 'reconnecting', hostOnline: false });
    const { container } = render(<HostOfflineBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('daemon-offline-banner')).toBeNull();
  });

  it('renders nothing before the auth.ok greeting has said whether any agent is online', () => {
    usePresenceStore.setState({ connection: 'connected', hostOnline: false, hostsSeeded: false });
    const { container } = render(<HostOfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when connected and the host is online', () => {
    usePresenceStore.setState({ connection: 'connected', hostOnline: true });
    const { container } = render(<HostOfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the banner when connected but the host is offline', () => {
    usePresenceStore.setState({ connection: 'connected', hostOnline: false });
    render(<HostOfflineBanner />);
    expect(screen.getByTestId('daemon-offline-banner')).toHaveTextContent(
      'Agent offline. Messages are queued and sent when it reconnects.',
    );
  });

  // spec/12 § Connection diagnostics screen: the banner offers Diagnose, and
  // the app behind it stays navigable — the screen is an overlay, not a block.
  it('Diagnose opens the connection diagnostics screen', () => {
    useUiStore.setState({ diagnosticsOpen: false });
    usePresenceStore.setState({ connection: 'connected', hostOnline: false });
    render(<HostOfflineBanner />);
    fireEvent.click(screen.getByTestId('daemon-offline-diagnose'));
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.setState({ diagnosticsOpen: false });
  });

  // One host down while another is up: the app-level banner stays quiet (an
  // agent IS online) but a chat on the down host must say its host is down.
  describe('scoped to one host', () => {
    const host = (hostId: string, online: boolean, hostName: string) => ({
      hostId,
      online,
      lastSeenAt: null,
      host: { hostName } as never,
      accounts: {},
    });
    beforeEach(() => {
      usePresenceStore.setState({
        connection: 'connected',
        hostsSeeded: true,
        hostOnline: true,
        hosts: { a: host('a', true, 'mac') as never, b: host('b', false, 'hetzner') as never },
      });
    });

    it('names the offline host and says messages are queued', () => {
      render(<HostOfflineBanner hostId="b" />);
      const banner = screen.getByTestId('daemon-offline-banner');
      expect(banner).toHaveTextContent('hetzner is offline');
      expect(banner).toHaveTextContent('queued');
    });

    it('says why the host dropped off when the server could tell', () => {
      usePresenceStore.getState().setHostOnline('b', false, 'asleep');
      render(<HostOfflineBanner hostId="b" />);
      expect(screen.getByTestId('daemon-offline-banner')).toHaveTextContent(
        'hetzner went to sleep',
      );
    });

    it('uses the registry name when the offline host has not reported one', () => {
      usePresenceStore.setState({
        hosts: {
          a: host('a', true, 'mac') as never,
          b: {
            hostId: 'b',
            online: false,
            lastSeenAt: null,
            host: null,
            registeredName: 'hetzner',
            accounts: {},
          } as never,
        },
      });
      render(<HostOfflineBanner hostId="b" />);
      expect(screen.getByTestId('daemon-offline-banner')).toHaveTextContent('hetzner is offline');
    });

    it('renders nothing when that host is online, even if another is down', () => {
      const { container } = render(<HostOfflineBanner hostId="a" />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing app-wide while some host is still online', () => {
      const { container } = render(<HostOfflineBanner />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('says the machine is installing an update, without Diagnose, when it went down to install an update', () => {
    usePresenceStore.setState({ connection: 'connected', hostOnline: false, hosts: {} });
    usePresenceStore.getState().setHostOnline('d1', false, 'updating');
    render(<HostOfflineBanner />);
    expect(screen.getByTestId('daemon-offline-banner')).toHaveTextContent(
      'd1 is installing an update.',
    );
    expect(screen.queryByTestId('daemon-offline-diagnose')).toBeNull();
  });

  it('drops the restarting reason once the host is back', () => {
    usePresenceStore.setState({ hosts: {} });
    usePresenceStore.getState().setHostOnline('d1', false, 'updating');
    usePresenceStore.getState().setHostOnline('d1', true);
    expect(usePresenceStore.getState().hosts.d1?.offlineReason).toBeUndefined();
  });
});
