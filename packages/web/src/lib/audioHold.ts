// audioHold — the "two things never play at once" rule for the web surface.
//
// Anything that opens the mic or speaks (dictation, voice notes, calls, spoken
// alerts, read-aloud) takes a hold. While at least one hold is open, whatever
// audio Patch itself has playing — media elements in the page and the
// browser's speech synthesis — is paused; when the LAST hold is released,
// exactly what we paused resumes. Audio that was already paused stays paused.
//
// A web page cannot see or pause audio in other apps or tabs; the phone does
// that with native audio focus (PatchVoiceMic / PatchVoiceTts).

let holds = 0;
let pausedMedia: HTMLMediaElement[] = [];
let pausedSpeech = false;

function pauseWhatIsPlaying(): void {
  if (typeof document === 'undefined') return;
  pausedMedia = [];
  for (const el of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (!el.paused && !el.ended) {
      el.pause();
      pausedMedia.push(el);
    }
  }
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (synth && synth.speaking && !synth.paused) {
    synth.pause();
    pausedSpeech = true;
  }
}

function resumePaused(): void {
  const media = pausedMedia;
  pausedMedia = [];
  for (const el of media) {
    if (el.isConnected && el.paused) {
      el.play().catch((e: unknown) => {
        console.error('[patch-audio] could not resume paused audio', e);
      });
    }
  }
  if (pausedSpeech) {
    pausedSpeech = false;
    window.speechSynthesis.resume();
  }
}

/** Pause Patch's own playing audio until the returned release is called. Idempotent release. */
export function holdAudio(): () => void {
  if (holds++ === 0) pauseWhatIsPlaying();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) resumePaused();
  };
}

/** Test seam. */
export function __resetAudioHold(): void {
  holds = 0;
  pausedMedia = [];
  pausedSpeech = false;
}
