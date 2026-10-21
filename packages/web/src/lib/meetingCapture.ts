// meetingCapture — turns live audio into short 16 kHz mono WAV clips for the
// host's local Whisper (`meeting.audio`). One capture per source: the mic
// ("you") and, on the desktop app, system audio ("them").
//
// Clips are cut by sample count, not by a timer, so a hidden window's
// throttled timers cannot stall it: ScriptProcessor callbacks are driven by the
// audio clock, and the desktop shell turns background throttling off. A clip
// below the silence floor is dropped here, because Whisper invents words
// ("Thank you.") from silence. NO FALLBACK: a denied mic or missing Web Audio
// API rejects `startMeetingCapture`.
//
// When both are captured the call is also audible in the room, so the mic is
// cleaned of the system audio (`EchoCanceller`) before it is cut into clips:
// the mic then carries the local speaker only and each utterance is heard once.
//
// The mic is a MediaStream. System audio ("them") is NOT: the desktop shell's
// native helper taps it and hands over 16 kHz PCM (`PcmFeed`), so no screen is
// ever shared to hear a call.

import { createPcm16Downsampler, MIC_SAMPLE_RATE } from './pcmDownsample.js';
import { silentAudioContext } from './silentAudioContext.js';
import { EchoCanceller } from './echoCanceller.js';

export const CLIP_SECONDS = 6;
/** A tail shorter than this on stop is not worth a Whisper call. */
export const MIN_TAIL_SECONDS = 1;
/** RMS (0..1 of full scale) below which a clip is treated as silence. */
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

export function pcm16ToWav(pcm: Int16Array, sampleRate: number = MIC_SAMPLE_RATE): Uint8Array {
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (o: number, t: string): void => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Accumulates PCM and emits a WAV clip each time `clipSeconds` of it is full. */
export class ClipBuilder {
  private parts: Int16Array[] = [];
  private samples = 0;
  constructor(
    private readonly onClip: (wav: Uint8Array) => void,
    private clipSeconds: number = CLIP_SECONDS,
    private readonly onQuiet?: (seconds: number) => void,
  ) {}

  setClipSeconds(seconds: number): void {
    this.clipSeconds = seconds;
    if (this.samples >= seconds * MIC_SAMPLE_RATE) this.emit();
  }

  push(pcm: Int16Array): void {
    this.parts.push(pcm);
    this.samples += pcm.length;
    if (this.samples >= this.clipSeconds * MIC_SAMPLE_RATE) this.emit();
  }

  /** Emit what is buffered (if worth transcribing) and start over. */
  flush(): void {
    if (this.samples >= MIN_TAIL_SECONDS * MIC_SAMPLE_RATE) this.emit();
    else this.discard();
  }

  discard(): void {
    this.parts = [];
    this.samples = 0;
  }

  private emit(): void {
    const all = new Int16Array(this.samples);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.discard();
    if (rmsOfPcm16(all) < SILENCE_RMS) {
      this.onQuiet?.(all.length / MIC_SAMPLE_RATE);
      return;
    }
    this.onClip(pcm16ToWav(all));
  }
}

export interface MeetingCaptureDeps {
  AudioContextImpl?: typeof AudioContext;
  clipSeconds?: number;
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
  /** While paused, audio is dropped (a partial clip is flushed first). */
  setPaused(paused: boolean): void;
  /** Cut clips at this length from now on (a longer clip in progress just keeps filling). */
  setClipSeconds(seconds: number): void;
  /** Flush the last partial clips, then release the devices. */
  stop(): void;
}

/**
 * Start capturing. The sources are already acquired so the caller owns
 * permission prompts; every one is stopped on `stop()`.
 */
export function startMeetingCapture(
  sources: MeetingSources,
  onClip: (source: MeetingSource, wavBase64: string) => void,
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
  const quietFor =
    (source: MeetingSource) =>
    (seconds: number): void => {
      if (source !== watched || silenceFired) return;
      quietSeconds += seconds;
      if (quietSeconds >= silenceLimit) {
        silenceFired = true;
        deps.onSilence?.();
      }
    };
  const heard = (source: MeetingSource, wav: Uint8Array): void => {
    if (source === watched) quietSeconds = 0;
    onClip(source, bytesToBase64(wav));
  };
  // The system audio is the far-end reference for the mic. Alone, either needs no canceller.
  const aec = sources.mic && sources.system ? new EchoCanceller() : null;
  const lanes: { builder: ClipBuilder; drain?: () => void; teardown: () => void }[] = [];

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
    const builder = new ClipBuilder((wav) => heard('mic', wav), deps.clipSeconds, quietFor('mic'));
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      const raw = downsample(e.inputBuffer.getChannelData(0));
      // While paused the canceller still sees the mic, to keep it in step with the reference.
      const pcm = aec ? aec.processMic(raw) : raw;
      if (!paused) builder.push(pcm);
    };
    src.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    lanes.push({
      builder,
      drain: aec ? () => builder.push(aec.flush()) : undefined,
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
    const builder = new ClipBuilder(
      (wav) => heard('system', wav),
      deps.clipSeconds,
      quietFor('system'),
    );
    const unsubscribe = feed.subscribe((pcm) => {
      // The reference runs while paused too, so the canceller's timeline stays continuous.
      aec?.pushFar(pcm);
      if (!paused) builder.push(pcm);
    });
    lanes.push({
      builder,
      teardown: () => {
        unsubscribe();
        feed.stop();
      },
    });
  }
  if (lanes.length === 0) throw new Error('no audio sources to capture');

  return {
    setClipSeconds(seconds) {
      for (const l of lanes) l.builder.setClipSeconds(seconds);
    },
    setPaused(p) {
      if (p && !paused) {
        for (const l of lanes) l.drain?.();
        for (const l of lanes) l.builder.flush();
      }
      paused = p;
    },
    stop() {
      if (!paused) {
        for (const l of lanes) l.drain?.();
        for (const l of lanes) l.builder.flush();
      }
      paused = true;
      for (const l of lanes) l.teardown();
    },
  };
}
