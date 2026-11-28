// spec/07 § Call cost — every costed voice session, kept on disk, and the
// per-host totals reported on `host.host.voiceUsage`.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  callTotalUsd,
  directSpeechCredits,
  speechCredits,
  type CallCosting,
  type SpeechUsage,
} from './voiceCost.js';

export interface VoiceUsageTotals {
  monthUsd: number;
  monthCalls: number;
  allUsd: number;
  allCalls: number;
  /** Gemini and OpenAI tokens, as the providers reported them. */
  monthTokens: number;
  allTokens: number;
  /** ElevenLabs credits: what each call was charged, plus speech (and direct calls' speech) at its per-character rate. */
  monthCredits: number;
  allCredits: number;
}

function callCredits(c: CallCosting): number {
  if (c.direct) return directSpeechCredits(c.direct);
  return c.real && 'credits' in c.real ? c.real.credits : 0;
}

function callTokens(c: CallCosting): number {
  const t = c.tokens;
  return t ? t.textIn + t.audioIn + t.cachedIn + t.textOut + t.audioOut : 0;
}

export interface VoiceLedger {
  record(c: CallCosting): void;
  /**
   * Speech a paid provider synthesised, whether or not a call was behind it
   * (patch_speak on a house speaker, a briefing). Counts toward the spend
   * totals, not toward the call counts.
   */
  recordSpeech(u: SpeechUsage): void;
  totals(now: number): VoiceUsageTotals;
}

/** Calendar month of `ms` in UTC, e.g. `2026-10`. */
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export function createVoiceLedger(path: string): VoiceLedger {
  const entries: CallCosting[] = [];
  const speech: SpeechUsage[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      // A line that does not parse is a corrupt ledger — fail loudly at boot
      // rather than reporting totals that silently leave a call out.
      const parsed = JSON.parse(line) as CallCosting | SpeechUsage;
      if ('kind' in parsed && parsed.kind === 'tts') speech.push(parsed);
      else entries.push(parsed as CallCosting);
    }
  }
  return {
    record(c: CallCosting): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(c)}\n`);
      entries.push(c);
    },
    recordSpeech(u: SpeechUsage): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(u)}\n`);
      speech.push(u);
    },
    totals(now: number): VoiceUsageTotals {
      const month = monthOf(now);
      const t: VoiceUsageTotals = {
        monthUsd: 0,
        monthCalls: 0,
        allUsd: 0,
        allCalls: 0,
        monthTokens: 0,
        allTokens: 0,
        monthCredits: 0,
        allCredits: 0,
      };
      for (const e of entries) {
        const usd = callTotalUsd(e);
        const tokens = callTokens(e);
        const credits = callCredits(e);
        t.allUsd += usd;
        t.allCalls += 1;
        t.allTokens += tokens;
        t.allCredits += credits;
        if (monthOf(e.endedAt) === month) {
          t.monthUsd += usd;
          t.monthCalls += 1;
          t.monthTokens += tokens;
          t.monthCredits += credits;
        }
      }
      for (const u of speech) {
        const credits = speechCredits(u.model, u.characters) ?? 0;
        t.allUsd += u.usd ?? 0;
        t.allCredits += credits;
        if (monthOf(u.at) === month) {
          t.monthUsd += u.usd ?? 0;
          t.monthCredits += credits;
        }
      }
      return t;
    },
  };
}
