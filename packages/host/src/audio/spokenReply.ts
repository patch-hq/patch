// One reply of a voice agent as the user hears it (spec/07 § Barge-in), the
// same on every provider.
//
// The reply is one message in the chat from its first word: it is written then
// and changed in place as more words arrive. A provider streams a reply's audio
// far faster than it plays, so when the user cuts in the chat's message is cut
// back to what they heard, in the same message at the same place. Where the
// provider says what was heard (`cutAs`) that is the text; otherwise it is
// taken from how much of the audio had played, which runs in real time from
// the reply's first audio chunk (`cut`).

import type { VoiceReplyWriter } from './voice-session-like.js';
import { heardPart } from './voiceAgent.js';

/** Audio from every voice agent provider reaches the surface as 24 kHz PCM. */
const SAMPLES_PER_MS = 24;

/** What a reply ends in when the user cut it off. */
const CUT_MARK = '…';

export class SpokenReply {
  private readonly begin: () => VoiceReplyWriter;
  /** Begun on the reply's first words: audio alone writes nothing into the chat. */
  private writer?: VoiceReplyWriter;
  private readonly now: () => number;
  private words = '';
  private firstAudioAt = 0;
  private samples = 0;
  private ended = false;
  /** The user cut in: the surface is no longer playing it. */
  private stopped = false;
  /** Its text is final: nothing may change the message any more. */
  private closed = false;
  /** Cut off before any of its text arrived: how much of its audio was heard. */
  private cutAt?: number;

  constructor(begin: () => VoiceReplyWriter, now: () => number = Date.now) {
    this.begin = begin;
    this.now = now;
  }

  /** More of the reply's words, exactly as the provider gave them. */
  append(more: string): void {
    if (this.closed) return;
    this.words += more;
    // The words of a reply already cut off, arriving late: keep what was heard.
    if (this.cutAt !== undefined) {
      this.cutAs(heardPart(this.words, this.cutAt, this.audioMs()));
      return;
    }
    this.writer ??= this.begin();
    this.writer.set(this.words);
  }

  /** The reply's words so far. */
  text(): string {
    return this.words;
  }

  /** Some of the reply's words have arrived. */
  hasText(): boolean {
    return this.words !== '';
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
    return this.stopped || this.firstAudioAt === 0 ? 0 : this.audioMs() - this.heardMs();
  }

  /** The surface is still playing it. */
  playing(): boolean {
    return !this.stopped && this.firstAudioAt !== 0 && this.heardMs() < this.audioMs();
  }

  /** Nothing more of the reply is coming from the provider. */
  end(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.writer?.finish();
  }

  /**
   * The user cut in and the provider does not say what was heard: the message
   * is cut at the part of the text that matches the audio played. Returns how
   * long that was; null when the reply had already played out.
   */
  cut(): number | null {
    const heard = this.stop();
    if (heard === null) return null;
    // Its words have not arrived yet: cut them, as far as heard, when they do.
    if (this.words === '' && this.firstAudioAt !== 0) this.cutAt = heard;
    else this.cutAs(heardPart(this.words, heard, this.audioMs()));
    return heard;
  }

  /**
   * The user cut in. The surface stops playing it; what the message becomes is
   * set by `cutAs`, once the provider's account of what was heard is in.
   * Returns how long was heard; null when the reply had already played out.
   */
  stop(): number | null {
    if (this.closed) return null;
    const heard = this.heardMs();
    if (this.firstAudioAt !== 0 && heard >= this.audioMs() && this.ended) {
      this.close();
      return null;
    }
    this.stopped = true;
    return heard;
  }

  /** The message becomes what the user heard of it, marked as cut. */
  cutAs(heard: string): void {
    if (this.closed) return;
    this.stopped = true;
    const kept = heard
      .trimEnd()
      .replace(/(…|\.\.\.)$/, '')
      .trimEnd();
    this.words = `${kept}${CUT_MARK}`;
    this.writer ??= this.begin();
    this.writer.set(this.words);
    this.close();
  }

  /** Nothing more will change it (the call is closing, or a new turn has begun). */
  flush(): void {
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer?.finish();
  }
}
