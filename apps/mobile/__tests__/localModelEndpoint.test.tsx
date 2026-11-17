// Settings → Providers on mobile: the local model endpoint (docs/providers.md).
// One OpenAI-compatible base URL, a shared setting written through the
// settings store; the row says whether it is set, Save needs a change, and
// Clear sends an empty value.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  renderRN,
  byTestId,
  findHost,
  queryHost,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { ProvidersPage } from '../src/components/settings/HostsSection';
import { useSettingsStore } from '../src/stores/settingsStore';
import { api } from '../src/api/rest';
import { resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  ApiError: class extends Error {},
  api: { listSecrets: vi.fn() },
}));

const URL_ = 'http://127.0.0.1:11434/v1';
const mounted: ReactTestRenderer[] = [];
async function open(): Promise<ReactTestRenderer> {
  const r = renderRN(<ProvidersPage />);
  mounted.push(r);
  await flush();
  return r;
}
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  resetHosts();
  vi.mocked(api.listSecrets).mockResolvedValue({ secrets: [] });
});

describe('mobile Settings → Providers → Local model', () => {
  it('says not set, needs a change to save, and writes the trimmed URL', async () => {
    seedSettings();
    const update = vi.spyOn(useSettingsStore.getState(), 'updatePreferences').mockResolvedValue();
    const r = await open();
    expect(textOf(findHost(r.root, byTestId('local-model-endpoint-row')))).toContain('Not set');
    expect(queryHost(r.root, byTestId('local-model-endpoint-clear'))).toBeNull();
    expect(findHost(r.root, byTestId('local-model-endpoint-save')).props.disabled).toBe(true);

    await actAsync(() =>
      findHost(r.root, byTestId('local-model-endpoint')).props.onChangeText(`  ${URL_} `),
    );
    expect(findHost(r.root, byTestId('local-model-endpoint-save')).props.disabled).toBe(false);
    await actAsync(() => {
      findHost(r.root, byTestId('local-model-endpoint-save')).props.onPress();
    });
    expect(update).toHaveBeenCalledWith({ localModelBaseUrl: URL_ });
  });

  it('shows a saved endpoint and clears it with an empty value', async () => {
    const data = seedSettings();
    useSettingsStore.setState({
      data: { ...data, preferences: { ...data.preferences, localModelBaseUrl: URL_ } },
    });
    const update = vi.spyOn(useSettingsStore.getState(), 'updatePreferences').mockResolvedValue();
    const r = await open();
    expect(findHost(r.root, byTestId('local-model-endpoint')).props.value).toBe(URL_);
    expect(textOf(findHost(r.root, byTestId('local-model-endpoint-row')))).toContain('Set');
    await actAsync(() => {
      findHost(r.root, byTestId('local-model-endpoint-clear')).props.onPress();
    });
    expect(update).toHaveBeenCalledWith({ localModelBaseUrl: '' });
  });
});
