// OfflineBanner — amber 'Reconnecting…' banner shown whenever the WS
// connection is anything other than 'connected'.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CLOSE_SERVER_RESTARTING } from '@patch/wire';
import { OfflineBanner } from '../components/OfflineBanner.js';
import { SERVER_UPDATE_GRACE_MS, usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

describe('OfflineBanner', () => {
  beforeEach(() => {
    usePresenceStore.setState({
      connection: 'offline',
      everConnected: true,
      lastClose: null,
      serverUpdatingSince: null,
      serverStopReason: null,
    });
  });

  it('renders nothing when connected', () => {
    usePresenceStore.getState().setConnection('connected');
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('renders the banner when connecting after a connection was lost', () => {
    usePresenceStore.getState().setConnection('connecting');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Reconnecting…');
  });

  it.each(['connecting', 'reconnecting', 'offline'] as const)(
    'renders nothing while the first connection is still being made (%s)',
    (state) => {
      usePresenceStore.setState({ everConnected: false });
      usePresenceStore.getState().setConnection(state);
      const { container } = render(<OfflineBanner />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('renders the banner when reconnecting', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  it('renders the banner when offline', () => {
    usePresenceStore.getState().setConnection('offline');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  // spec/12 § Connection diagnostics screen: 'Reconnecting…' on its own is a
  // dead end — the banner must open the diagnostics screen.
  it('Diagnose opens the connection diagnostics screen', () => {
    useUiStore.setState({ diagnosticsOpen: false });
    usePresenceStore.getState().setConnection('reconnecting');
    render(<OfflineBanner />);
    fireEvent.click(screen.getByTestId('offline-diagnose'));
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.setState({ diagnosticsOpen: false });
  });

  it('explains a server restart instead of a bare "Reconnecting…"', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    usePresenceStore
      .getState()
      .noteWsClose({ code: CLOSE_SERVER_RESTARTING, reason: 'restarting', at: Date.now() });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent(
      'Patch server is restarting. Back in a moment.',
    );
    // A known gap: nothing to diagnose.
    expect(screen.queryByTestId('offline-diagnose')).toBeNull();
  });

  it('keeps saying it is updating through the failed retries while the server is down', () => {
    // Each retry against a server mid-restart fails with a bare 1006. Reading
    // only the latest close flipped this to "Reconnecting…" within a second.
    const at = Date.now();
    usePresenceStore.getState().setConnection('reconnecting');
    usePresenceStore
      .getState()
      .noteWsClose({ code: CLOSE_SERVER_RESTARTING, reason: 'updating', at });
    usePresenceStore.getState().noteWsClose({ code: 1006, reason: '', at: at + 1 });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent(
      'Patch server is installing an update. Back in a moment.',
    );
  });

  it('falls back to "Reconnecting…" if the server has not come back after the grace period', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    usePresenceStore.getState().noteWsClose({
      code: CLOSE_SERVER_RESTARTING,
      reason: '',
      at: Date.now() - SERVER_UPDATE_GRACE_MS - 1,
    });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Reconnecting…');
    expect(screen.getByTestId('offline-diagnose')).toBeInTheDocument();
  });

  it('forgets the update once the link is back', () => {
    usePresenceStore
      .getState()
      .noteWsClose({ code: CLOSE_SERVER_RESTARTING, reason: '', at: Date.now() });
    usePresenceStore.getState().noteWsOpen('ws://x');
    usePresenceStore.getState().noteWsClose({ code: 1006, reason: '', at: Date.now() });
    usePresenceStore.getState().setConnection('reconnecting');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Reconnecting…');
  });
});
