// spec/14 § Main chat panel — Hand-off rows. One collapsed row per voice
// hand-off, in the voice gutter where it was made: what was asked on one line
// and where it stands. Opened, it shows the request as sent and the chat's
// agent's answer, which is drawn here and nowhere else in the transcript.

import { useState } from 'react';
import { ArrowRight, ArrowRightLeft, ChevronRight } from 'lucide-react';
import type { VoiceHandoffView } from '../stores/chatStore.js';
import { useNow } from '../lib/browserView.js';
import { Markdown } from './Markdown.js';

/** "0:24" while working; "1:02:33" past an hour. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "38s", "2m 05s", "1h 02m". */
function took(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** The row's state, as it reads at `now`. Null for a record that has none. */
export function handoffStateLabel(h: VoiceHandoffView | undefined, now: number): string | null {
  if (!h) return null;
  switch (h.state) {
    case 'waiting':
      return 'waiting';
    case 'working':
      return `working ${clock(now - (h.startedAt ?? h.sentAt))}`;
    case 'answered':
      return `answered in ${took((h.endedAt ?? h.sentAt) - h.sentAt)}`;
    case 'failed':
      return 'failed';
  }
}

function Direction({ from, to }: { from: string; to: string }): JSX.Element {
  return (
    <span className="ho-dir">
      {from}
      <span className="ho-arrow">
        <ArrowRight size={12} aria-hidden="true" />
      </span>
      {to}
    </span>
  );
}

export function VoiceHandoffRow({
  request,
  handoff,
}: {
  /** The request as the hand-off's own message holds it. */
  request: string;
  /** Where it stands; absent on a record from before hand-off state was kept. */
  handoff: VoiceHandoffView | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const now = useNow(handoff?.state === 'working');
  const state = handoffStateLabel(handoff, now);
  const text = handoff?.request ?? request;
  return (
    <div
      className="msg ho-msg"
      data-testid="voice-handoff"
      data-open={open}
      {...(handoff ? { 'data-state': handoff.state } : {})}
    >
      <div className="msg-voice-row">
        <span className="msg-voice-mark ho-mark">
          <ArrowRightLeft size={14} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <div className="ho-wrap">
          <button
            type="button"
            className="ho-row"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid="voice-handoff-toggle"
          >
            <span className="ho-who">
              {handoff?.from ? `${handoff.from} asked the agent` : 'Asked the agent'}
            </span>
            <span className="ho-text">{text}</span>
            {state !== null ? (
              <span className="ho-state" data-testid="voice-handoff-state">
                {handoff?.state === 'working' ? <span className="ho-spin" /> : null}
                {state}
              </span>
            ) : null}
            <span className="ho-chev">
              <ChevronRight size={14} aria-hidden="true" />
            </span>
          </button>
          {open ? (
            <div className="ho-body" data-testid="voice-handoff-body">
              <div className="ho-part">
                <Direction from="Voice" to="Agent" />
                <p>{text}</p>
              </div>
              {handoff?.state === 'answered' && handoff.answer !== undefined ? (
                <div className="ho-part" data-testid="voice-handoff-answer">
                  <Direction from="Agent" to="Voice" />
                  <Markdown content={handoff.answer} />
                </div>
              ) : null}
              {handoff?.state === 'failed' ? (
                <div className="ho-part" data-testid="voice-handoff-error">
                  <Direction from="Agent" to="Voice" />
                  <p>Failed: {handoff.error ?? 'no reason given'}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
