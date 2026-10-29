// Settings → Providers → Claude Code settings.json (spec/02 § Claude Code
// settings): the picked host's own file. The row says whether the machine has
// one; Edit opens it full screen; Save sends `host.claude_settings_set` to that
// host and the screen closes when the host's fresh snapshot shows the file
// changed — or shows the host's refusal, in its own words.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import {
  ClaudeSettingsEditor,
  ClaudeSettingsRow,
} from '../src/components/settings/ClaudeSettingsSection';
import { HostDetail, ProvidersPage } from '../src/components/settings/HostsSection';
import { CLAUDE_ACK_TIMEOUT_MS } from '../src/components/settings/accountRows';
import { renderRN, findHost, queryHost, byTestId, textOf, actAsync } from './testUtils/render';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useHostRefusalStore } from '../src/stores/hostRefusalStore';
import { pickHost, reportHost, resetHosts } from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));
vi.mock('../src/api/rest', () => ({
  api: {
    listSecrets: vi.fn(async () => ({ secrets: [] })),
    setPreferences: vi.fn(async () => ({ preferences: DEFAULT_SHARED_SETTINGS })),
  },
}));

let mounted: ReactTestRenderer[] = [];
function render(el: React.ReactElement): ReactTestRenderer {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}
const report = (json: string): void =>
  usePresenceStore.getState().setClaudeSettings('d1', json, []);

beforeEach(() => {
  send.mockReset();
  __resetRouterMock();
  useHostRefusalStore.getState()._reset();
  resetHosts();
  reportHost('d1', { hostName: 'laptop' });
  pickHost('d1');
});
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
  vi.useRealTimers();
});

describe('Machine page — settings.json row', () => {
  it('names the host and whether it has a file, and Edit opens the editor for that host', async () => {
    report('{"model":"opus"}');
    const r = render(<HostDetail hostId="d1" />);
    expect(textOf(findHost(r.root, byTestId('claude-json-summary')))).toBe('Set');
    await actAsync(() => findHost(r.root, byTestId('claude-json-edit')).props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/claude-json',
      params: { hostId: 'd1' },
    });
  });

  it('says None for an empty file, and holds Edit back until the host has reported', () => {
    report('');
    const r = render(<ClaudeSettingsRow host={usePresenceStore.getState().hosts['d1']!} />);
    expect(textOf(findHost(r.root, byTestId('claude-json-summary')))).toBe('None');
    usePresenceStore.getState().removeHost('d1');
    reportHost('d1', { hostName: 'laptop' });
    const r2 = render(<ClaudeSettingsRow host={usePresenceStore.getState().hosts['d1']!} />);
    expect(textOf(findHost(r2.root, byTestId('claude-json-summary')))).toBe('Not reported yet');
    expect(findHost(r2.root, byTestId('claude-json-edit')).props.disabled).toBe(true);
  });

  it('offers no keep or discard, and no shared or per-OS layers', () => {
    report('{}');
    const r = render(<HostDetail hostId="d1" />);
    expect(queryHost(r.root, byTestId('claude-json-keep'))).toBeNull();
    expect(queryHost(r.root, byTestId('host-d1-claude-drift'))).toBeNull();
  });
});

describe('settings.json editor', () => {
  it('opens with the host’s text and sends an edit to that host', async () => {
    usePresenceStore.getState().setHostOnline('d1', true);
    report('{"model":"opus"}');
    const r = render(<ClaudeSettingsEditor hostId="d1" />);
    expect(findHost(r.root, byTestId('claude-json-text')).props.value).toBe('{"model":"opus"}');
    expect(findHost(r.root, byTestId('claude-json-save')).props.disabled).toBe(true);
    await actAsync(() =>
      findHost(r.root, byTestId('claude-json-text')).props.onChangeText('{"model":"haiku"}'),
    );
    await actAsync(() => findHost(r.root, byTestId('claude-json-save')).props.onPress());
    expect(send).toHaveBeenCalledWith({
      type: 'host.claude_settings_set',
      hostId: 'd1',
      text: '{"model":"haiku"}',
    });
    expect(textOf(findHost(r.root, byTestId('claude-json-save')))).toBe('Saving…');
  });

  it('closes when the host reports the file changed', async () => {
    usePresenceStore.getState().setHostOnline('d1', true);
    report('{}');
    const r = render(<ClaudeSettingsEditor hostId="d1" />);
    await actAsync(() =>
      findHost(r.root, byTestId('claude-json-text')).props.onChangeText('{"a":1}'),
    );
    await actAsync(() => findHost(r.root, byTestId('claude-json-save')).props.onPress());
    expect(routerMock.back).not.toHaveBeenCalled();
    await actAsync(async () => report('{"a":1}'));
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('shows the host’s refusal in its own words and stays open', async () => {
    usePresenceStore.getState().setHostOnline('d1', true);
    report('{}');
    const r = render(<ClaudeSettingsEditor hostId="d1" />);
    await actAsync(() => findHost(r.root, byTestId('claude-json-text')).props.onChangeText('[1]'));
    await actAsync(() => findHost(r.root, byTestId('claude-json-save')).props.onPress());
    await actAsync(async () =>
      useHostRefusalStore
        .getState()
        .note(
          'claude_settings_invalid',
          'host.claude_settings_set: laptop — settings.json must be a JSON object',
        ),
    );
    expect(textOf(findHost(r.root, byTestId('claude-json-error')))).toContain(
      'must be a JSON object',
    );
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('says so when the host sends no answer, rather than failing', async () => {
    vi.useFakeTimers();
    usePresenceStore.getState().setHostOnline('d1', true);
    report('{}');
    const r = render(<ClaudeSettingsEditor hostId="d1" />);
    await actAsync(() =>
      findHost(r.root, byTestId('claude-json-text')).props.onChangeText('{"a":1}'),
    );
    await actAsync(() => findHost(r.root, byTestId('claude-json-save')).props.onPress());
    await actAsync(async () => {
      vi.advanceTimersByTime(CLAUDE_ACK_TIMEOUT_MS + 10);
    });
    expect(textOf(findHost(r.root, byTestId('claude-json-error')))).toContain('may still apply');
  });

  it('says the host has not reported rather than showing an empty file', () => {
    usePresenceStore.getState().removeHost('d1');
    const r = render(<ClaudeSettingsEditor hostId="d1" />);
    expect(queryHost(r.root, byTestId('claude-json-unreported'))).not.toBeNull();
  });
});

describe('Providers page', () => {
  it('is shared: no host switcher and no per-host settings.json', () => {
    const r = render(<ProvidersPage />);
    expect(queryHost(r.root, byTestId('host-switcher'))).toBeNull();
    expect(queryHost(r.root, byTestId('claude-json-edit'))).toBeNull();
  });
});
