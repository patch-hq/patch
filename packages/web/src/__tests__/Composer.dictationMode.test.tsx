// Dictation mode (spec/07 § Dictation mode): right-click the composer mic →
// Keep dictating, and it stays open; each finished utterance is sent as its
// own message.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import type { startDictationMode, DictationModeCallbacks } from '../lib/dictationMode.js';

describe('composer dictation mode', () => {
  let cb: DictationModeCallbacks;
  let stop: ReturnType<typeof vi.fn>;
  let factory: ReturnType<typeof vi.fn>;
  let ready: Promise<void>;

  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useUiStore.getState().clearToasts();
    stop = vi.fn();
    ready = Promise.resolve();
    factory = vi.fn((_deps, callbacks: DictationModeCallbacks) => {
      cb = callbacks;
      return { ready, stop };
    });
  });

  const mount = (onSend = vi.fn()) => {
    render(
      <Composer
        chatId="c1"
        hostId="d1"
        onSend={onSend}
        dictationModeFactory={factory as unknown as typeof startDictationMode}
      />,
    );
    return onSend;
  };
  const mic = () => screen.getByTestId('voice-note-btn');
  const keepDictating = (): void => {
    fireEvent.contextMenu(mic(), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Keep dictating'));
  };

  it('shows interim words in the input while speaking, and clears them at the end', () => {
    mount();
    keepDictating();
    act(() => cb.onPartial?.('hello wor'));
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('hello wor');
    act(() => cb.onPartial?.(''));
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('offers the mode a live-preview opener', () => {
    mount();
    keepDictating();
    expect(factory.mock.calls[0]![0].openPreview).toBeTypeOf('function');
  });

  it('right-click offers it in a menu, and does not start it by itself', () => {
    mount();
    fireEvent.contextMenu(mic(), { clientX: 10, clientY: 10 });
    expect(factory).not.toHaveBeenCalled();
    expect(screen.getByTestId('mic-menu')).toBeInTheDocument();
  });

  it('right-click offers Voice settings, which opens them and closes the menu', () => {
    const onOpenVoiceSettings = vi.fn();
    render(
      <Composer
        chatId="c1"
        hostId="d1"
        onSend={vi.fn()}
        onOpenVoiceSettings={onOpenVoiceSettings}
        dictationModeFactory={factory as unknown as typeof startDictationMode}
      />,
    );
    fireEvent.contextMenu(mic(), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText('Voice settings'));
    expect(onOpenVoiceSettings).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mic-menu')).toBeNull();
  });

  it('offers no Voice settings entry when the host gives no way to open them', () => {
    mount();
    fireEvent.contextMenu(mic(), { clientX: 10, clientY: 10 });
    expect(screen.queryByText('Voice settings')).toBeNull();
  });

  it('Keep dictating opens it and shows the status', () => {
    mount();
    keepDictating();
    expect(factory).toHaveBeenCalledOnce();
    expect(screen.getByTestId('dictation-mode-status').textContent).toBe('Dictating…');
    expect(mic().getAttribute('aria-pressed')).toBe('true');
  });

  it('cuts utterances at the pause set in Settings', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, dictationPauseSeconds: 8 },
      loaded: true,
    });
    mount();
    keepDictating();
    expect(factory.mock.calls[0]![0].segmenter).toEqual({ silenceMs: 8000 });
    usePreferencesStore.setState({ preferences: { ...DEFAULT_PREFERENCES } });
  });

  it('sends each utterance and stays open', () => {
    const onSend = mount();
    keepDictating();
    act(() => cb.onText('first thing'));
    act(() => cb.onText('second thing'));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0]![0]).toBe('first thing');
    expect(onSend.mock.calls[1]![0]).toBe('second thing');
    expect(stop).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dictation-mode-status')).not.toBeNull();
  });

  it('shows sending while a transcript is pending', () => {
    mount();
    keepDictating();
    act(() => cb.onBusy(1));
    expect(screen.getByTestId('dictation-mode-status').getAttribute('data-state')).toBe(
      'transcribing',
    );
  });

  it('a mic click ends it', () => {
    mount();
    keepDictating();
    fireEvent.mouseDown(mic());
    fireEvent.mouseUp(mic());
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('dictation-mode-status')).toBeNull();
  });

  it('Esc ends it', () => {
    mount();
    keepDictating();
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Escape' });
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('dictation-mode-status')).toBeNull();
  });

  it('right-click while it is open offers nothing more — the mic click ends it', () => {
    mount();
    keepDictating();
    fireEvent.contextMenu(mic(), { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('mic-menu')).toBeNull();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('asks the turn check when turn detection is on, and not when it is off', () => {
    mount();
    keepDictating();
    expect(typeof factory.mock.calls[0]![0].turnCheck).toBe('function');
    cleanupUnmount();
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, dictationTurnDetection: false },
      loaded: true,
    });
    mount();
    keepDictating();
    expect(factory.mock.calls[1]![0].turnCheck).toBeUndefined();
    usePreferencesStore.setState({ preferences: { ...DEFAULT_PREFERENCES } });
  });

  it('releases the mic on unmount', () => {
    mount();
    keepDictating();
    cleanupUnmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('surfaces a mic that cannot open and turns itself off', async () => {
    ready = Promise.reject(new Error('denied'));
    ready.catch(() => {});
    mount();
    keepDictating();
    await act(async () => {
      await ready.catch(() => {});
    });
    expect(screen.queryByTestId('dictation-mode-status')).toBeNull();
    expect(useUiStore.getState().errors.some((t) => t.message.includes('denied'))).toBe(true);
  });

  it('surfaces a transcription error', () => {
    mount();
    keepDictating();
    act(() => cb.onError('voice transcription failed: boom'));
    expect(useUiStore.getState().errors.some((t) => t.message.includes('boom'))).toBe(true);
  });
});

import { cleanup } from '@testing-library/react';
function cleanupUnmount(): void {
  cleanup();
}

describe('right button never starts a hold recording', () => {
  it('a secondary-button mousedown/up does not start the normal mic', () => {
    const recorderFactory = vi.fn();
    render(<Composer chatId="c1" hostId="d1" onSend={vi.fn()} recorderFactory={recorderFactory} />);
    const mic = screen.getByTestId('voice-note-btn');
    fireEvent.mouseDown(mic, { button: 2 });
    fireEvent.mouseUp(mic, { button: 2 });
    expect(recorderFactory).not.toHaveBeenCalled();
  });
});
