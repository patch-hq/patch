// Dictation mode (spec/07 § Dictation mode): right-click the composer mic and
// it stays open; each quiet-gap utterance is sent as its own message.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useUiStore } from '../stores/uiStore.js';
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

  it('right-click opens it and shows the status', () => {
    mount();
    fireEvent.contextMenu(mic());
    expect(factory).toHaveBeenCalledOnce();
    expect(screen.getByTestId('dictation-mode-status').textContent).toContain('pause to send');
    expect(mic().getAttribute('aria-pressed')).toBe('true');
  });

  it('sends each utterance and stays open', () => {
    const onSend = mount();
    fireEvent.contextMenu(mic());
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
    fireEvent.contextMenu(mic());
    act(() => cb.onBusy(1));
    expect(screen.getByTestId('dictation-mode-status').getAttribute('data-state')).toBe(
      'transcribing',
    );
  });

  it('a mic click ends it', () => {
    mount();
    fireEvent.contextMenu(mic());
    fireEvent.mouseDown(mic());
    fireEvent.mouseUp(mic());
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('dictation-mode-status')).toBeNull();
  });

  it('Esc ends it', () => {
    mount();
    fireEvent.contextMenu(mic());
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Escape' });
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('dictation-mode-status')).toBeNull();
  });

  it('a second right-click ends it', () => {
    mount();
    fireEvent.contextMenu(mic());
    fireEvent.contextMenu(mic());
    expect(stop).toHaveBeenCalledOnce();
  });

  it('releases the mic on unmount', () => {
    mount();
    fireEvent.contextMenu(mic());
    cleanupUnmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('surfaces a mic that cannot open and turns itself off', async () => {
    ready = Promise.reject(new Error('denied'));
    ready.catch(() => {});
    mount();
    fireEvent.contextMenu(mic());
    await act(async () => {
      await ready.catch(() => {});
    });
    expect(screen.queryByTestId('dictation-mode-status')).toBeNull();
    expect(useUiStore.getState().errors.some((t) => t.message.includes('denied'))).toBe(true);
  });

  it('surfaces a transcription error', () => {
    mount();
    fireEvent.contextMenu(mic());
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
