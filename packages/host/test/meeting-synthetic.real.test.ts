// Synthetic end-to-end meeting test with the REAL speech-to-text and the REAL
// analysis model. The unit suite fakes both, so failures that only show up with
// real audio, real latency and real quotas (429 stalls, lost tail clips, echo
// misattribution, hallucinated lines, schema failures, topic churn) cannot
// appear there. This costs money, so it is opt-in and runs nightly, never in
// the PR gate:
//
//   PATCH_SYNTHETIC_MEETING=1 GROQ_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… \
//     pnpm --filter @patch/host exec vitest run test/meeting-synthetic.real.test.ts
//
// (a) needs Kokoro (~/.patch/components/kokoro) and GROQ_API_KEY.
// (b) needs CLAUDE_CODE_OAUTH_TOKEN and a saved transcript (MEETING_REPLAY_FILE,
//     default ~/.patch/meetings/01M6K8M2H8RRCEXRHXYW3YHJYV.json).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  type WireEvent,
} from '@patch/wire';
import { MeetingManager, type MeetingPrompts } from '../src/meeting.js';
import { makeMeetingAnalyser, MEETING_MODEL } from '../src/meetingGen.js';
import { createRealSdkBackend } from '../src/sdkBackend.js';
import { GroqWhisperBackend } from '../src/audio/whisper.js';
import {
  buildCall,
  CALL_SCRIPT,
  clips,
  kokoroAvailable,
  SAMPLE_RATE,
  wav,
} from './helpers/syntheticCall.js';

const enabled = process.env['PATCH_SYNTHETIC_MEETING'] === '1';
const groqKey = process.env['GROQ_API_KEY'];
const claudeToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
const replayFile =
  process.env['MEETING_REPLAY_FILE'] ??
  join(homedir(), '.patch', 'meetings', '01M6K8M2H8RRCEXRHXYW3YHJYV.json');

// Thresholds. Tunable from the environment so a nightly run can be tightened.
const MAX_LAG_MS = Number(process.env['MEETING_MAX_LAG_S'] ?? 8) * 1000;
const MAX_ACTIONS = Number(process.env['MEETING_MAX_ACTIONS'] ?? 25);
const MAX_TOPIC_CHURN = Number(process.env['MEETING_MAX_TOPIC_CHURN'] ?? 0.35);
const CLIP_SECONDS = 6;

const PROMPTS: MeetingPrompts = {
  now: DEFAULT_MEETING_NOW_PROMPT,
  notes: DEFAULT_MEETING_NOTES_PROMPT,
  actions: DEFAULT_MEETING_ACTIONS_PROMPT,
};
const logger = pino({ level: 'silent' });
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'meeting-synth-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const words = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
/** Share of `a`'s words found in `b`. */
const covered = (a: string, b: string): number => {
  const wa = words(a);
  const wb = new Set(words(b));
  return wa.length === 0 ? 0 : wa.filter((w) => wb.has(w)).length / wa.length;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.runIf(enabled && kokoroAvailable() && groqKey !== undefined)(
  'synthetic call: real audio through the real host STT on Groq',
  () => {
    it(
      'keeps up in real time, loses nothing at End, attributes speakers and invents nothing',
      async () => {
        const call = await buildCall(CALL_SCRIPT);
        let status429 = 0;
        const groq = new GroqWhisperBackend({
          backend: 'groq',
          logger,
          groqApiKey: () => groqKey,
          fetchImpl: async (...args: Parameters<typeof fetch>) => {
            const res = await fetch(...args);
            if (res.status === 429) status429++;
            return res;
          },
        });
        const events: WireEvent[] = [];
        const m = new MeetingManager({
          dir: tmp(),
          transcribe: (b) => groq.transcribeClip(b, 'wav'),
          // Analysis is not under test here; a fixed result keeps (a) to STT cost.
          analyse: async (input) => ({
            now: { headline: 'Call', bullets: [], who: 'Priya' },
            topics: [],
            actions: [],
            summary: input.final ? { headline: 'Call', bullets: ['Invoice export'] } : null,
          }),
          prompts: () => PROMPTS,
          startChat: async () => 'child',
          logger,
          emit: (e) => events.push(e),
        });
        const chat = 'synthetic';
        m.start(chat);

        const sys = clips(call.system, CLIP_SECONDS);
        const mic = clips(call.mic, CLIP_SECONDS);
        const lags: number[] = [];
        const pending: Promise<void>[] = [];
        const t0 = Date.now();
        for (let i = 0; i < sys.length; i++) {
          // A clip is sent when its last sample has been "recorded".
          const readyAt = t0 + Math.min((i + 1) * CLIP_SECONDS * 1000, call.durationMs);
          await sleep(Math.max(0, readyAt - Date.now()));
          for (const [source, track] of [
            ['system', sys[i]!],
            ['mic', mic[i]!],
          ] as const) {
            const sentAt = Date.now();
            pending.push(
              m.ingestAudio(chat, source, wav(track)).then(() => {
                lags.push(Date.now() - sentAt);
              }),
            );
          }
        }
        await Promise.all(pending);
        await m.end(chat);

        const s = m.get(chat)!;
        const lines = s.transcript;
        const report = lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');

        expect(s.error, `transcription error on state\n${report}`).toBeNull();
        expect(status429, 'Groq 429 responses').toBe(0);
        expect(Math.max(...lags), `worst clip lag ms (${lags.join(',')})`).toBeLessThan(MAX_LAG_MS);
        expect(s.status).toBe('ended');

        // Nothing lost: every spoken turn is represented, including the last one.
        for (const spoken of CALL_SCRIPT) {
          const best = Math.max(...lines.map((l) => covered(spoken.text, l.text)));
          expect(
            best,
            `spoken line missing from transcript: "${spoken.text}"\n${report}`,
          ).toBeGreaterThan(0.5);
        }

        // Attribution: owner lines are the owner's turns, system lines are the remote voice.
        for (const l of lines) {
          const wantWho = l.speaker === 'you' ? 'you' : 'them';
          const home = CALL_SCRIPT.filter((x) => x.who === wantWho);
          const away = CALL_SCRIPT.filter((x) => x.who !== wantWho);
          const h = Math.max(...home.map((x) => covered(l.text, x.text)));
          const a = Math.max(...away.map((x) => covered(l.text, x.text)));
          expect(
            h,
            `"${l.speaker}" line belongs to the other side: "${l.text}"\n${report}`,
          ).toBeGreaterThanOrEqual(a);
        }

        // Hallucination: every line is something that was actually said.
        for (const l of lines) {
          const best = Math.max(...CALL_SCRIPT.map((x) => covered(l.text, x.text)));
          expect(best, `hallucinated line: "${l.text}"\n${report}`).toBeGreaterThan(0.5);
        }
      },
      10 * 60_000,
    );

    it('sends the whole call as 6s clips of the length the surface uses', () => {
      expect(CLIP_SECONDS * SAMPLE_RATE).toBe(96_000);
    });
  },
);

interface SavedMeeting {
  state: { transcript: { at: number; speaker: 'you' | 'them'; voice?: number; text: string }[] };
}

describe.runIf(enabled && claudeToken !== undefined && existsSync(replayFile))(
  'replay: a saved transcript through the real analysis model',
  () => {
    it(
      'returns valid analyses, caps actions and keeps topics stable between passes',
      async () => {
        const saved = JSON.parse(readFileSync(replayFile, 'utf8')) as SavedMeeting;
        const transcript = saved.state.transcript.slice(
          0,
          Number(process.env['MEETING_REPLAY_LINES'] ?? 120),
        );
        expect(transcript.length).toBeGreaterThan(20);

        const analyserErrors: string[] = [];
        const analyse = makeMeetingAnalyser({
          sdkBackend: createRealSdkBackend(),
          runOnAccountWithCredit: async (_label, run) => run(claudeToken!),
          cwd: tmp(),
          model: () => MEETING_MODEL,
        });
        let clock = 1_000_000;
        let nextTranscript = '';
        const m = new MeetingManager({
          dir: tmp(),
          transcribe: async () => nextTranscript,
          analyse: async (input) => {
            try {
              return await analyse(input);
            } catch (err) {
              analyserErrors.push((err as Error).message);
              throw err;
            }
          },
          prompts: () => PROMPTS,
          startChat: async () => 'child',
          logger,
          emit: () => undefined,
          now: () => clock,
        });
        const chat = 'replay';
        m.start(chat);

        const PASS_LINES = 30;
        const churn: number[] = [];
        for (let i = 0; i < transcript.length; i += PASS_LINES) {
          const before = m.get(chat)!.topics.map((t) => t.id);
          for (const l of transcript.slice(i, i + PASS_LINES)) {
            clock = 1_000_000 + l.at;
            nextTranscript = l.text;
            await m.ingestAudio(chat, l.speaker === 'you' ? 'mic' : 'system', Buffer.from('x'));
          }
          clock = 1_000_000 + transcript[Math.min(i + PASS_LINES, transcript.length) - 1]!.at;
          await m.tick(chat);
          const after = new Set(m.get(chat)!.topics.map((t) => t.id));
          // Churn: share of topics already on the panel that a pass removed or replaced.
          if (before.length > 0)
            churn.push(before.filter((id) => !after.has(id)).length / before.length);
        }

        const s = m.get(chat)!;
        expect(analyserErrors, 'analysis schema/parse failures').toEqual([]);
        expect(s.error, 'state error after passes').toBeNull();
        expect(s.actions.length, 'actions raised').toBeLessThanOrEqual(MAX_ACTIONS);
        expect(
          Math.max(0, ...churn),
          `topic churn per pass: ${churn.join(',')}`,
        ).toBeLessThanOrEqual(MAX_TOPIC_CHURN);
      },
      15 * 60_000,
    );
  },
);

it('is skipped unless PATCH_SYNTHETIC_MEETING=1 (it spends money)', () => {
  if (!enabled) expect(process.env['PATCH_SYNTHETIC_MEETING']).not.toBe('1');
});
