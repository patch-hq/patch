// spec/07 § Session modes — the voice bar, which is the whole surface of a
// sustained session in both modes (there is no floating call capsule).
//
// The bug it was built for: a hands-free session dropped every unaddressed
// utterance at the host and the surface said nothing about it, so an open,
// working line looked like a broken call. The bar must always state what the
// line is doing, and in hands-free must name the word that wakes it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { VoiceBar, describeLine, HEARD_LINGER_MS } from '../components/VoiceBar.js';
import { useVoiceStore, type PauseReason } from '../stores/voiceStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import * as voiceController from '../lib/voiceController.js';
import type { AudioSessionMode } from '@patch/wire/audio';

function base(mode: AudioSessionMode) {
  return {
    chatId: 'thread_manager',
    startedAt: Date.now(),
    muted: false,
    lastLine: '',
    speaker: 'YOU' as const,
    agentSpeaking: false,
    transcript: '',
    level: 0,
    mode,
    unaddressed: null as string | null,
    phase: 'listening' as const,
    reconnecting: false,
    paused: null as PauseReason | null,
    direct: null as import('../stores/voiceStore.js').DirectCallBarState | null,
  };
}

function open(mode: AudioSessionMode, over: Partial<ReturnType<typeof base>> = {}): void {
  useVoiceStore.setState({ call: { ...base(mode), ...over } });
}

const line = (): string => screen.getByTestId('voice-bar-line').textContent ?? '';
const note = (): string | null => screen.queryByTestId('voice-bar-note')?.textContent ?? null;
const state = (): string | undefined => screen.getByTestId('voice-bar').dataset.state;

describe('voice bar', () => {
  beforeEach(() => {
    useVoiceStore.setState({ call: null });
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is absent with no session', () => {
    render(<VoiceBar />);
    expect(screen.queryByTestId('voice-bar')).toBeNull();
  });

  it('names the mode, in both modes', () => {
    open('call');
    const { rerender } = render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-head').textContent).toContain('On call');
    open('hands-free');
    rerender(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-head').textContent).toContain('Hands-free');
  });

  it('hands-free says what it is waiting for, naming the account address word', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, addressWord: 'jarvis' },
      loaded: true,
    });
    open('hands-free');
    render(<VoiceBar />);
    expect(state()).toBe('waiting');
    expect(note()).toBe('Start with “jarvis” — or reply within 30s of it speaking');
  });

  it('a call at rest shows a live waveform, not the word Listening, and never asks for an address word', () => {
    open('call');
    render(<VoiceBar />);
    expect(state()).toBe('listening');
    expect(screen.getByTestId('voice-bar-wave')).toBeTruthy();
    expect(line()).not.toContain('Listening');
    expect(note()).toBeNull();
  });

  it('the waveform follows the input level and flattens when muted', () => {
    vi.useFakeTimers();
    open('call', { level: 1 });
    render(<VoiceBar />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const bars = screen.getByTestId('voice-bar-wave').querySelectorAll('i');
    expect(bars.length).toBeGreaterThan(30);
    expect((bars[bars.length - 1] as HTMLElement).style.height).toBe('100%');
    act(() => {
      useVoiceStore.setState({ call: { ...base('call'), level: 1, muted: true } });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const after = screen.getByTestId('voice-bar-wave').querySelectorAll('i');
    expect((after[after.length - 1] as HTMLElement).style.height).toBe('8%');
  });

  it('the call length sits right after the mode head', () => {
    open('call');
    render(<VoiceBar />);
    const head = screen.getByTestId('voice-bar-head');
    expect(head.nextElementSibling).toBe(screen.getByTestId('voice-bar-timer'));
  });

  it('mute is always a struck-through mic', () => {
    open('call');
    render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-mute').querySelector('svg.lucide-mic-off')).not.toBeNull();
  });

  it('says it is hearing the user, leaving the words themselves to the chat', () => {
    open('hands-free', { transcript: 'patch what is agent two' });
    render(<VoiceBar />);
    expect(state()).toBe('hearing');
    expect(note()).toBe('You: patch what is agent two');
  });

  it('shows a dropped utterance as heard-not-sent, then returns to waiting', () => {
    vi.useFakeTimers();
    open('hands-free', { unaddressed: 'hello, hello, how is it going' });
    render(<VoiceBar />);
    expect(state()).toBe('heard');
    expect(note()).toContain('not addressed, so not sent');
    act(() => {
      vi.advanceTimersByTime(HEARD_LINGER_MS + 10);
    });
    expect(useVoiceStore.getState().call?.unaddressed).toBeNull();
    expect(state()).toBe('waiting');
  });

  it('runs an m:ss timer off the session start', () => {
    vi.useFakeTimers();
    open('call', { startedAt: Date.now() });
    const { rerender } = render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-timer').textContent).toBe('0:00');
    act(() => {
      vi.advanceTimersByTime(62_000);
    });
    rerender(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-timer').textContent).toBe('1:02');
  });

  it('mute, mode switch and end all reach the live session', () => {
    const mute = vi.spyOn(voiceController, 'toggleCallMute').mockImplementation(() => {});
    const mode = vi.spyOn(voiceController, 'setCallMode').mockImplementation(() => {});
    const end = vi.spyOn(voiceController, 'endVoiceCall').mockImplementation(() => {});
    open('hands-free');
    render(<VoiceBar />);
    fireEvent.click(screen.getByTestId('voice-bar-mute'));
    fireEvent.click(screen.getByTestId('voice-bar-mode'));
    fireEvent.click(screen.getByTestId('voice-bar-end'));
    expect(mute).toHaveBeenCalled();
    // Hands-free switches to a call, and vice versa.
    expect(mode).toHaveBeenCalledWith('call');
    expect(end).toHaveBeenCalled();
  });

  it('pause sits beside end and pauses the call', () => {
    const pause = vi.spyOn(voiceController, 'pauseVoiceCall').mockImplementation(() => {});
    open('call');
    render(<VoiceBar />);
    fireEvent.click(screen.getByTestId('voice-bar-pause'));
    expect(pause).toHaveBeenCalled();
  });

  it('a paused call reads Paused with Resume and End only', () => {
    const resume = vi
      .spyOn(voiceController, 'resumeVoiceCall')
      .mockImplementation(() => Promise.resolve());
    open('call', { paused: 'button' });
    render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar').dataset.state).toBe('paused');
    expect(line()).toBe('Paused');
    expect(note()).toBeNull();
    expect(screen.queryByTestId('voice-bar-mute')).toBeNull();
    expect(screen.queryByTestId('voice-bar-mode')).toBeNull();
    expect(screen.queryByTestId('voice-bar-pause')).toBeNull();
    expect(screen.getByTestId('voice-bar-end')).toBeTruthy();
    fireEvent.click(screen.getByTestId('voice-bar-resume'));
    expect(resume).toHaveBeenCalled();
  });

  it('says Connecting… with no note and no waveform until the host answers', () => {
    open('hands-free', { phase: 'connecting' as never });
    render(<VoiceBar />);
    expect(screen.getByTestId('voice-bar-connecting').textContent).toBe('Connecting.');
    expect(note()).toBeNull();
    expect(screen.queryByTestId('voice-bar-wave')).toBeNull();
  });

  it('says Reconnecting… while a dropped line redials, over whatever it was doing', () => {
    open('call', { phase: 'speaking' as never, reconnecting: true, agentSpeaking: true });
    render(<VoiceBar />);
    expect(state()).toBe('reconnecting');
    expect(screen.getByTestId('voice-bar-connecting').textContent).toBe('Reconnecting.');
    expect(note()).toBeNull();
  });

  it('reports the turn cycle: thinking, then speaking — the reply itself streams into the chat', () => {
    const rest = {
      mode: 'call' as const,
      transcript: '',
      unaddressed: null,
      lastLine: '',
      agentSpeaking: false,
      reconnecting: false,
    };
    expect(describeLine({ ...rest, phase: 'thinking' }, 'Manager', 'patch').state).toBe('thinking');
    const speaking = describeLine(
      { ...rest, phase: 'speaking', lastLine: 'agent two is deploying' },
      'Manager',
      'patch',
    );
    expect(speaking.state).toBe('speaking');
    expect(speaking.text).toBe('Speaking');
  });

  it('a live transcript wins over the last dropped utterance', () => {
    const l = describeLine(
      {
        mode: 'hands-free',
        phase: 'transcribing',
        agentSpeaking: false,
        transcript: 'patch stop',
        unaddressed: 'earlier chatter',
        lastLine: '',
        reconnecting: false,
      },
      'Manager',
      'patch',
    );
    expect(l.state).toBe('hearing');
    expect(l.text).toBe('Hearing you');
  });
});
