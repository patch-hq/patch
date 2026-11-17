// Settings → Notifications on the phone: every signed-in phone and computer with
// its own level, the master switch meaning "all devices", and this phone's own
// level driving its local push registration.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { NotificationsPage } from '../src/components/settings/NotificationsSection';
import { renderRN as renderBase, findHost, byTestId, actAsync, flush } from './testUtils/render';
import { api } from '../src/api/rest';
import { useSettingsStore } from '../src/stores/settingsStore';
import { seedSettings, settingsFixture } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  api: {
    settings: vi.fn(),
    setPreferences: vi.fn(),
    pushRegister: vi.fn(async () => undefined),
    pushUnregister: vi.fn(async () => undefined),
  },
}));

const device = (surfaceId: string, surfaceKind: string, label: string, isCurrent: boolean) => ({
  surfaceId,
  surfaceKind,
  label,
  issuedAt: 1,
  status: 'online' as const,
  lastHeartbeat: 1,
  isCurrent,
});
const DEVICES = [
  device('phone-1', 'mobile', 'Pixel', true),
  device('mac-1', 'desktop', 'Mac', false),
  device('term-1', 'terminal', 'Terminal', false),
];

const mounted: ReturnType<typeof renderBase>[] = [];
beforeEach(() => {
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  useSettingsStore.getState()._reset();
});
afterEach(() => {
  for (const r of mounted.splice(0)) act(() => r.unmount());
});
function render(el: React.ReactElement) {
  const r = renderBase(el);
  mounted.push(r);
  return r;
}

describe('Settings → Notifications (phone)', () => {
  it('lists phones and computers, not terminals, each defaulting to All', () => {
    seedSettings({ devices: DEVICES });
    const r = render(<NotificationsPage />);
    expect(
      findHost(r.root, byTestId('notifications-level-phone-1-all')).props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(findHost(r.root, byTestId('notifications-device-mac-1'))).toBeTruthy();
    expect(() => findHost(r.root, byTestId('notifications-device-term-1'))).toThrow();
  });

  it("changing one device's level writes the whole map", async () => {
    const data = seedSettings({ devices: DEVICES });
    data.preferences = { ...data.preferences, deviceNotifications: { 'mac-1': 'urgent' } };
    useSettingsStore.setState({ data });
    const r = render(<NotificationsPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('notifications-level-phone-1-off')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      deviceNotifications: { 'mac-1': 'urgent', 'phone-1': 'off' },
    });
  });

  it('the master switch sets every device off, and back to All', async () => {
    seedSettings({ devices: DEVICES });
    const r = render(<NotificationsPage />);
    expect(findHost(r.root, byTestId('notifications-master')).props.value).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byTestId('notifications-master')).props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      deviceNotifications: { 'phone-1': 'off', 'mac-1': 'off' },
    });
  });
});
