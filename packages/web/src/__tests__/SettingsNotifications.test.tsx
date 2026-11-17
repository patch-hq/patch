// Settings → Notifications (spec/14 § Notifications) and the per-computer
// presence line in Devices (spec/09 § Presence heuristic): `Send to my phone
// after` is an account-wide setting; the idle-detection grant is a button
// because the browser asks only on a user gesture.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import { __resetIdleDetection } from '../lib/inputPresence.js';
import { presenceLine } from '../routes/settings/DevicesPage.js';
import {
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';
import { loadShared } from './sharedHelpers.js';

class FakeDetector {
  static permission: 'granted' | 'denied' = 'granted';
  userState = 'active';
  screenState = 'unlocked';
  static async requestPermission() {
    return FakeDetector.permission;
  }
  addEventListener() {}
  async start() {}
}

function browserWith(state: 'granted' | 'prompt' | 'denied' | null): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  if (state === null) {
    delete (window as unknown as { IdleDetector?: unknown }).IdleDetector;
    return;
  }
  (window as unknown as { IdleDetector: unknown }).IdleDetector = FakeDetector;
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state }) },
  });
}

beforeEach(() => {
  resetSettingsState();
  __resetIdleDetection();
  vi.stubGlobal('fetch', makeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
  delete (window as unknown as { IdleDetector?: unknown }).IdleDetector;
  delete (window as unknown as { patch?: unknown }).patch;
  __resetIdleDetection();
});

describe('Settings → Notifications → Send to my phone after', () => {
  it('shows the account setting, defaulting to 1 minute', () => {
    browserWith(null);
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    expect(screen.getByTestId('send-to-phone-after-pills-1m')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('send-to-phone-after-pills-1m')).toHaveTextContent('1 minute');
    expect(screen.getByTestId('send-to-phone-after-pills-5m')).toHaveTextContent('5 minutes');
    expect(screen.getByTestId('send-to-phone-after-pills-lock')).toHaveTextContent(
      'Only when I lock',
    );
  });

  it('writes the choice as a shared setting', async () => {
    browserWith(null);
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared({ settings: { sendToPhoneAfter: '1m' } });
    renderSettings('/settings/notifications');
    fireEvent.click(screen.getByTestId('send-to-phone-after-pills-lock'));
    await waitFor(() => expect(server.writes).toContainEqual({ sendToPhoneAfter: 'lock' }));
    fireEvent.click(screen.getByTestId('send-to-phone-after-pills-5m'));
    await waitFor(() => expect(server.writes).toContainEqual({ sendToPhoneAfter: '5m' }));
  });
});

describe('Settings → Notifications → idle detection', () => {
  it('offers a button where the browser supports it and has not been asked', async () => {
    browserWith('prompt');
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    const button = await screen.findByTestId('idle-detection-grant');
    expect(button).toBeEnabled();
    FakeDetector.permission = 'granted';
    fireEvent.click(button);
    await screen.findByTestId('idle-detection-granted');
    expect(screen.queryByTestId('idle-detection-grant')).toBeNull();
  });

  it('reads as granted when it already is', async () => {
    browserWith('granted');
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    expect(await screen.findByTestId('idle-detection-granted')).toBeInTheDocument();
  });

  it('says so when the browser has blocked it', async () => {
    browserWith('denied');
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    const button = await screen.findByTestId('idle-detection-grant');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Blocked in browser');
  });

  it('is not offered in a browser without idle detection', async () => {
    browserWith(null);
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    await screen.findByTestId('send-to-phone-after');
    expect(screen.queryByTestId('idle-detection')).toBeNull();
  });

  it('is never offered in the desktop app', async () => {
    browserWith('prompt');
    (window as unknown as { patch: unknown }).patch = { getSystemPresence: async () => ({}) };
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    await screen.findByTestId('send-to-phone-after');
    expect(screen.queryByTestId('idle-detection')).toBeNull();
  });
});

describe('Settings → Devices → computer presence', () => {
  it('says what each state is in words', () => {
    expect(presenceLine({ state: 'active', idleMs: 4000 })).toBe('Active, last input 4s ago');
    expect(presenceLine({ state: 'active', idleMs: 125_000 })).toBe('Active, last input 2m ago');
    expect(presenceLine({ state: 'idle', idleMs: 90_000 })).toBe('Away: idle, last input 1m ago');
    expect(presenceLine({ state: 'away', away: 'locked' })).toBe('Away: screen locked');
    expect(presenceLine({ state: 'away', away: 'asleep' })).toBe('Away: asleep');
    expect(presenceLine({ state: 'not-reporting' })).toBe('Not reporting');
  });

  it('shows the line on a computer and none on a phone', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        devices: [
          {
            surfaceId: 'mac',
            surfaceKind: 'desktop',
            label: 'Mac',
            issuedAt: 1,
            status: 'online',
            lastHeartbeat: 1,
            isCurrent: false,
            presence: { state: 'away', away: 'locked' },
          },
          {
            surfaceId: 'tab',
            surfaceKind: 'web',
            label: 'Tab',
            issuedAt: 1,
            status: 'online',
            lastHeartbeat: 1,
            isCurrent: true,
            presence: { state: 'not-reporting' },
          },
          {
            surfaceId: 'pixel',
            surfaceKind: 'mobile',
            label: 'Pixel',
            issuedAt: 1,
            status: 'online',
            lastHeartbeat: 1,
            isCurrent: false,
          },
        ],
      }),
    );
    renderSettings('/settings/devices');
    expect(await screen.findByTestId('device-mac')).toHaveTextContent('Away: screen locked');
    expect(screen.getByTestId('device-tab')).toHaveTextContent('Not reporting');
    expect(screen.getByTestId('device-pixel')).not.toHaveTextContent(/Active|Away|Not reporting/);
  });
});

describe('Settings → Notifications → devices', () => {
  function setup(levels: Record<string, 'all' | 'urgent' | 'off'> = {}) {
    browserWith(null);
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared({ settings: { deviceNotifications: levels } });
    renderSettings('/settings/notifications');
    return server;
  }

  it('lists every phone and computer with its level, defaulting to All', async () => {
    setup({ 'mob-7': 'urgent' });
    const own = await screen.findByTestId('notifications-level-web-dev-1-all');
    expect(own).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('notifications-device-web-dev-1')).toHaveTextContent('This device');
    expect(screen.getByTestId('notifications-level-mob-7-urgent')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('notifications-device-mob-7')).toHaveTextContent('Android');
  });

  it("changing one device's level writes the map, keeping the others", async () => {
    const server = setup({ 'mob-7': 'urgent' });
    fireEvent.click(await screen.findByTestId('notifications-level-web-dev-1-off'));
    await waitFor(() =>
      expect(server.writes).toContainEqual({
        deviceNotifications: { 'mob-7': 'urgent', 'web-dev-1': 'off' },
      }),
    );
  });

  it('the master switch is all devices: off sets every device off, on sets them all to All', async () => {
    const server = setup({});
    const master = await screen.findByTestId('notifications-master-toggle');
    await waitFor(() => expect(master).toBeChecked());
    fireEvent.click(master);
    await waitFor(() =>
      expect(server.writes).toContainEqual({
        deviceNotifications: { 'web-dev-1': 'off', 'mob-7': 'off' },
      }),
    );
    await waitFor(() => expect(master).not.toBeChecked());
    expect(screen.getByTestId('notifications-master')).toHaveTextContent('bell');
    fireEvent.click(master);
    await waitFor(() =>
      expect(server.writes).toContainEqual({
        deviceNotifications: { 'web-dev-1': 'all', 'mob-7': 'all' },
      }),
    );
  });

  it('says so beside the switch when the browser has blocked notifications', async () => {
    browserWith(null);
    vi.stubGlobal('Notification', { permission: 'denied' });
    loadShared({ settings: {} });
    renderSettings('/settings/notifications');
    expect(await screen.findByTestId('notifications-os-blocked')).toHaveTextContent('Blocked');
  });
});
