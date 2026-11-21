// Settings → Providers on mobile: a provider's own settings (spec/10 § Settings).
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
import { usePresenceStore } from '../src/stores/presenceStore';
import { api } from '../src/api/rest';
import { reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  ApiError: class extends Error {},
  api: { listSecrets: vi.fn() },
}));

const ROW = 'provider-setting-claude-cleanupPeriodDays';
const mounted: ReactTestRenderer[] = [];
async function open(): Promise<ReactTestRenderer> {
  const r = renderRN(<ProvidersPage />);
  mounted.push(r);
  await flush();
  return r;
}
function chose(days: number): void {
  const data = seedSettings();
  useSettingsStore.setState({
    data: {
      ...data,
      preferences: {
        ...data.preferences,
        providerSettings: { claude: { cleanupPeriodDays: days } },
      },
    },
  });
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
  usePresenceStore.setState({ connection: 'connected' });
});

describe('mobile Settings → Providers → Claude settings', () => {
  it('shows Claude’s default when nothing is chosen', async () => {
    seedSettings();
    const r = await open();
    expect(findHost(r.root, byTestId(`${ROW}-input`)).props.value).toBe('30');
    expect(textOf(findHost(r.root, byTestId(ROW)))).toContain('own default');
  });

  it('shows what a host’s own settings.json holds, and the chosen value over it', async () => {
    seedSettings();
    reportHost('h1');
    usePresenceStore.getState().setClaudeSettings('h1', '{"cleanupPeriodDays": 365}', []);
    let r = await open();
    expect(findHost(r.root, byTestId(`${ROW}-input`)).props.value).toBe('365');
    expect(textOf(findHost(r.root, byTestId(ROW)))).toContain('own settings.json');
    chose(14);
    await actAsync(() => {});
    expect(findHost(r.root, byTestId(`${ROW}-input`)).props.value).toBe('14');
  });

  it('says so when a host file cannot be read', async () => {
    seedSettings();
    reportHost('h1');
    usePresenceStore.getState().setClaudeSettings('h1', '{broken', []);
    const r = await open();
    expect(textOf(findHost(r.root, byTestId(ROW)))).toContain('not valid JSON');
  });

  it('saves only a valid whole number in range that changes the value', async () => {
    seedSettings();
    const update = vi.spyOn(useSettingsStore.getState(), 'updatePreferences').mockResolvedValue();
    const r = await open();
    const save = (): ReturnType<typeof findHost> => findHost(r.root, byTestId(`${ROW}-save`));
    expect(save().props.disabled).toBe(true);
    for (const bad of ['0', '2.5', '4000', '']) {
      await actAsync(() => findHost(r.root, byTestId(`${ROW}-input`)).props.onChangeText(bad));
      expect(save().props.disabled).toBe(true);
    }
    await actAsync(() => findHost(r.root, byTestId(`${ROW}-input`)).props.onChangeText('90'));
    expect(save().props.disabled).toBe(false);
    await actAsync(() => {
      save().props.onPress();
    });
    expect(update).toHaveBeenCalledWith({
      providerSettings: { claude: { cleanupPeriodDays: 90 } },
    });
    // Codex has no session setting to offer: its group says so instead of
    // drawing rows (spec/10 § Settings).
    expect(queryHost(r.root, byTestId('provider-settings-note-codex'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('provider-settings-codex-cleanupPeriodDays'))).toBeNull();
  });

  it('shows Codex’s prompt-history switch and size, and Gemini CLI’s session retention, each saving its own number', async () => {
    seedSettings();
    const update = vi.spyOn(useSettingsStore.getState(), 'updatePreferences').mockResolvedValue();
    const r = await open();
    const keep = findHost(r.root, byTestId('provider-setting-codex-history.persistence-input'));
    expect(keep.props.value).toBe(true);
    await actAsync(() => {
      keep.props.onValueChange(false);
    });
    expect(update).toHaveBeenCalledWith({
      providerSettings: { codex: { 'history.persistence': 0 } },
    });
    const size = findHost(r.root, byTestId('provider-setting-codex-history.max_bytes-input'));
    expect(size.props.placeholder).toBe('No limit');
    const age = 'provider-setting-acp:gemini-general.sessionRetention.maxAge';
    expect(findHost(r.root, byTestId(`${age}-input`)).props.value).toBe('30');
    await actAsync(() => findHost(r.root, byTestId(`${age}-input`)).props.onChangeText('7'));
    await actAsync(() => {
      findHost(r.root, byTestId(`${age}-save`)).props.onPress();
    });
    expect(update).toHaveBeenLastCalledWith({
      providerSettings: { 'acp:gemini': { 'general.sessionRetention.maxAge': 7 } },
    });
  });
});
