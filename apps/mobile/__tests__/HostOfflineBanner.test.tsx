// Render coverage for the app-level daemon-offline banner (spec/12 §
// Daemon-offline UX; spec/15 § Offline / error states). Distinct from the WS
// OfflineBanner — this one is keyed on host presence, not the WS link, and
// taps through to Settings → Machines.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderRN, findHost, byTestId } from './testUtils/render';
import { useUiStore } from '../src/stores/uiStore';
import { HostOfflineBanner } from '../src/components/HostOfflineBanner';
import { usePresenceStore } from '../src/stores/presenceStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';

afterEach(() => {
  usePresenceStore.setState({ daemon: 'unknown' });
  __resetRouterMock();
});

describe('HostOfflineBanner — quiet states render nothing', () => {
  it('renders nothing while host presence is unknown', () => {
    usePresenceStore.setState({ daemon: 'unknown' });
    const r = renderRN(<HostOfflineBanner />);
    expect(r.toJSON()).toBeNull();
  });

  it('renders nothing while the host is online', () => {
    usePresenceStore.setState({ daemon: 'online' });
    const r = renderRN(<HostOfflineBanner />);
    expect(r.toJSON()).toBeNull();
  });
});

describe('HostOfflineBanner — host offline', () => {
  it('renders the self-explaining banner text and taps through to Settings → Machines', () => {
    usePresenceStore.setState({ daemon: 'offline' });
    const r = renderRN(<HostOfflineBanner />);
    const banner = findHost(r.root, byTestId('daemon-offline-banner'));
    expect(banner.props.accessibilityLabel).toBe(
      'Machine offline — open Settings to see the machine status',
    );
    banner.props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/settings');
  });

  // spec/12 § Connection diagnostics screen: the banner offers Diagnose, and
  // the app behind it stays navigable — the screen is an overlay, not a block.
  it('Diagnose opens the connection diagnostics screen', () => {
    useUiStore.setState({ diagnosticsOpen: false });
    usePresenceStore.setState({ daemon: 'offline' });
    const r = renderRN(<HostOfflineBanner />);
    findHost(r.root, byTestId('daemon-offline-diagnose')).props.onPress();
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.setState({ diagnosticsOpen: false });
  });
});
