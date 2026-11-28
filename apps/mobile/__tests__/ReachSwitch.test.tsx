// The reach switch in the Manager's top bar (spec/15 § Voice tab (Manager),
// spec/09 § Reaching the user): the account-wide `reach`, flipped in one tap,
// the same as web's pill.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, byTestId, textOf, actAsync, flush } from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { useSettingsStore } from '../src/stores/settingsStore';
import { seedSettings, settingsFixture } from './testUtils/settingsFixtures';
import { ReachSwitch } from '../src/components/ReachSwitch';

vi.mock('../src/api/rest', () => ({ api: { setPreferences: vi.fn() } }));

beforeEach(() => {
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  __clearLastAlert();
  useSettingsStore.getState()._reset();
});

const sw = (r: ReturnType<typeof renderRN>) => findHost(r.root, byTestId('reach-switch'));

describe('ReachSwitch', () => {
  it('is dead until the server has said which reach the account has', () => {
    const r = renderRN(<ReachSwitch />);
    expect(sw(r).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('shows Notify, and a tap writes auto-notify; tapped again it writes notify', async () => {
    seedSettings();
    const r = renderRN(<ReachSwitch />);
    expect(textOf(sw(r))).toBe('Notify');
    expect(sw(r).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
    await actAsync(async () => {
      sw(r).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ reach: 'auto-notify' });
    expect(textOf(sw(r))).toBe('Auto-notify');
    await actAsync(async () => {
      sw(r).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({ reach: 'notify' });
    expect(textOf(sw(r))).toBe('Notify');
  });

  it('follows a change made on another surface', async () => {
    const data = seedSettings();
    const r = renderRN(<ReachSwitch />);
    await actAsync(() =>
      useSettingsStore.getState().applyShared({
        ...data.shared!,
        version: 2,
        settings: { ...data.preferences, reach: 'auto-notify' },
      }),
    );
    expect(textOf(sw(r))).toBe('Auto-notify');
  });

  it('a refused write is said and the switch keeps what the server holds', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 503'));
    seedSettings();
    const r = renderRN(<ReachSwitch />);
    await actAsync(async () => {
      sw(r).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toMatchObject({ title: 'Settings failed', message: 'HTTP 503' });
    expect(textOf(sw(r))).toBe('Notify');
  });
});
