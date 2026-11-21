// Settings → Providers → a provider's own settings (spec/10 § Provider settings).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProviderOwnSettings } from '../routes/settings/ProvidersPage.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import * as write from '../routes/settings/sharedWrite.js';
import { reportClaudeSettings } from './presenceHelpers.js';

const ROW = 'provider-setting-claude-cleanupPeriodDays';

function load(chosen?: number): void {
  const prefs = usePreferencesStore.getState().preferences;
  usePreferencesStore.setState({
    loaded: true,
    preferences: {
      ...prefs,
      providerSettings: chosen === undefined ? {} : { claude: { cleanupPeriodDays: chosen } },
    },
  });
}

function show(): void {
  render(
    <MemoryRouter>
      <ProviderOwnSettings />
    </MemoryRouter>,
  );
}

describe("Settings → Providers → a provider's own settings", () => {
  beforeEach(() => {
    usePresenceStore.setState({ hosts: {} });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows Claude Code's own default when nothing is chosen and no host sets one", () => {
    load();
    show();
    expect((screen.getByTestId(`${ROW}-input`) as HTMLInputElement).value).toBe('30');
    expect(screen.getByTestId(ROW).textContent).toContain("Claude's own default");
  });

  it("shows what a host's own settings.json holds rather than Patch's default", () => {
    load();
    reportClaudeSettings('h1', [], '{"cleanupPeriodDays": 365}');
    show();
    expect((screen.getByTestId(`${ROW}-input`) as HTMLInputElement).value).toBe('365');
    expect(screen.getByTestId(ROW).textContent).toContain('own settings.json');
  });

  it('shows the chosen value over the host file', () => {
    load(14);
    reportClaudeSettings('h1', [], '{"cleanupPeriodDays": 365}');
    show();
    expect((screen.getByTestId(`${ROW}-input`) as HTMLInputElement).value).toBe('14');
  });

  it('says so when a host file cannot be read, instead of showing a default', () => {
    load();
    reportClaudeSettings('h1', [], '{broken');
    show();
    expect(screen.getByTestId(ROW).textContent).toContain('not valid JSON');
  });

  it('writes a whole number on commit, nothing on a partial keystroke or an unchanged value', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    load();
    show();
    const input = screen.getByTestId(`${ROW}-input`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('delete sessions after', {
      providerSettings: { claude: { cleanupPeriodDays: 90 } },
    });
  });

  it("shows Codex's prompt-history settings at Codex's own defaults, and a switch writes 0 or 1", () => {
    load();
    const patch = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    show();
    const keep = screen.getByTestId(
      'provider-setting-codex-history.persistence-input',
    ) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    expect(screen.getByTestId('provider-settings-note-codex').textContent).toMatch(
      /no setting to delete old sessions/,
    );
    const size = screen.getByTestId(
      'provider-setting-codex-history.max_bytes-input',
    ) as HTMLInputElement;
    expect(size.value).toBe('');
    expect(size.placeholder).toBe('No limit');
    fireEvent.click(keep);
    expect(patch).toHaveBeenCalledWith('keep prompt history', {
      providerSettings: { codex: { 'history.persistence': 0 } },
    });
  });

  it("shows Gemini CLI's own session retention under its agent, and saves a number of days", () => {
    load();
    const patch = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    show();
    expect(screen.getByTestId('provider-settings-acp:gemini').textContent).toContain(
      'Gemini CLI settings',
    );
    const age = screen.getByTestId(
      'provider-setting-acp:gemini-general.sessionRetention.maxAge-input',
    ) as HTMLInputElement;
    expect(age.value).toBe('30');
    fireEvent.change(age, { target: { value: '7' } });
    fireEvent.blur(age);
    expect(patch).toHaveBeenCalledWith('delete sessions after', {
      providerSettings: { 'acp:gemini': { 'general.sessionRetention.maxAge': 7 } },
    });
  });

  it('shows no group for an ACP agent that declares no settings of its own', () => {
    const prefs = usePreferencesStore.getState().preferences;
    usePreferencesStore.setState({
      loaded: true,
      preferences: {
        ...prefs,
        providerSettings: {},
        acpAgents: [{ id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--acp'] }],
      },
    });
    show();
    expect(screen.queryByTestId('provider-settings-acp:gemini')).toBeNull();
  });
});
