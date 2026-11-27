// One reply of a voice agent as the user hears it (spec/07 § Barge-in), the
// same on every provider.
//
// A provider streams a reply's audio far faster than it plays, so the reply is
// over for the provider long before the user has heard it. The chat must keep
// what the user heard, so a reply is written into the chat only once its audio
// has had time to play out; if the user cuts in first, only the part they
// heard is written. Playback is taken to run in real time from the reply's
// first audio chunk, which is when the surface starts playing it.

import type { VoiceReplyWriter } from './voice-session-like.js';
import { heardPart } from './voiceAgent.js';

/** Audio from every voice agent provider reaches the surface as 24 kHz PCM. */
const SAMPLES_PER_MS = 24;

export class SpokenReply {
  private readonly begin: () => VoiceReplyWriter;
  /** Begun on the reply's first words: audio alone writes nothing into the chat. */
  private writer?: VoiceReplyWriter;
  private readonly now: () => number;
  private firstAudioAt = 0;
  private samples = 0;
  private ended = false;
  private written = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** Cut off before any of its text arrived: how much of its audio was heard. */
  private cutAt?: number;

  constructor(begin: () => VoiceReplyWriter, now: () => number = Date.now) {
    this.begin = begin;
    this.now = now;
  }

  /** More of the reply's words. */
  append(text: string): void {
    if (this.written) return;
    this.writer ??= this.begin();
    this.writer.append(text);
    // The words of a reply already cut off, arriving late: keep what was heard.
    if (this.cutAt !== undefined) this.write(heardPart(this.text(), this.cutAt, this.audioMs()));
  }

  /** The reply's words so far. */
  text(): string {
    return this.writer?.text() ?? '';
  }

  /** Some of the reply's words have arrived. */
  hasText(): boolean {
    return this.text() !== '';
  }

  /** More of the reply's audio went to the surface. */
  audio(samples: number): void {
    if (this.firstAudioAt === 0) this.firstAudioAt = this.now();
    this.samples += samples;
  }

  audioMs(): number {
    return this.samples / SAMPLES_PER_MS;
  }

  /** How long the reply has been playing, up to its whole length. */
  heardMs(): number {
    if (this.firstAudioAt === 0) return 0;
    return Math.min(this.audioMs(), this.now() - this.firstAudioAt);
  }

  /** How long the surface has still to play of it. */
  leftMs(): number {
    return this.written || this.firstAudioAt === 0 ? 0 : this.audioMs() - this.heardMs();
  }

  /** The surface is still playing it. */
  playing(): boolean {
    return !this.written && this.firstAudioAt !== 0 && this.heardMs() < this.audioMs();
  }

  /** Nothing more of the reply is coming: it is written once it has played out. */
  end(): void {
    if (this.ended || this.written) return;
    this.ended = true;
    const left = this.firstAudioAt === 0 ? 0 : this.audioMs() - this.heardMs();
    if (left <= 0) this.write();
    else this.timer = setTimeout(() => this.write(), left);
  }

  /**
   * The user cut in. Write the part they heard and return how long that was;
   * null when the reply had already played out (or been written).
   */
  cut(): number | null {
    if (this.written) return null;
    const heard = this.heardMs();
    if (this.firstAudioAt !== 0 && heard >= this.audioMs() && this.ended) {
      this.write();
      return null;
    }
    if (this.text() === '' && this.firstAudioAt !== 0) {
      // Its words have not arrived yet: write them, as far as heard, when they do.
      this.cutAt = heard;
      return heard;
    }
    this.write(heardPart(this.text(), heard, this.audioMs()));
    return heard;
  }

  /** Write it now, whole (the call is closing, or a new turn has begun). */
  flush(): void {
    if (this.cutAt !== undefined) {
      this.write('');
      return;
    }
    this.write();
  }

  private write(heard?: string): void {
    if (this.written) return;
    this.written = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.writer?.finish(heard);
  }
}
