// This phone's own level in the synced map drives its local push switch.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const setNotificationsOff = vi.fn(async () => undefined);
let localOff = false;
vi.mock('../src/lib/push', () => ({ setNotificationsOff }));
vi.mock('../src/lib/notificationsMaster', () => ({ notificationsOff: () => localOff }));
vi.mock('../src/api/rest', () => ({ api: {} }));

beforeEach(() => {
  vi.resetModules();
  setNotificationsOff.mockClear();
  localOff = false;
});

async function setup() {
  const { useSettingsStore } = await import('../src/stores/settingsStore');
  const { startNotificationLevelSync } = await import('../src/lib/notificationLevelSync');
  const { settingsFixture } = await import('./testUtils/settingsFixtures');
  startNotificationLevelSync();
  const seed = (level?: 'all' | 'urgent' | 'off') => {
    const data = settingsFixture({
      devices: [
        {
          surfaceId: 'phone-1',
          surfaceKind: 'mobile',
          label: 'Pixel',
          issuedAt: 1,
          status: 'online',
          lastHeartbeat: 1,
          isCurrent: true,
        },
      ],
    });
    data.preferences = {
      ...data.preferences,
      deviceNotifications: level ? { 'phone-1': level } : {},
    };
    useSettingsStore.setState({ data, error: null });
  };
  return { seed };
}

describe('notification level sync', () => {
  it('an Off set from another device turns this phone off', async () => {
    const { seed } = await setup();
    seed('off');
    expect(setNotificationsOff).toHaveBeenCalledWith(true);
  });

  it('back from Off to a level turns it on again; Only urgent keeps it on', async () => {
    const { seed } = await setup();
    localOff = true;
    seed('urgent');
    expect(setNotificationsOff).toHaveBeenCalledWith(false);
  });

  it('does nothing when the local switch already agrees', async () => {
    const { seed } = await setup();
    seed();
    expect(setNotificationsOff).not.toHaveBeenCalled();
  });
});
