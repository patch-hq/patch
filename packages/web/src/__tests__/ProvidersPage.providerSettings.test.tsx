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
});
