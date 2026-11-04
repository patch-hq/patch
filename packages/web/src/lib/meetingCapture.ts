// meetingCapture — live 16 kHz mono PCM16 from the meeting's sources, for the
// desktop app's on-device transcriber. One stream per source: the mic ("you")
// and system audio ("them").
//
// Audio is delivered by the audio clock (ScriptProcessor callbacks), not a
// timer, so a hidden window's throttled timers cannot stall it, and the desktop
// shell turns background throttling off. NO FALLBACK: a denied mic or missing
// Web Audio API rejects `startMeetingCapture`.
//
// When both are captured the call is also audible in the room, so the mic is
// cleaned of the system audio (`EchoCanceller`) before it is transcribed: the
// mic then carries the local speaker only and each utterance is heard once.
//
// The mic is a MediaStream. System audio ("them") is NOT: the desktop shell's
// native helper taps it and hands over 16 kHz PCM (`PcmFeed`), so no screen is
// ever shared to hear a call.

import { createPcm16Downsampler, MIC_SAMPLE_RATE } from './pcmDownsample.js';
import { silentAudioContext } from './silentAudioContext.js';
import { EchoCanceller } from './echoCanceller.js';

/** RMS (0..1 of full scale) below which a stretch of audio is treated as silence. */
export const SILENCE_RMS = 0.004;

/** The far end saying nothing for this long means the call is over: the meeting ends itself. */
export const AUTO_END_SILENCE_SECONDS = 300;

export type MeetingSource = 'mic' | 'system';

export function rmsOfPcm16(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = (pcm[i] ?? 0) / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

export interface MeetingCaptureDeps {
  AudioContextImpl?: typeof AudioContext;
  /** Called once when the far end (system audio, else the mic) has been silent for AUTO_END_SILENCE_SECONDS. */
  onSilence?: () => void;
  silenceSeconds?: number;
}

/** Audio that is already 16 kHz mono PCM16, e.g. the desktop shell's system-audio tap. */
export interface PcmFeed {
  subscribe(onPcm: (pcm: Int16Array) => void): () => void;
  /** Stop the underlying source. Called once, on `stop()`. */
  stop(): void;
}

export interface MeetingSources {
  mic?: MediaStream;
  system?: PcmFeed;
}

export interface MeetingCapture {
  /** While paused, audio is dropped (what the echo canceller holds is delivered first). */
  setPaused(paused: boolean): void;
  /** Deliver what the echo canceller still holds, then release the devices. */
  stop(): void;
}

/**
 * Start capturing. The sources are already acquired so the caller owns
 * permission prompts; every one is stopped on `stop()`.
 */
export function startMeetingCapture(
  sources: MeetingSources,
  onPcm: (source: MeetingSource, pcm: Int16Array) => void,
  deps: MeetingCaptureDeps = {},
): MeetingCapture {
  const AudioCtx =
    deps.AudioContextImpl ??
    ((window as unknown as { AudioContext?: typeof AudioContext }).AudioContext as
      | typeof AudioContext
      | undefined);
  if (!AudioCtx) throw new Error('Web Audio API unavailable');

  let paused = false;
  // Silence is counted in captured audio, not wall time: the audio clock keeps
  // running in a hidden window and nothing is counted while paused. The far end
  // is watched when there is one; a mic-only meeting watches the mic.
  const silenceLimit = deps.silenceSeconds ?? AUTO_END_SILENCE_SECONDS;
  const watched: MeetingSource = sources.system ? 'system' : 'mic';
  let quietSeconds = 0;
  let silenceFired = false;
  const deliver = (source: MeetingSource, pcm: Int16Array): void => {
    if (pcm.length === 0) return;
    if (source === watched && !silenceFired) {
      if (rmsOfPcm16(pcm) < SILENCE_RMS) {
        quietSeconds += pcm.length / MIC_SAMPLE_RATE;
        if (quietSeconds >= silenceLimit) {
          silenceFired = true;
          deps.onSilence?.();
        }
      } else quietSeconds = 0;
    }
    onPcm(source, pcm);
  };
  // The system audio is the far-end reference for the mic. Alone, either needs no canceller.
  const aec = sources.mic && sources.system ? new EchoCanceller() : null;
  const lanes: { drain?: () => void; teardown: () => void }[] = [];

  if (sources.mic) {
    const stream = sources.mic;
    if (stream.getAudioTracks().length === 0) {
      throw new Error('Microphone stream has no audio track');
    }
    const ctx = silentAudioContext(AudioCtx);
    // A context created after an async getUserMedia may start suspended, and a
    // suspended context never fires onaudioprocess (it records silence).
    void ctx.resume();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const downsample = createPcm16Downsampler(ctx.sampleRate);
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      const raw = downsample(e.inputBuffer.getChannelData(0));
      // While paused the canceller still sees the mic, to keep it in step with the reference.
      const pcm = aec ? aec.processMic(raw) : raw;
      if (!paused) deliver('mic', pcm);
    };
    src.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    lanes.push({
      drain: aec ? () => deliver('mic', aec.flush()) : undefined,
      teardown: () => {
        processor.onaudioprocess = null;
        try {
          processor.disconnect();
          src.disconnect();
          sink.disconnect();
        } catch {
          /* already disconnected */
        }
        for (const t of stream.getTracks()) t.stop();
        void ctx.close().catch(() => undefined);
      },
    });
  }

  if (sources.system) {
    const feed = sources.system;
    const unsubscribe = feed.subscribe((pcm) => {
      // The reference runs while paused too, so the canceller's timeline stays continuous.
      aec?.pushFar(pcm);
      if (!paused) deliver('system', pcm);
    });
    lanes.push({
      teardown: () => {
        unsubscribe();
        feed.stop();
      },
    });
  }
  if (lanes.length === 0) throw new Error('no audio sources to capture');

  return {
    setPaused(p) {
      if (p && !paused) for (const l of lanes) l.drain?.();
      paused = p;
    },
    stop() {
      if (!paused) for (const l of lanes) l.drain?.();
      paused = true;
      for (const l of lanes) l.teardown();
    },
  };
}
