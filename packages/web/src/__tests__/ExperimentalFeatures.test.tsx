// Settings → Experimental features: off by default, hides Manager and Batch
// everywhere until switched on, and writes the account-wide setting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { visibleSettingsPages } from '../routes/settings/pages.js';
import { resetSettingsState, makeFetch, renderSettings, json } from './settingsHarness.js';

describe('Experimental features — settings', () => {
  beforeEach(() => {
    resetSettingsState();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is off by default', () => {
    expect(DEFAULT_SHARED_SETTINGS.experimentalFeatures).toBe(false);
  });

  it('hides the Manager page from the nav while off, and shows it when on', () => {
    expect(visibleSettingsPages(false).map((p) => p.id)).not.toContain('manager');
    expect(visibleSettingsPages(true).map((p) => p.id)).toContain('manager');
    expect(visibleSettingsPages(false).map((p) => p.id)).toContain('experimental');
  });

  it('the page toggle writes experimentalFeatures through to the server', async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) => {
        if (u.includes('/api/settings') && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          patches.push(body);
          return json({ preferences: { ...DEFAULT_PREFERENCES, ...body } });
        }
        return null;
      }),
    );
    renderSettings('/settings/experimental');
    const toggle = await screen.findByTestId('experimental-features');
    fireEvent.click(toggle);
    await waitFor(() => expect(patches).toEqual([{ experimentalFeatures: true }]));
    expect(usePreferencesStore.getState().preferences.experimentalFeatures).toBe(true);
  });
});
