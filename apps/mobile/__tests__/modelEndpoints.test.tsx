// Settings → Providers on mobile: model endpoints (spec/02 § Provider adapters).
// A local model server or router, run inside Codex or Claude Code. The list is a
// shared setting written through the settings store; a key goes on its own
// write-only route and never into the settings.

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
import { usePresenceStore } from '../src/stores/presenceStore';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  ApiError: class extends Error {},
  api: { listSecrets: vi.fn(), setEndpointKey: vi.fn() },
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

describe('mobile Settings → Providers → Model endpoints', () => {
  it('adds a Claude Code endpoint, then sends its key separately', async () => {
    seedSettings();
    usePresenceStore.setState({ connection: 'connected' });
    const update = vi.spyOn(useSettingsStore.getState(), 'updatePreferences').mockResolvedValue();
    vi.mocked(api.setEndpointKey).mockResolvedValue(useSettingsStore.getState().data!.shared!);
    const r = await open();
    await actAsync(() => findHost(r.root, byTestId('model-endpoint-add')).props.onPress());
    expect(findHost(r.root, byTestId('model-endpoint-new-save')).props.disabled).toBe(true);
    await actAsync(() => {
      findHost(r.root, byTestId('model-endpoint-new-label')).props.onChangeText('LiteLLM');
      findHost(r.root, byTestId('model-endpoint-new-api-anthropic')).props.onPress();
      findHost(r.root, byTestId('model-endpoint-new-url')).props.onChangeText(` ${URL_} `);
      findHost(r.root, byTestId('model-endpoint-new-key')).props.onChangeText('sk-1234');
    });
    await actAsync(() => findHost(r.root, byTestId('model-endpoint-new-save')).props.onPress());
    await flush();
    expect(update).toHaveBeenCalledWith({
      modelEndpoints: [{ id: 'litellm', label: 'LiteLLM', api: 'anthropic', baseUrl: URL_ }],
    });
    expect(api.setEndpointKey).toHaveBeenCalledWith('litellm', 'sk-1234');
  });

  it('lists a saved endpoint with where it runs and whether it has a key', async () => {
    const data = seedSettings();
    useSettingsStore.setState({
      data: {
        ...data,
        preferences: {
          ...data.preferences,
          modelEndpoints: [{ id: 'ollama', label: 'Ollama', api: 'openai', baseUrl: URL_ }],
        },
      },
    });
    const r = await open();
    const row = textOf(findHost(r.root, byTestId('model-endpoint-ollama')));
    expect(row).toContain('runs in Codex');
    expect(row).toContain('No key');
    expect(queryHost(r.root, byTestId('local-model-endpoint'))).toBeNull();
  });
});
