// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAudioHold, holdAudio } from './audioHold.js';

function playingAudio(): HTMLAudioElement {
  const el = document.createElement('audio');
  let paused = false;
  Object.defineProperty(el, 'paused', { get: () => paused });
  el.pause = vi.fn(() => {
    paused = true;
  });
  el.play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  document.body.appendChild(el);
  return el;
}

describe('holdAudio', () => {
  beforeEach(() => {
    __resetAudioHold();
    document.body.innerHTML = '';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pauses playing audio and resumes it on release', () => {
    const el = playingAudio();
    const release = holdAudio();
    expect(el.pause).toHaveBeenCalledOnce();
    release();
    expect(el.play).toHaveBeenCalledOnce();
  });

  it('leaves audio that was already paused alone', () => {
    const el = playingAudio();
    el.pause();
    const release = holdAudio();
    release();
    expect(el.play).not.toHaveBeenCalled();
  });

  it('resumes only when the last of several holds is released', () => {
    const el = playingAudio();
    const a = holdAudio();
    const b = holdAudio();
    a();
    a();
    expect(el.play).not.toHaveBeenCalled();
    b();
    expect(el.play).toHaveBeenCalledOnce();
  });

  it('pauses and resumes speech synthesis', () => {
    const synth = { speaking: true, paused: false, pause: vi.fn(), resume: vi.fn() };
    vi.stubGlobal('speechSynthesis', synth);
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    const release = holdAudio();
    expect(synth.pause).toHaveBeenCalledOnce();
    release();
    expect(synth.resume).toHaveBeenCalledOnce();
  });
});
