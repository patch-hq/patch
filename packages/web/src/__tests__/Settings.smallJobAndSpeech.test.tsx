// Settings → Chats → Models for small jobs, and Settings → Dictation → Hosts
// transcribe with: the shared `smallJobModels` and `speechBackend`.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatsPage } from '../routes/settings/ChatsPage.js';
import { DictationPage } from '../routes/settings/DictationPage.js';
import { useUiStore } from '../stores/uiStore.js';
import * as write from '../routes/settings/sharedWrite.js';
import { loadShared } from './sharedHelpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function chats(): HTMLInputElement {
  render(
    <MemoryRouter>
      <ChatsPage />
    </MemoryRouter>,
  );
  return screen.getByTestId('small-job-models-input') as HTMLInputElement;
}

describe('Settings → Chats → Models for small jobs', () => {
  it('shows the saved list in order and writes an edited one', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    loadShared({ settings: { smallJobModels: ['m1', 'm2'] } });
    const input = chats();
    expect(input.value).toBe('m1, m2');
    fireEvent.change(input, { target: { value: 'm2, m1, m3' } });
    fireEvent.blur(input);
    expect(spy).toHaveBeenCalledWith('small-job models', { smallJobModels: ['m2', 'm1', 'm3'] });
  });

  it('refuses an empty entry or a repeat, says why, and reverts', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
    loadShared({ settings: { smallJobModels: ['m1', 'm2'] } });
    const input = chats();
    fireEvent.change(input, { target: { value: 'm1, ' } });
    fireEvent.blur(input);
    expect(input.value).toBe('m1, m2');
    fireEvent.change(input, { target: { value: 'm1, m1' } });
    fireEvent.blur(input);
    expect(input.value).toBe('m1, m2');
    expect(spy).not.toHaveBeenCalled();
    expect(pushError).toHaveBeenCalledTimes(2);
  });

  it('does not write when nothing changed', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    loadShared({ settings: { smallJobModels: ['m1'] } });
    fireEvent.blur(chats());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Settings → Dictation → Hosts transcribe with', () => {
  it('marks the saved engine and writes the one chosen', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    loadShared({ settings: { speechBackend: 'groq' } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <DictationPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const group = screen.getByTestId('host-speech-backend');
    expect(group.querySelectorAll('button').length).toBe(6);
    fireEvent.click(screen.getByText('Parakeet'));
    expect(spy).toHaveBeenCalledWith('speech engine', { speechBackend: 'parakeet' });
  });
});
