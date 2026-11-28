// VoiceBar — the surface of a sustained voice session, in BOTH modes
// (spec/07 § Session modes). Replaces the floating call capsule.
//
// The capsule was a call UI: a pill that appeared over the app and said who
// last spoke. Hands-free is not a call — it is a mode you switch on and leave
// on, and in it most of what the mic hears is deliberately dropped (only an
// addressed utterance is a turn). Presented in the capsule that read as a call
// that ignored you: you spoke, the words were discarded at the host for want
// of the address word, and nothing on screen said so.
//
// So a sustained session takes a strip of the window instead, in flow at the
// top of the shell, and that strip always states what the line is doing:
//
//   connecting   Connecting…
//   reconnecting Lost contact — the line dropped and the call is trying to resume
//   waiting      hands-free: Waiting for you to say “patch”   ·  call: Listening
//   hearing      Hearing you — the words themselves are in the chat, as your bubble
//   heard        what it heard, greyed — dropped, because it wasn't addressed
//   thinking     Thinking…
//   speaking     Speaking — the reply streams into the chat
//   paused       Paused — the line is closed, Resume opens it again on the same chat
//
// Same bar, same controls, one mode switch between them.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Ear, MicOff, MessageSquare, Pause, PhoneOff, Play } from 'lucide-react';
import type { AudioSessionMode } from '@patch/wire/audio';
import { useVoiceStore } from '../stores/voiceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import {
  toggleCallMute,
  endVoiceCall,
  setCallMode,
  pauseVoiceCall,
  resumeVoiceCall,
} from '../lib/voiceController.js';
import { directCallLine } from '../lib/direct/directCall.js';

/** How long a dropped utterance stays on the bar before it returns to waiting. */
export const HEARD_LINGER_MS = 8_000;

const MODE_HEAD: Record<AudioSessionMode, string> = {
  call: 'On call',
  'hands-free': 'Hands-free',
};
const NEXT_MODE: Record<AudioSessionMode, AudioSessionMode> = {
  call: 'hands-free',
  'hands-free': 'call',
};

export function VoiceBar(): JSX.Element | null {
  const call = useVoiceStore((s) => s.call);
  const addressWord = usePreferencesStore((s) => s.preferences.addressWord);
  const [now, setNow] = useState(() => Date.now());

  // Tick off the stable startedAt, NOT the whole `call` object: `call` mutates
  // on every audio frame (level/transcript updates fire many times a second),
  // so depending on it here would clear and recreate the interval before it
  // ever reached 1000ms, freezing the timer at 00:00.
  const startedAt = call?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // A dropped utterance is feedback ("it heard you, it did not send it"), not a
  // log: show it, then go back to saying what the line is waiting for.
  const unaddressed = call?.unaddressed ?? null;
  useEffect(() => {
    if (unaddressed === null) return;
    const id = window.setTimeout(
      () => useVoiceStore.getState().setCallUnaddressed(null),
      HEARD_LINGER_MS,
    );
    return () => window.clearTimeout(id);
  }, [unaddressed]);

  if (!call) return null;

  const word = addressWord.trim() === '' ? 'patch' : addressWord.trim();
  const next = NEXT_MODE[call.mode];
  const direct = call.direct;
  const { state } = describeLine(call, '', word);
  // Same rows as the phone's call strip: status row, then one quiet note line.
  // A direct call's failed engine is named there, and the call stays open.
  const note = direct?.status.failure ?? callNote(call, state, word);

  return (
    <div
      className="voice-bar"
      data-testid="voice-bar"
      data-mode={call.mode}
      data-state={state}
      role="status"
    >
      <div className="vb-row">
        <span className="vb-mode" data-testid="voice-bar-head">
          {direct ? 'On call · direct' : MODE_HEAD[call.mode]}
        </span>
        <span className="vb-timer" data-testid="voice-bar-timer">
          {formatElapsed(Math.max(0, now - call.startedAt))}
        </span>
        {direct ? (
          <span className="vb-setup" data-testid="voice-bar-setup">
            {direct.setup}
          </span>
        ) : null}
        <span className="vb-line" data-testid="voice-bar-line">
          {state === 'paused' ? (
            <span className="vb-text">Paused</span>
          ) : direct && call.phase !== 'connecting' ? (
            direct.status.line === 'listening' || direct.status.line === 'hearing' ? (
              <Waveform level={call.muted ? 0 : call.level} />
            ) : (
              <span className="vb-text" data-testid="voice-bar-direct-status">
                {directCallLine(direct.status, now)}
              </span>
            )
          ) : state === 'connecting' || state === 'reconnecting' ? (
            <ConnectingLabel word={state === 'reconnecting' ? 'Lost contact' : 'Connecting'} />
          ) : state === 'thinking' ? (
            <span className="vb-text">Agent working</span>
          ) : (
            <Waveform level={call.muted ? 0 : call.level} />
          )}
        </span>
        {state === 'paused' ? (
          <button
            type="button"
            className="vb-action"
            data-testid="voice-bar-resume"
            aria-label="resume call"
            title="Resume"
            onClick={() => void resumeVoiceCall()}
          >
            <Play size={16} aria-hidden />
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`vb-action ${call.muted ? 'muted' : ''}`}
              data-testid="voice-bar-mute"
              aria-label={call.muted ? 'unmute' : 'mute'}
              onClick={toggleCallMute}
            >
              <MicOff size={16} aria-hidden />
            </button>
            {/* One control switches the two modes without tearing the session down. A direct call has one mode. */}
            {direct ? null : (
              <button
                type="button"
                className="vb-action"
                data-testid="voice-bar-mode"
                aria-label={`switch to ${MODE_HEAD[next].toLowerCase()}`}
                title={
                  next === 'hands-free'
                    ? `Switch to hands-free — it then only answers when you say “${word}”`
                    : 'Switch to a call — it answers everything you say'
                }
                onClick={() => setCallMode(next)}
              >
                {next === 'hands-free' ? (
                  <Ear size={16} aria-hidden />
                ) : (
                  <MessageSquare size={16} aria-hidden />
                )}
              </button>
            )}
            <button
              type="button"
              className="vb-action"
              data-testid="voice-bar-pause"
              aria-label="pause call"
              title="Pause"
              onClick={() => pauseVoiceCall()}
            >
              <Pause size={16} aria-hidden />
            </button>
          </>
        )}
        <button
          type="button"
          className="vb-action end"
          data-testid="voice-bar-end"
          aria-label="end voice session"
          onClick={() => endVoiceCall()}
        >
          <PhoneOff size={16} aria-hidden />
        </button>
      </div>
      {note === null ? null : (
        <div
          className={`vb-note${direct?.status.failure ? ' vb-note-error' : ''}`}
          data-testid="voice-bar-note"
        >
          {note}
        </div>
      )}
    </div>
  );
}

/** `Connecting` (or `Lost contact`) with dots that count up, as on the phone. */
function ConnectingLabel({ word }: { word: 'Connecting' | 'Lost contact' }): JSX.Element {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const id = window.setInterval(() => setDots((d) => (d % 3) + 1), 400);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="vb-text" data-testid="voice-bar-connecting">
      {word}
      {word === 'Connecting' ? '.'.repeat(dots) : ''}
    </span>
  );
}

/** The second line: words in flight, a dropped utterance, or the hands-free hint. */
function callNote(
  call: { mode: AudioSessionMode; phase: string; transcript: string; unaddressed: string | null },
  state: Line['state'],
  word: string,
): string | null {
  if (state === 'connecting' || state === 'reconnecting' || state === 'paused') return null;
  if (call.transcript !== '') return `You: ${call.transcript}`;
  if (call.unaddressed !== null) {
    return `Heard “${call.unaddressed}” — not addressed, so not sent`;
  }
  if (call.mode === 'hands-free') {
    return `Start with “${word}” — or reply within 30s of it speaking`;
  }
  return null;
}

/** Bars across the strip; the newest level enters on the right and scrolls left. */
const WAVE_BARS = 64;
const WAVE_TICK_MS = 80;

/**
 * Live input waveform: thin vertical bars filling the width. Heights are a
 * rolling window of the smoothed mic level, sampled on a timer (the level
 * itself updates per audio frame, far too often to render each one).
 */
function Waveform({ level }: { level: number }): JSX.Element {
  const [bars, setBars] = useState<number[]>(() => new Array<number>(WAVE_BARS).fill(0));
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    const id = window.setInterval(() => {
      setBars((prev) => [...prev.slice(1), levelRef.current]);
    }, WAVE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="vb-wave" data-testid="voice-bar-wave" aria-label="Listening" role="img">
      {bars.map((v, i) => (
        <i key={i} style={{ height: `${Math.round(8 + Math.min(1, Math.max(0, v)) * 92)}%` }} />
      ))}
    </span>
  );
}

interface Line {
  /** Short left-hand label, or null when the text speaks for itself. */
  tag: string | null;
  text: string;
  /** Drives the bar's styling, and what a test asserts on. */
  state:
    | 'connecting'
    | 'reconnecting'
    | 'listening'
    | 'waiting'
    | 'hearing'
    | 'heard'
    | 'thinking'
    | 'speaking'
    | 'paused';
}

interface LineInput {
  mode: AudioSessionMode;
  phase: string;
  agentSpeaking: boolean;
  transcript: string;
  unaddressed: string | null;
  lastLine: string;
  reconnecting: boolean;
  /** Set while the call is paused (spec/07 § Pause). */
  paused?: string | null;
}

/**
 * What the bar says right now. Ordered by precedence: what the line is DOING
 * (speaking / thinking / hearing) beats what it last did (heard), which beats
 * the resting state — and the resting state is the one that differs by mode,
 * because in hands-free it has to name the word that wakes it.
 */
export function describeLine(call: LineInput, _chatName: string, addressWord: string): Line {
  if (call.paused != null) return { tag: null, text: 'Paused', state: 'paused' };
  // A dropped line says so above anything it was doing when it dropped.
  if (call.reconnecting) return { tag: null, text: 'Lost contact', state: 'reconnecting' };
  if (call.agentSpeaking || call.phase === 'speaking') {
    return { tag: null, text: 'Speaking', state: 'speaking' };
  }
  if (call.phase === 'thinking') return { tag: null, text: 'Thinking…', state: 'thinking' };
  if (call.transcript !== '') return { tag: null, text: 'Hearing you', state: 'hearing' };
  if (call.unaddressed !== null) {
    return {
      tag: 'HEARD',
      text: `${call.unaddressed} — not addressed, so not sent`,
      state: 'heard',
    };
  }
  if (call.phase === 'connecting') {
    return { tag: null, text: 'Connecting…', state: 'connecting' };
  }
  if (call.mode === 'hands-free') {
    return { tag: null, text: `Waiting for you to say “${addressWord}”`, state: 'waiting' };
  }
  return { tag: null, text: 'Listening', state: 'listening' };
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const ss = String(total % 60).padStart(2, '0');
  return `${Math.floor(total / 60)}:${ss}`;
}
