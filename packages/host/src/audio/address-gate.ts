// Address gate for the Gemini Live tier (spec/07 § Session modes).
//
// Gemini Live answers whatever audio it is given and has no "transcribe but
// don't answer" switch, so hands-free's address rule has to be decided BEFORE
// the audio reaches it. The session therefore turns Gemini's own activity
// detection off and drives it manually (`activityStart` / audio / `activityEnd`
// in `realtimeInput`); this gate is what decides when.
//
// A local VAD cuts the mic into utterances. For each one:
//   - the session does not require an address (call), or the utterance opens
//     inside the follow-up window (Patch is speaking, or spoke <30s ago): it is
//     addressed already, so it streams to Gemini live, with no added latency;
//   - otherwise it is held, transcribed locally, and run through `isAddressed`.
//     Addressed: the held audio is released to Gemini in one burst. Not
//     addressed: it is reported as heard-but-not-sent and never leaves the host.
//
// A transcription failure is reported (`onError`), never treated as either
// answer (NO SILENT FALLBACK).

import type { Vad } from './vad.js';
import type { WhisperBackend } from './whisper.js';
import { DEFAULT_ADDRESS_WORD, isAddressed } from './session.js';

const FRAME_MS = (n: number): number => (n / 16000) * 1000;

/** Audio kept from before the VAD fires, so the first word is not clipped. */
const PREROLL_MS = 400;

/** The VAD's own hangover before it reports an end (DEFAULT_VAD_CONFIG.silenceHangoverMs). */
const VAD_HANGOVER_MS = 500;

/** An utterance this long with no end is cut off rather than held for ever. */
const MAX_HELD_MS = 60_000;

export interface AddressGateDeps {
  vad: Vad;
  transcriber: WhisperBackend;
  addressWord: () => string | undefined;
  /** Whether the session currently only takes addressed utterances. */
  requiresAddress: () => boolean;
  /** Ms since Patch last spoke; 0 while it is speaking; undefined if it has not. */
  msSinceSpoke: () => number | undefined;
  /**
   * Silence that ends an utterance. People pause on "uh"; ending on every
   * pause makes the model answer fragments.
   */
  endSilenceMs: number;
  /** Open one utterance on Gemini. */
  activityStart: () => void;
  /** One frame of an open utterance. */
  audio: (pcm: Int16Array) => void;
  activityEnd: () => void;
  /** An utterance that was heard and is not for Patch. */
  unaddressed: (text: string) => void;
  /** A held utterance that could not be judged. */
  onError: (err: Error) => void;
}

export class AddressGate {
  private readonly d: AddressGateDeps;
  private preroll: Int16Array[] = [];
  private prerollMs = 0;
  private inSpeech = false;
  /** True once the utterance is open on Gemini (streaming live or released). */
  private streaming = false;
  private held: Int16Array[] = [];
  private heldMs = 0;
  private silentMs = 0;
  /** Held utterances judged addressed while another was still streaming. */
  private releases: Int16Array[][] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: AddressGateDeps) {
    this.d = deps;
  }

  /** Feed one mic frame. Frames are processed in order, one at a time. */
  feed(pcm: Int16Array): Promise<void> {
    const copy = pcm.slice();
    this.chain = this.chain.then(() => this.step(copy));
    return this.chain;
  }

  async close(): Promise<void> {
    await this.chain;
    await this.d.vad.close();
  }

  private alreadyAddressed(): boolean {
    if (!this.d.requiresAddress()) return true;
    const since = this.d.msSinceSpoke();
    return since !== undefined && isAddressed('', '', since);
  }

  private async step(frame: Int16Array): Promise<void> {
    const ms = FRAME_MS(frame.length);
    const r = await this.d.vad.feed(frame, ms);
    if (r.event === 'utterance_start') {
      if (this.inSpeech) {
        // Speech resumed inside the end-of-utterance silence: same utterance.
        this.silentMs = 0;
      } else {
        this.inSpeech = true;
        this.silentMs = 0;
        this.held = [...this.preroll];
        this.heldMs = this.prerollMs;
        this.preroll = [];
        this.prerollMs = 0;
        if (this.alreadyAddressed()) this.open();
      }
    }
    if (!this.inSpeech) {
      this.preroll.push(frame);
      this.prerollMs += ms;
      while (this.prerollMs - FRAME_MS(this.preroll[0]?.length ?? 0) >= PREROLL_MS) {
        this.prerollMs -= FRAME_MS(this.preroll.shift()!.length);
      }
      return;
    }
    this.push(frame, ms);
    // The VAD reports the end after its own short hangover; wait out the rest
    // of the configured silence before closing. Speech coming back (a new
    // `utterance_start`, handled above) resets the count.
    if (r.state === 'silence' && r.event !== 'utterance_start') this.silentMs += ms;
    if (this.silentMs >= this.d.endSilenceMs - VAD_HANGOVER_MS || this.heldMs >= MAX_HELD_MS) {
      this.finish();
    }
  }

  private push(frame: Int16Array, ms: number): void {
    this.heldMs += ms;
    if (this.streaming) this.d.audio(frame);
    else this.held.push(frame);
  }

  private open(): void {
    this.streaming = true;
    this.d.activityStart();
    for (const f of this.held) this.d.audio(f);
    this.held = [];
  }

  private finish(): void {
    this.inSpeech = false;
    this.silentMs = 0;
    this.heldMs = 0;
    if (this.streaming) {
      this.streaming = false;
      this.d.activityEnd();
      this.flushReleases();
      return;
    }
    const clip = this.held;
    this.held = [];
    void this.judge(clip);
  }

  private async judge(clip: Int16Array[]): Promise<void> {
    const total = clip.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let at = 0;
    for (const f of clip) {
      pcm.set(f, at);
      at += f.length;
    }
    let text: string;
    try {
      text = (await this.d.transcriber.transcribe(pcm)).trim();
    } catch (err) {
      this.d.onError(err as Error);
      return;
    }
    // Nothing intelligible heard: noise, not an utterance to report or answer.
    if (text.length === 0) return;
    const addressed = isAddressed(
      text,
      this.d.addressWord() ?? DEFAULT_ADDRESS_WORD,
      this.d.msSinceSpoke(),
    );
    if (!addressed) {
      this.d.unaddressed(text);
      return;
    }
    this.releases.push(clip);
    if (!this.streaming) this.flushReleases();
  }

  /** Send held, addressed utterances, one whole utterance at a time. */
  private flushReleases(): void {
    while (this.releases.length > 0 && !this.streaming) {
      const clip = this.releases.shift()!;
      this.d.activityStart();
      for (const f of clip) this.d.audio(f);
      this.d.activityEnd();
    }
  }
}
