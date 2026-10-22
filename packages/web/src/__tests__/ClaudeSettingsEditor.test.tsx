// Settings → Providers → Claude Code settings.json: that host's own file, shown
// as the machine holds it and replaced by a Save that goes to that host
// (spec/02 § Claude Code settings). No shared text, no OS override, no drift,
// no keep / discard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportClaudeSettings, reportHost } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import { fakeWs, makeFetch, renderSettings, resetSettingsState } from './settingsHarness.js';

const ID = 'host-d1-claude-settings';

async function openPage(settingsJson: string | null): Promise<void> {
  reportHost('d1', { hostName: 'mac' });
  if (settingsJson !== null) reportClaudeSettings('d1', [], settingsJson);
  renderSettings('/settings/providers');
  await waitFor(() => expect(screen.getByTestId('settings-providers')).toBeInTheDocument());
}

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
  vi.stubGlobal('fetch', makeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings → Providers — settings.json', () => {
  it('sits on the Providers page, not Hosts or Agent, and offers no keep or discard', async () => {
    await openPage('{"model":"opus"}');
    expect(screen.getByTestId(ID)).toHaveTextContent('mac');
    expect(screen.getByTestId(ID)).toHaveTextContent('Set');
    expect(screen.queryByText(/Keep for/)).toBeNull();
    expect(screen.queryByText('Discard')).toBeNull();
    expect(screen.queryByTestId('claude-settings-shared-edit')).toBeNull();
  });

  it('says the host has not reported rather than showing an empty file', async () => {
    await openPage(null);
    expect(screen.getByTestId(`${ID}-edit`)).toBeDisabled();
    expect(screen.getByTestId(ID)).toHaveTextContent('Not reported yet');
  });

  it('opens with the host’s text and sends an edit to that host', async () => {
    const { sent } = fakeWs();
    await openPage('{"model":"opus"}');
    fireEvent.click(screen.getByTestId(`${ID}-edit`));
    const box = screen.getByTestId(`${ID}-json`) as HTMLTextAreaElement;
    expect(box.value).toBe('{"model":"opus"}');
    // Nothing to save until it changes.
    expect(screen.getByTestId(`${ID}-save`)).toBeDisabled();
    fireEvent.change(box, { target: { value: '{"model":"haiku"}' } });
    fireEvent.click(screen.getByTestId(`${ID}-save`));
    expect(sent).toEqual([
      { type: 'host.claude_settings_set', hostId: 'd1', text: '{"model":"haiku"}' },
    ]);
  });

  it('stays open with the text until the host reports the file changed', async () => {
    fakeWs();
    await openPage('{"model":"opus"}');
    fireEvent.click(screen.getByTestId(`${ID}-edit`));
    fireEvent.change(screen.getByTestId(`${ID}-json`), { target: { value: '[1]' } });
    fireEvent.click(screen.getByTestId(`${ID}-save`));
    // The host refuses (no report arrives): the draft is still there to fix.
    expect((screen.getByTestId(`${ID}-json`) as HTMLTextAreaElement).value).toBe('[1]');
    act(() => reportClaudeSettings('d1', [], '[1]'));
    await waitFor(() => expect(screen.queryByTestId(`${ID}-json`)).toBeNull());
    expect(screen.getByTestId(`${ID}-edit`)).toBeInTheDocument();
  });

  it('Cancel closes without sending', async () => {
    const { sent } = fakeWs();
    await openPage('{}');
    fireEvent.click(screen.getByTestId(`${ID}-edit`));
    fireEvent.change(screen.getByTestId(`${ID}-json`), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByTestId(`${ID}-cancel`));
    expect(screen.queryByTestId(`${ID}-json`)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('refuses to send to an offline host, naming it', async () => {
    fakeWs();
    await openPage('{}');
    act(() => usePresenceStore.getState().setHostOnline('d1', false));
    fireEvent.click(screen.getByTestId(`${ID}-edit`));
    fireEvent.change(screen.getByTestId(`${ID}-json`), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByTestId(`${ID}-save`));
    expect(screen.getByTestId(`${ID}-json`)).toBeInTheDocument();
  });
});
