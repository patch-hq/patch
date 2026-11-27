// The sounds a call makes (spec/07 § Call sounds), as WebAudio synthesis.
//
// These are the picks from design/voice-handoff-chat/sounds/index.html, drawn
// by the same note and envelope code so they sound the same. The web and
// desktop app render them in the page; the phone ships them as WAV files that
// `scripts/render-call-sounds.mjs` renders from this module, so every surface
// plays the same sound for the same state.

/** One state's sound. */
export type CallSoundName =
  | 'connecting'
  | 'connected'
  | 'passed-to-agent'
  | 'reconnecting'
  | 'reconnected'
  | 'paused'
  | 'ended'
  | 'agent-calling'
  | 'agent-working'
  | 'failed';

export interface CallSoundSpec {
  /**
   * Draw the sound into `ctx` from time `t`; returns its length in seconds. A
   * looping sound's length is one cycle, so cycles played back to back keep the
   * design's spacing.
   */
  draw: (ctx: BaseAudioContext, t: number) => number;
  /** Repeats until the state it marks ends (connecting, reconnecting, ringing, working). */
  loop: boolean;
}

interface NoteOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
}

// One note with a soft attack and decay.
export function note(
  ctx: BaseAudioContext,
  t: number,
  freq: number,
  dur: number,
  opts: NoteOpts = {},
): void {
  const { type = 'sine', gain = 0.18, attack = 0.012 } = opts;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const A4 = 440;
const G4 = 392;
const E4 = 329.63;

export const CALL_SOUNDS: Record<CallSoundName, CallSoundSpec> = {
  // Connecting A: a soft single-note pulse.
  connecting: {
    loop: true,
    draw: (c, t) => {
      for (let i = 0; i < 3; i++) note(c, t + i * 0.8, A4, 0.35, { gain: 0.1 });
      return 2.4;
    },
  },
  // Connected A: a short rising two-note.
  connected: {
    loop: false,
    draw: (c, t) => {
      note(c, t, C5, 0.18);
      note(c, t + 0.13, G5, 0.3);
      return 0.5;
    },
  },
  // Passed to the agent A: a single low tick.
  'passed-to-agent': {
    loop: false,
    draw: (c, t) => {
      note(c, t, 220, 0.08, { type: 'triangle', gain: 0.2 });
      return 0.15;
    },
  },
  // Reconnecting F: a muted two-tone, like a line searching.
  reconnecting: {
    loop: true,
    draw: (c, t) => {
      for (let i = 0; i < 3; i++) {
        note(c, t + i * 0.9, 600, 0.12, { type: 'square', gain: 0.03 });
        note(c, t + i * 0.9 + 0.15, 600, 0.12, { type: 'square', gain: 0.03 });
      }
      return 2.7;
    },
  },
  // Reconnected A: the connected sound.
  reconnected: {
    loop: false,
    draw: (c, t) => {
      note(c, t, C5, 0.18);
      note(c, t + 0.13, G5, 0.3);
      return 0.5;
    },
  },
  // Paused B: two soft descending notes.
  paused: {
    loop: false,
    draw: (c, t) => {
      note(c, t, E5, 0.2, { gain: 0.09 });
      note(c, t + 0.18, C5, 0.35, { gain: 0.09 });
      return 0.6;
    },
  },
  // Ended A: a descending three-note.
  ended: {
    loop: false,
    draw: (c, t) => {
      note(c, t, G5, 0.18);
      note(c, t + 0.15, E5, 0.18);
      note(c, t + 0.3, C5, 0.4);
      return 0.75;
    },
  },
  // Agent calling you C: a rising three-note triplet, repeated while it rings.
  'agent-calling': {
    loop: true,
    draw: (c, t) => {
      for (let r = 0; r < 3; r++) {
        [C5, E5, G5].forEach((f, i) => note(c, t + r * 0.9 + i * 0.1, f, 0.12, { gain: 0.1 }));
      }
      return 2.7;
    },
  },
  // Agent working (direct calls) E: two quiet alternating notes.
  'agent-working': {
    loop: true,
    draw: (c, t) => {
      for (let i = 0; i < 6; i++) {
        note(c, t + i * 0.8, i % 2 ? G4 : E4, 0.7, { gain: 0.035, attack: 0.25 });
      }
      return 4.8;
    },
  },
  // A call that failed for good: a low falling triple. Not one of the designed
  // state sounds — a failure is not a state the call carries on in — but the
  // same on every surface all the same.
  failed: {
    loop: false,
    draw: (c, t) => {
      [330, 330, 247].forEach((f, i) =>
        note(c, t + i * 0.09, f, 0.09, { gain: 0.1, attack: 0.01 }),
      );
      return 0.3;
    },
  },
};

export const CALL_SOUND_NAMES = Object.keys(CALL_SOUNDS) as CallSoundName[];

/**
 * Render one sound (one cycle of a looping one) to samples. The length is
 * exactly the sound's own, so a looped buffer repeats at the design's spacing.
 */
export async function renderCallSound(
  name: CallSoundName,
  sampleRate: number,
  Offline: typeof OfflineAudioContext = OfflineAudioContext,
): Promise<AudioBuffer> {
  const spec = CALL_SOUNDS[name];
  // Measure the length on a throwaway context: draw() only says it once drawn.
  const probe = new Offline(1, 1, sampleRate);
  const seconds = spec.draw(probe, 0);
  const ctx = new Offline(1, Math.ceil(seconds * sampleRate), sampleRate);
  spec.draw(ctx, 0);
  return ctx.startRendering();
}
