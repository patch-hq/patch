import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  type WireEvent,
} from '@patch/wire';
import {
  MeetingManager,
  MeetingError,
  type AnalyseInput,
  type CorrectInput,
  type WriteupInput,
  MeetingAnalysis,
  type MeetingDeps,
  type MeetingPrompts,
} from '../src/meeting.js';
import {
  buildMeetingPrompt,
  makeMeetingAnalyser,
  MEETING_MODEL,
  parseMeetingAnalysis,
  buildCorrectionPrompt,
  parseCorrections,
  makeMeetingCorrector,
  buildWriteupPrompt,
  parseWriteup,
} from '../src/meetingGen.js';
import type { MeetingWriteup } from '@patch/wire';
import { nameFixes } from '../src/meetingVocab.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { handleServerEvent } from '../src/index.js';

const logger = pino({ level: 'silent' });

const PROMPTS: MeetingPrompts = {
  now: DEFAULT_MEETING_NOW_PROMPT,
  notes: DEFAULT_MEETING_NOTES_PROMPT,
  actions: DEFAULT_MEETING_ACTIONS_PROMPT,
};

const analysis = (over: Partial<MeetingAnalysis> = {}): MeetingAnalysis => ({
  now: { headline: 'Ledger split timing', bullets: ['Black Friday risk'], who: 'Dev' },
  topics: [
    { id: null, title: 'Points ledger', points: ['Own service'], decided: true, atSeconds: 5 },
  ],
  actions: [{ kind: 'mine', title: "Top up Sam's sandbox", why: 'Sam: tests fail', atSeconds: 7 }],
  summary: null,
  ...over,
});

describe('MeetingManager', () => {
  let dir: string;
  let clock: number;
  let events: WireEvent[];
  let analyse: ReturnType<typeof vi.fn<(i: AnalyseInput) => Promise<MeetingAnalysis>>>;
  let transcribe: ReturnType<typeof vi.fn<(b: Buffer) => Promise<string>>>;
  let startChat: ReturnType<typeof vi.fn<(c: string, m: string) => Promise<string>>>;
  let transcribeVoices: ReturnType<
    typeof vi.fn<(s: string, b: Buffer) => Promise<{ text: string; voice: number }[]>>
  >;
  let diarise: boolean;
  let writeup: ReturnType<typeof vi.fn<(i: WriteupInput) => Promise<MeetingWriteup>>>;
  let ticks: (() => void)[];
  let n: number;

  const make = (extra: Partial<MeetingDeps> = {}): MeetingManager =>
    new MeetingManager({
      ...extra,
      dir,
      transcribe,
      ...(diarise ? { transcribeVoices } : {}),
      analyse,
      writeup,
      prompts: () => PROMPTS,
      startChat,
      logger,
      emit: (e) => events.push(e),
      now: () => clock,
      newId: () => `id${++n}`,
      setInterval: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearInterval: () => {
        ticks = [];
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meeting-'));
    clock = 1_000_000;
    events = [];
    ticks = [];
    n = 0;
    analyse = vi.fn(async () => analysis());
    transcribe = vi.fn(async () => 'hello there');
    startChat = vi.fn(async () => 'child1');
    transcribeVoices = vi.fn(async () => []);
    diarise = false;
    writeup = vi.fn(async () => ({
      title: 'Rollout planning',
      sections: [{ heading: 'Where we landed', items: [{ text: 'Ship in November' }] }],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps transcribing clips while a slow analysis pass is still running', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    let release!: () => void;
    analyse.mockImplementationOnce(
      () => new Promise<MeetingAnalysis>((r) => (release = () => r(analysis()))),
    );
    const tick = m.tick('c1');
    await Promise.resolve();
    transcribe.mockResolvedValueOnce('said during the slow pass');
    await m.ingestAudio('c1', 'mic', Buffer.from('b'));
    expect(m.get('c1')!.transcript.map((l) => l.text)).toContain('said during the slow pass');
    release();
    await tick;
  });

  it("splits a Them clip into numbered voices and merges a voice's consecutive stretches", async () => {
    diarise = true;
    const m = make();
    m.start('c1');
    transcribeVoices.mockResolvedValueOnce([
      { text: 'Shall we start?', voice: 1 },
      { text: 'Yes please.', voice: 1 },
      { text: 'I have the numbers.', voice: 2 },
    ]);
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    expect(m.get('c1')?.transcript.map((l) => [l.speaker, l.voice, l.text])).toEqual([
      ['them', 1, 'Shall we start? Yes please.'],
      ['them', 2, 'I have the numbers.'],
    ]);
    expect(transcribeVoices).toHaveBeenCalledWith('c1:1000000', expect.any(Buffer));
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('with a voice print, the mic is diarised: voice 0 is you, others are Them', async () => {
    diarise = true;
    const m = make({ hasVoiceprint: () => true });
    m.start('c1');
    transcribeVoices.mockResolvedValueOnce([
      { text: 'Right, my update.', voice: 0 },
      { text: 'Go on then.', voice: 1 },
    ]);
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.transcript.map((l) => [l.speaker, l.voice, l.text])).toEqual([
      ['you', undefined, 'Right, my update.'],
      ['them', 1, 'Go on then.'],
    ]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('with a voice print, your voice on the system channel is still you', async () => {
    diarise = true;
    const m = make({ hasVoiceprint: () => true });
    m.start('c1');
    transcribeVoices.mockResolvedValueOnce([{ text: 'Me in the room', voice: 0 }]);
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    expect(m.get('c1')?.transcript[0]?.speaker).toBe('you');
  });

  it('never diarises the mic without a voice print, and keeps one Them label without a diariser', async () => {
    diarise = true;
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(transcribeVoices).not.toHaveBeenCalled();
    expect(m.get('c1')?.transcript[0]).toEqual({ at: 0, speaker: 'you', text: 'hello there' });
  });

  it('labels voices in the analysis input, and a name replaces the number', async () => {
    diarise = true;
    const m = make();
    m.start('c1');
    transcribeVoices.mockResolvedValueOnce([
      { text: 'Morning all', voice: 1 },
      { text: 'Hi, Priya here', voice: 2 },
    ]);
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    await m.tick('c1');
    expect(analyse.mock.calls[0]![0].newLines.map((l) => l.speaker)).toEqual(['Them 1', 'Them 2']);
    m.nameVoice('c1', 2, 'Priya');
    transcribeVoices.mockResolvedValueOnce([{ text: 'Next item', voice: 2 }]);
    await m.ingestAudio('c1', 'system', Buffer.from('b'));
    await m.tick('c1');
    expect(analyse.mock.calls[1]![0].newLines.map((l) => l.speaker)).toEqual(['Priya']);
    expect(m.contextFor('c1')).toContain('Priya] Next item');
  });

  it('takes a voice name from the analysis once, and never overwrites a given one', async () => {
    diarise = true;
    const m = make();
    m.start('c1');
    transcribeVoices.mockResolvedValueOnce([
      { text: 'a', voice: 1 },
      { text: 'b', voice: 2 },
    ]);
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    m.nameVoice('c1', 1, 'Sam');
    analyse.mockResolvedValueOnce(
      analysis({
        voices: [
          { voice: 1, name: 'Dev' },
          { voice: 2, name: 'Priya' },
          { voice: 9, name: 'Nobody' },
        ],
      }),
    );
    await m.tick('c1');
    expect(m.get('c1')?.voices).toEqual({ '1': 'Sam', '2': 'Priya' });
  });

  it('refuses to name a voice that has not spoken', () => {
    const m = make();
    m.start('c1');
    expect(() => m.nameVoice('c1', 3, 'X')).toThrow(MeetingError);
  });

  it('a failed diarised transcription lands on state.error', async () => {
    diarise = true;
    const m = make();
    m.start('c1');
    transcribeVoices.mockRejectedValueOnce(new Error('DIARISE_MODEL_PATH is not set'));
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    expect(m.get('c1')?.error).toContain('DIARISE_MODEL_PATH');
    expect(m.get('c1')?.transcript).toEqual([]);
  });

  it('stamps a Them line with the speaker the call app lit up, and never a You line', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('Black Friday is the risk');
    await m.ingestAudio('c1', 'system', Buffer.from('a'), 'Priya');
    transcribe.mockResolvedValueOnce('I will check the ledger');
    await m.ingestAudio('c1', 'mic', Buffer.from('b'), 'Priya');
    transcribe.mockResolvedValueOnce('Anyone else on the call');
    await m.ingestAudio('c1', 'system', Buffer.from('c'));
    expect(m.get('c1')?.transcript.map((l) => [l.speaker, l.name])).toEqual([
      ['them', 'Priya'],
      ['you', undefined],
      ['them', undefined],
    ]);
  });

  it('does no text matching between sources: echo is removed from the audio before it arrives', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('So we should move the ledger split to January');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    clock += 2000;
    transcribe.mockResolvedValueOnce('So we should move the ledger split to January');
    await m.ingestAudio('c1', 'system', Buffer.from('b'));
    expect(m.get('c1')?.transcript.map((l) => l.speaker)).toEqual(['you', 'them']);
  });

  it('prompt asks for names and never calls the speaker "the user"', () => {
    const p = buildMeetingPrompt({
      chatId: 'c',
      previous: { now: null, topics: [], actions: [] },
      newLines: [{ clock: '00:05', speaker: 'Them', text: "Hi, I'm Priya" }],
      final: false,
      elapsedMs: 5000,
      myNotes: '',
      prompts: PROMPTS,
    });
    expect(p).toContain('by name');
    expect(p).toContain('never "the user"');
  });

  it("passes Tom's My notes to the analysis so a voice can be named from them", async () => {
    diarise = true;
    const m = make();
    m.start('c1');
    m.setMyNotes('c1', 'With Priya and Dev');
    transcribeVoices.mockResolvedValueOnce([{ text: 'Morning all', voice: 1 }]);
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    await m.tick('c1');
    const input = analyse.mock.calls[0]![0];
    expect(input.myNotes).toBe('With Priya and Dev');
    const p = buildMeetingPrompt(input);
    expect(p).toContain('With Priya and Dev');
    expect(p).toContain("Tom's own notes");
  });

  it('live Now shows what is said before analysis, then clears once the notes cover it', async () => {
    const m = make();
    m.start('c1');
    expect(m.get('c1')?.live).toBeNull();
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.live).toBe('hello there');
    expect(events.at(-1)).toMatchObject({ meeting: { live: 'hello there' } });
    await m.tick('c1');
    expect(m.get('c1')?.live).toBeNull();
    expect(m.get('c1')?.now?.headline).toBe('Ledger split timing');
  });

  it('lines that arrive while analysis runs stay live', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    transcribe.mockResolvedValue('and then more');
    let late: Promise<void> = Promise.resolve();
    analyse.mockImplementationOnce(async () => {
      // queued behind this analysis, so it lands after it
      late = m.ingestAudio('c1', 'mic', Buffer.from('b'));
      return analysis();
    });
    await m.tick('c1');
    await late;
    expect(m.get('c1')?.live).toBe('and then more');
  });

  it('settings default, are tunable mid-meeting, and set the analysis interval', () => {
    const intervals: number[] = [];
    const m = new MeetingManager({
      prompts: () => PROMPTS,
      dir,
      transcribe,
      analyse,
      startChat,
      logger,
      emit: (e) => events.push(e),
      now: () => clock,
      setInterval: (_fn, ms) => {
        intervals.push(ms);
        return intervals.length;
      },
      clearInterval: () => undefined,
    });
    m.start('c1');
    expect(m.get('c1')?.settings).toEqual({ clipSeconds: 6, analyseSeconds: 15 });
    m.tune('c1', { clipSeconds: 3, analyseSeconds: 8 });
    expect(m.get('c1')?.settings).toEqual({ clipSeconds: 3, analyseSeconds: 8 });
    expect(intervals).toEqual([15_000, 8_000]);
    expect(() => m.tune('c1', { clipSeconds: 1, analyseSeconds: 8 })).toThrow();
    expect(() => m.tune('nope', { clipSeconds: 3, analyseSeconds: 8 })).toThrow(MeetingError);
  });

  it('start publishes a live meeting and refuses a second', () => {
    const m = make();
    m.start('c1');
    expect(m.get('c1')?.status).toBe('live');
    expect(events.at(-1)).toMatchObject({ type: 'meeting.state', chatId: 'c1' });
    expect(() => m.start('c1')).toThrow(MeetingError);
  });

  it('transcribes clips in order, labelling mic as you and system as them', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    clock += 5000;
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    clock += 5000;
    await m.ingestAudio('c1', 'system', Buffer.from('b'));
    expect(m.get('c1')?.transcript).toEqual([
      { at: 5000, speaker: 'you', text: 'first' },
      { at: 10000, speaker: 'them', text: 'second' },
    ]);
  });

  it('transcribes with no vocabulary prompt, even once names are known', async () => {
    // A prompt made from earlier text gets parroted back over unclear audio.
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'system', Buffer.from('a'), 'Priya Shah');
    await m.ingestAudio('c1', 'mic', Buffer.from('b'));
    for (const call of transcribe.mock.calls) expect(call).toHaveLength(1);
  });

  it('drops silent clips instead of adding empty lines', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('   ');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.transcript).toEqual([]);
  });

  it('puts a transcription failure on state.error and clears it on the next success', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockRejectedValueOnce(new Error('sidecar down'));
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.error).toContain('sidecar down');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.error).toBeNull();
  });

  it('tick analyses only new lines and merges topics and actions once', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    const s = m.get('c1')!;
    expect(s.now?.headline).toBe('Ledger split timing');
    expect(s.topics).toEqual([
      { id: 'id1', at: 5000, title: 'Points ledger', points: ['Own service'], decided: true },
    ]);
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0]).toMatchObject({
      title: "Top up Sam's sandbox",
      status: 'pending',
      at: 7000,
    });

    await m.tick('c1'); // nothing new → no second model call
    expect(analyse).toHaveBeenCalledTimes(1);

    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({
        topics: [
          { id: 'id1', title: 'Points ledger', points: ['Own service', 'November'], decided: true },
        ],
        actions: [{ kind: 'mine', title: "top up  Sam's SANDBOX", why: 'again' }],
      }),
    );
    await m.tick('c1');
    const s2 = m.get('c1')!;
    expect(s2.topics).toHaveLength(1);
    expect(s2.topics[0]!.points).toEqual(['Own service', 'November']);
    expect(s2.actions).toHaveLength(1); // duplicate title ignored
    expect(analyse.mock.calls[1]![0].newLines).toHaveLength(1);
  });

  it('stores My notes with the meeting, broadcasts it, reloads it and leaves it alone through analysis', async () => {
    const m = make();
    m.start('c1');
    m.setMyNotes('c1', 'Ask Priya about the rollout');
    expect(m.get('c1')!.myNotes).toBe('Ask Priya about the rollout');
    const last = events.filter((e) => e.type === 'meeting.state').at(-1) as {
      meeting: { myNotes?: string };
    };
    expect(last.meeting.myNotes).toBe('Ask Priya about the rollout');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    expect(m.get('c1')!.myNotes).toBe('Ask Priya about the rollout');
    await m.end('c1');
    m.setMyNotes('c1', 'Ask Priya about the rollout\nFollow up Friday');
    expect(make().get('c1')!.myNotes).toBe('Ask Priya about the rollout\nFollow up Friday');
    expect(() => m.setMyNotes('nope', 'x')).toThrow(/no meeting/);
  });

  it('an edited point survives a later analysis pass that tries to rewrite it', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    m.editNotes('c1', {
      op: 'set_title',
      topicId: 'id1',
      text: 'Priya: split the ledger in January',
    });
    m.editNotes('c1', { op: 'set_bullet', topicId: 'id1', index: 0, text: 'Own team owns it' });
    expect(m.get('c1')!.topics[0]).toMatchObject({
      fixed: true,
      title: 'Priya: split the ledger in January',
    });

    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({
        topics: [
          { id: 'id1', title: 'Rewritten by model', points: ['x'], decided: false },
          {
            id: null,
            title: 'Dev: wait until November',
            points: ['Peak traffic'],
            decided: false,
            atSeconds: 9,
          },
        ],
      }),
    );
    await m.tick('c1');
    const topics = m.get('c1')!.topics;
    expect(topics).toHaveLength(2);
    expect(topics[0]).toMatchObject({
      title: 'Priya: split the ledger in January',
      points: ['Own team owns it'],
    });
    expect(topics[1]!.title).toBe('Dev: wait until November');
    // the model is told the point is fixed
    expect(analyse.mock.calls[1]![0].previous.topics[0]).toMatchObject({ fixed: true });
    expect(buildMeetingPrompt(analyse.mock.calls[1]![0])).toContain('"fixed":true');
  });

  it('an edit made while analysis is running still wins', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockImplementationOnce(async () => {
      m.editNotes('c1', { op: 'set_title', topicId: 'id1', text: 'Tom was here' });
      return analysis({ topics: [{ id: 'id1', title: 'Model', points: [], decided: false }] });
    });
    await m.tick('c1');
    expect(m.get('c1')!.topics[0]!.title).toBe('Tom was here');
  });

  it('inserts a point above another, keeps it through analysis, and removes it only if empty', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    m.editNotes('c1', { op: 'insert', aboveTopicId: 'id1', id: 'mine' });
    const s = m.get('c1')!;
    expect(s.topics.map((t) => t.id)).toEqual(['id1', 'mine']);
    expect(s.topics[1]!.at).toBeGreaterThan(s.topics[0]!.at);
    m.editNotes('c1', { op: 'set_title', topicId: 'mine', text: 'Tom: ship it' });
    expect(() => m.editNotes('c1', { op: 'remove', topicId: 'mine' })).toThrow(/not empty/);
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({ topics: [{ id: 'mine', title: 'x', points: [], decided: false }] }),
    );
    await m.tick('c1');
    expect(m.get('c1')!.topics.find((t) => t.id === 'mine')!.title).toBe('Tom: ship it');
    m.editNotes('c1', { op: 'insert', aboveTopicId: 'mine', id: 'blank' });
    m.editNotes('c1', { op: 'remove', topicId: 'blank' });
    expect(m.get('c1')!.topics.map((t) => t.id)).toEqual(['id1', 'mine']);
  });

  it('adds, edits and removes bullets, and rejects an unknown point', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    m.editNotes('c1', { op: 'add_bullet', topicId: 'id1', index: 1 });
    m.editNotes('c1', { op: 'set_bullet', topicId: 'id1', index: 1, text: 'Second' });
    m.editNotes('c1', { op: 'add_bullet', topicId: 'id1', index: 1 });
    expect(m.get('c1')!.topics[0]!.points).toEqual(['Own service', '', 'Second']);
    m.editNotes('c1', { op: 'remove_bullet', topicId: 'id1', index: 1 });
    expect(m.get('c1')!.topics[0]!.points).toEqual(['Own service', 'Second']);
    expect(() => m.editNotes('c1', { op: 'set_title', topicId: 'nope', text: 'x' })).toThrow(
      /no point nope/,
    );
    expect(() =>
      m.editNotes('c1', { op: 'set_bullet', topicId: 'id1', index: 9, text: 'x' }),
    ).toThrow(/no bullet 9/);
  });

  it('the default notes prompt asks for topic summaries naming who said what, in plain language that spell out acronyms', () => {
    expect(DEFAULT_MEETING_NOTES_PROMPT).toMatch(/title summarises that stretch[^]*who said what/);
    expect(DEFAULT_MEETING_NOTES_PROMPT).toMatch(/plain language/);
    expect(DEFAULT_MEETING_NOTES_PROMPT).toMatch(/spell out acronyms/);
    expect(DEFAULT_MEETING_NOTES_PROMPT).toMatch(/Decision: /);
  });

  it('the interval timer drives analysis', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    ticks[0]!();
    await vi.waitFor(() => expect(m.get('c1')?.now).not.toBeNull());
  });

  it('an analysis failure is surfaced, and the same lines are retried next pass', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockRejectedValueOnce(new Error('no credit'));
    await m.tick('c1');
    expect(m.get('c1')?.error).toContain('no credit');
    await m.tick('c1');
    expect(m.get('c1')?.error).toBeNull();
    expect(analyse.mock.calls[1]![0].newLines).toHaveLength(1);
  });

  it('a malformed analysis is an error, not a silent empty update', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce({ nope: true } as unknown as MeetingAnalysis);
    await m.tick('c1');
    expect(m.get('c1')?.error).toContain('analysis failed');
    expect(m.get('c1')?.now).toBeNull();
  });

  it('pause stops the clock and the timer, resume restarts both', async () => {
    const m = make();
    m.start('c1');
    clock += 60_000;
    m.pause('c1');
    expect(m.get('c1')).toMatchObject({ status: 'paused', elapsedBaseMs: 60_000 });
    expect(ticks).toHaveLength(0);
    clock += 600_000;
    m.resume('c1');
    clock += 1000;
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')!.transcript[0]!.at).toBe(61_000);
    expect(ticks).toHaveLength(1);
    expect(() => m.resume('c1')).toThrow(MeetingError);
  });

  it('end writes the final write-up from the cleaned transcript plus My notes, and Regenerate rewrites it', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('We ship in November');
    await m.ingestAudio('c1', 'system', Buffer.from('a'), 'Priya');
    m.setMyNotes('c1', 'Ask about budget');
    analyse.mockResolvedValueOnce(
      analysis({ summary: { headline: 'Split in November', bullets: ['1 decision'] } }),
    );
    clock += 53 * 60_000;
    await m.end('c1');
    const input = writeup.mock.calls[0]![0];
    expect(input.lines).toEqual([
      { clock: '00:00', speaker: 'Priya', text: 'We ship in November' },
    ]);
    expect(input.myNotes).toBe('Ask about budget');
    expect(input.durationMinutes).toBe(53);
    expect(m.get('c1')).toMatchObject({
      writeup: { title: 'Rollout planning' },
      writeupError: null,
    });
    writeup.mockResolvedValueOnce({ title: 'Second go', sections: [] });
    await m.regenerateWriteup('c1');
    expect(m.get('c1')!.writeup!.title).toBe('Second go');
    await expect(make().regenerateWriteup('nope')).rejects.toThrow(MeetingError);
  });

  it('a failed write-up is put on the state, not swallowed, and Regenerate clears it', async () => {
    const m = make();
    m.start('c1');
    writeup.mockRejectedValueOnce(new Error('model down'));
    await m.end('c1');
    expect(m.get('c1')!.writeup ?? null).toBeNull();
    expect(m.get('c1')!.writeupError).toMatch(/model down/);
    await m.regenerateWriteup('c1');
    expect(m.get('c1')!.writeupError).toBeNull();
    expect(m.get('c1')!.writeup!.title).toBe('Rollout planning');
  });

  it("names the chat after the write-up's title", async () => {
    const nameChat = vi.fn(async () => {});
    const m = make({ nameChat });
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.end('c1');
    expect(nameChat).toHaveBeenCalledWith('c1', 'Rollout planning');
  });

  it("keeps the user's edited write-up", async () => {
    const m = make();
    m.start('c1');
    await m.end('c1');
    m.setWriteup('c1', {
      title: 'Mine',
      sections: [{ heading: 'H', items: [{ text: 'x', mine: true }] }],
    });
    expect(m.get('c1')!.writeup!.sections[0]!.items[0]).toEqual({ text: 'x', mine: true });
    expect(() => m.setWriteup('c1', { title: 1 } as never)).toThrow();
  });

  it('Resume reopens an ended meeting and the write-up stays until it ends again', async () => {
    const m = make();
    m.start('c1');
    clock += 60_000;
    await m.end('c1');
    clock += 600_000;
    m.resume('c1');
    expect(m.get('c1')).toMatchObject({ status: 'live', elapsedBaseMs: 60_000 });
    expect(m.get('c1')!.endedAt).toBeUndefined();
    expect(m.get('c1')!.writeup!.title).toBe('Rollout planning');
    expect(ticks).toHaveLength(1);
    await m.end('c1');
    expect(writeup).toHaveBeenCalledTimes(2);
  });

  it('records the names the clean-up pass changed, for the write-up tooltips', () => {
    expect(nameFixes('Leca funds the bus', 'WECA funds the bus')).toEqual([
      { from: 'Leca', to: 'WECA' },
    ]);
    expect(nameFixes('met self gloss today', 'met South Glos today')).toEqual([
      { from: 'self gloss', to: 'South Glos' },
    ]);
    expect(nameFixes('same', 'same')).toEqual([]);
  });

  it('write-up prompt carries notes, transcript and the mine rule; reply parses', () => {
    const p = buildWriteupPrompt({
      chatId: 'c',
      date: '20 Oct',
      durationMinutes: 5,
      lines: [{ clock: '00:01', speaker: 'Priya', text: 'ship it' }],
      myNotes: 'ask budget',
      points: ['Priya: ship'],
      prompts: PROMPTS,
    });
    expect(p).toContain('[00:01 Priya] ship it');
    expect(p).toContain('ask budget');
    expect(p).toContain('"mine": true');
    expect(parseWriteup('```json\n{"title":"T","sections":[]}\n```').title).toBe('T');
    expect(() => parseWriteup('nope')).toThrow(/no JSON/);
  });

  it('end runs a final pass that writes the summary and then rejects audio', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({ summary: { headline: 'Split in November', bullets: ['1 decision'] } }),
    );
    clock += 52 * 60_000;
    await m.end('c1');
    const s = m.get('c1')!;
    expect(s.status).toBe('ended');
    expect(s.summary?.headline).toBe('Split in November');
    expect(s.elapsedBaseMs).toBe(52 * 60_000);
    expect(analyse.mock.calls[0]![0].final).toBe(true);
    expect(() => m.ingestAudio('c1', 'mic', Buffer.from('a'))).toThrow(/ended/);
    expect(() => m.start('c1')).not.toThrow(); // a new meeting may follow
  });

  it('model commentary is never stored as the summary or Now', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({
        summary: { headline: 'No new transcript provided to process', bullets: [] },
      }),
    );
    await m.end('c1');
    const s = m.get('c1')!;
    expect(s.summary).not.toBeNull();
    expect(s.summary?.headline).not.toMatch(/transcript/i);
    expect(s.error).toBeNull();
  });

  it('a final pass with no summary is an error on the state', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.end('c1'); // default analysis() has summary null
    expect(m.get('c1')?.error).toContain('no summary');
  });

  it('Do it dispatches through the chat and marks the card done; dismiss just drops it', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({
        actions: [
          { kind: 'agent', title: 'A one', why: 'w' },
          { kind: 'mine', title: 'B two', why: 'w' },
        ],
      }),
    );
    await m.tick('c1');
    const [a, b] = m.get('c1')!.actions;
    clock += 1;
    await m.decide('c1', a!.id, 'do');
    expect(startChat).toHaveBeenCalledWith('c1', expect.stringContaining('A one'));
    await m.decide('c1', b!.id, 'dismiss');
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(m.get('c1')!.actions.map((x) => x.status)).toEqual(['running', 'dismissed']);
    expect(m.get('c1')!.actions[0]!.chatId).toBe('child1');
    await expect(m.decide('c1', a!.id, 'do')).rejects.toThrow(/already running/);
    await expect(m.decide('c1', 'zzz', 'do')).rejects.toThrow(/no action/);
  });

  it('keeps the card pending when the chat refuses the action', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    startChat.mockRejectedValueOnce(new Error('chat busy'));
    await expect(m.decide('c1', m.get('c1')!.actions[0]!.id, 'chat')).rejects.toThrow('chat busy');
    expect(m.get('c1')!.actions[0]!.status).toBe('pending');
  });

  it('runs an action once when two decisions arrive together', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    let release!: () => void;
    startChat.mockImplementationOnce(
      () => new Promise<string>((r) => (release = () => r('child1'))),
    );
    const id = m.get('c1')!.actions[0]!.id;
    const first = m.decide('c1', id, 'chat');
    await expect(m.decide('c1', id, 'chat')).rejects.toThrow(/already/);
    release();
    await first;
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(m.get('c1')!.actions[0]!.status).toBe('running');
  });

  describe('action tray', () => {
    const triage = [
      { kind: 'mine' as const, title: 'Mine one', why: 'w' },
      { kind: 'other' as const, owner: 'Priya', title: 'Priya sends the deck', why: 'w' },
      { kind: 'agent' as const, title: 'Find vendor dates', why: 'w' },
    ];
    const started = async (): Promise<MeetingManager> => {
      const m = make();
      m.start('c1');
      await m.ingestAudio('c1', 'mic', Buffer.from('a'));
      analyse.mockResolvedValueOnce(analysis({ actions: triage }));
      await m.tick('c1');
      return m;
    };

    it('keeps the kind and owner the analysis gave each action', async () => {
      const m = await started();
      expect(m.get('c1')!.actions.map((a) => [a.kind, a.owner])).toEqual([
        ['mine', undefined],
        ['other', 'Priya'],
        ['agent', undefined],
      ]);
    });

    it('rejects an analysis action for someone else with no owner, and one with no kind', () => {
      expect(() =>
        MeetingAnalysis.parse(analysis({ actions: [{ kind: 'other', title: 't', why: 'w' }] })),
      ).toThrow(/owner/);
      expect(() =>
        MeetingAnalysis.parse({ ...analysis(), actions: [{ title: 't', why: 'w' }] }),
      ).toThrow();
    });

    it("never starts a chat on someone else's action, or does Tom's as the agent", async () => {
      const m = await started();
      const [mine, other, agent] = m.get('c1')!.actions;
      await expect(m.decide('c1', other!.id, 'do')).rejects.toThrow(/cannot/);
      await expect(m.decide('c1', other!.id, 'chat')).rejects.toThrow(/cannot/);
      await expect(m.decide('c1', mine!.id, 'do')).rejects.toThrow(/cannot/);
      await expect(m.decide('c1', agent!.id, 'chat')).rejects.toThrow(/cannot/);
      expect(startChat).not.toHaveBeenCalled();
    });

    it("starts a chat on Tom's action seeded with the action and the meeting", async () => {
      const m = await started();
      const mine = m.get('c1')!.actions[0]!;
      await m.decide('c1', mine.id, 'chat');
      const [parent, seed] = startChat.mock.calls[0]!;
      expect(parent).toBe('c1');
      expect(seed).toContain('Mine one');
      expect(seed).toContain('Points ledger');
      expect(m.get('c1')!.actions[0]).toMatchObject({ status: 'running', chatId: 'child1' });
    });

    it('lets any action be dismissed, and reassigns an owner', async () => {
      const m = await started();
      const [mine, other, agent] = m.get('c1')!.actions;
      m.setActionOwner('c1', other!.id, 'Everyone');
      expect(m.get('c1')!.actions[1]!.owner).toBe('Everyone');
      expect(() => m.setActionOwner('c1', mine!.id, 'Dev')).toThrow(/no owner/);
      for (const a of [mine, other, agent]) await m.decide('c1', a!.id, 'dismiss');
      expect(m.get('c1')!.actions.map((a) => a.status)).toEqual([
        'dismissed',
        'dismissed',
        'dismissed',
      ]);
    });

    it('never starts an agent action by itself: each waits for Approve', async () => {
      const m = await started();
      await m.ingestAudio('c1', 'mic', Buffer.from('a'));
      analyse.mockResolvedValueOnce(
        analysis({ actions: [{ kind: 'agent', title: 'Draft the recap', why: 'w' }] }),
      );
      await m.tick('c1');
      expect(startChat).not.toHaveBeenCalled();
      expect(
        m
          .get('c1')!
          .actions.filter((a) => a.kind === 'agent')
          .map((a) => a.status),
      ).toEqual(['pending', 'pending']);
    });

    it('refuses the retired "agent does its own actions" switch, and accepts turning it off', async () => {
      const m = await started();
      expect(() => m.setAgentRunsActions('c1', true)).toThrow(/Approve/);
      m.setAgentRunsActions('c1', false);
      expect(m.get('c1')!.agentRunsActions).toBeUndefined();
    });

    it('ticks an action off and back on, back to running when it has a chat', async () => {
      const m = await started();
      const [mine, , agent] = m.get('c1')!.actions;
      await m.decide('c1', agent!.id, 'do');
      await m.decide('c1', mine!.id, 'done');
      await m.decide('c1', agent!.id, 'done');
      expect(m.get('c1')!.actions.map((a) => a.status)).toEqual(['done', 'pending', 'done']);
      await expect(m.decide('c1', mine!.id, 'done')).rejects.toThrow(/already done/);
      await m.decide('c1', mine!.id, 'reopen');
      await m.decide('c1', agent!.id, 'reopen');
      expect(m.get('c1')!.actions.map((a) => a.status)).toEqual(['pending', 'pending', 'running']);
      await expect(m.decide('c1', mine!.id, 'reopen')).rejects.toThrow(/not done/);
    });

    it('hands an action to anyone, Tom and the agent included, and rewrites it', async () => {
      const m = await started();
      const [mine, other] = m.get('c1')!.actions;
      m.assignAction('c1', mine!.id, { kind: 'other', owner: 'Dev' });
      m.assignAction('c1', other!.id, { kind: 'agent' });
      m.setActionTitle('c1', other!.id, 'Look up the vendor dates');
      expect(m.get('c1')!.actions.slice(0, 2)).toMatchObject([
        { kind: 'other', owner: 'Dev' },
        { kind: 'agent', title: 'Look up the vendor dates' },
      ]);
      expect(m.get('c1')!.actions[1]!.owner).toBeUndefined();
      expect(() => m.assignAction('c1', mine!.id, { kind: 'other' })).toThrow(/owner/);
      expect(() => m.assignAction('c1', mine!.id, { kind: 'mine', owner: 'Dev' })).toThrow(/owner/);
    });

    it("adds an action Tom wrote, at the meeting's time now", async () => {
      const m = await started();
      clock += 5_000;
      m.addAction('c1', { title: 'Book the follow-up', kind: 'mine' });
      const added = m.get('c1')!.actions.at(-1)!;
      expect(added).toMatchObject({
        kind: 'mine',
        title: 'Book the follow-up',
        why: '',
        status: 'pending',
      });
      expect(added.at).toBe(5_000);
      expect(() => m.addAction('c1', { title: 'x', kind: 'other' })).toThrow(/owner/);
    });
  });

  it('contextFor hands the chat the panel and only unseen transcript, once', async () => {
    const m = make();
    expect(m.contextFor('c1')).toBeUndefined();
    m.start('c1');
    transcribe.mockResolvedValueOnce('we ship monday');
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    await m.tick('c1');
    const first = m.contextFor('c1')!;
    expect(first).toContain('<system-reminder>');
    expect(first).toContain('we ship monday');
    expect(first).toContain('Ledger split timing');
    expect(first).toContain("Top up Sam's sandbox");
    const second = m.contextFor('c1')!;
    expect(second).not.toContain('we ship monday');
  });

  it('survives a host restart: reloads from disk, parked as paused, atomic file only', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    clock += 30_000;
    const m2 = make();
    const s = m2.get('c1')!;
    expect(s.status).toBe('paused');
    expect(s.elapsedBaseMs).toBe(30_000);
    expect(s.transcript).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a corrupt meeting file throws rather than reading as empty', () => {
    const m = make();
    m.start('c1');
    const m2 = make();
    writeFileSync(join(dir, 'c1.json'), '{not json');
    expect(() => m2.get('c1')).toThrow();
  });
});

describe('meetingGen', () => {
  it('parses JSON wrapped in prose or fences', () => {
    const body = JSON.stringify(analysis());
    expect(parseMeetingAnalysis('Here you go:\n```json\n' + body + '\n```').now.headline).toBe(
      'Ledger split timing',
    );
  });

  it('rejects a reply with no JSON or the wrong shape', () => {
    expect(() => parseMeetingAnalysis('sorry')).toThrow(/no JSON/);
    expect(() => parseMeetingAnalysis('{"now":1}')).toThrow();
  });

  it('an empty new transcript tells the model to write from the notes', () => {
    const p = buildMeetingPrompt({
      chatId: 'c',
      previous: { now: null, topics: [], actions: [] },
      newLines: [],
      final: true,
      elapsedMs: 5000,
      myNotes: '',
      prompts: PROMPTS,
    });
    expect(p).toContain('already in the notes above');
  });

  it('asks for a summary only on the final pass', () => {
    const base: AnalyseInput = {
      chatId: 'c',
      previous: { now: null, topics: [], actions: [] },
      newLines: [{ clock: '00:05', speaker: 'You', text: 'hi' }],
      final: false,
      elapsedMs: 5000,
      myNotes: '',
      prompts: PROMPTS,
    };
    expect(buildMeetingPrompt(base)).toContain('"summary":null');
    expect(buildMeetingPrompt({ ...base, final: true })).toContain('one-line outcome');
    expect(buildMeetingPrompt(base)).toContain('[00:05 You] hi');
  });

  it('asks for the thrust of each point, no overlap, and detail that tapers with age', () => {
    const p = buildMeetingPrompt({
      chatId: 'c',
      previous: {
        now: null,
        topics: [{ id: 't1', at: 90_000, title: 'Ledger', points: ['a'], decided: false }],
        actions: [],
      },
      newLines: [{ clock: '20:00', speaker: 'Them', text: 'x' }],
      final: false,
      elapsedMs: 1_200_000,
      myNotes: '',
      prompts: PROMPTS,
    });
    expect(p).toMatch(/title summarises that stretch/);
    expect(p).toMatch(/never repeat/i);
    expect(p).toMatch(/older topics[^]*shorter/i);
    expect(p).toContain('"atSeconds":90');
  });
});

describe('editable meeting prompts', () => {
  const input: AnalyseInput = {
    chatId: 'c',
    previous: { now: null, topics: [], actions: [] },
    newLines: [{ clock: '00:05', speaker: 'You', text: 'hi' }],
    final: false,
    elapsedMs: 5000,
    myNotes: '',
    prompts: { now: 'NOW-RULES', notes: 'NOTES-RULES', actions: 'ACTION-RULES' },
  };

  it('puts each custom block in the analysis prompt and drops the defaults', () => {
    const p = buildMeetingPrompt(input);
    expect(p).toContain('NOW-RULES');
    expect(p).toContain('NOTES-RULES');
    expect(p).toContain('ACTION-RULES');
    expect(p).not.toContain(DEFAULT_MEETING_NOTES_PROMPT);
    expect(p).toContain('Reply with ONE JSON object');
  });

  it('the manager reads the prompts fresh on every pass', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'meeting-p-'));
    let current = PROMPTS;
    const seen: MeetingPrompts[] = [];
    const m = new MeetingManager({
      dir: dir2,
      transcribe: async () => 'hello',
      analyse: async (i) => {
        seen.push(i.prompts);
        return analysis();
      },
      prompts: () => current,
      startChat: async () => 'child',
      logger,
      emit: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    current = { now: 'N2', notes: 'T2', actions: 'A2' };
    await m.ingestAudio('c1', 'mic', Buffer.from('b'));
    await m.tick('c1');
    expect(seen).toEqual([PROMPTS, current]);
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('meeting action restraint', () => {
  it("only raises actions that are the user's to do or an assistant could do for them", () => {
    const p = buildMeetingPrompt({
      chatId: 'c',
      previous: { now: null, topics: [], actions: [] },
      newLines: [{ clock: '00:05', speaker: 'Them', text: 'x' }],
      final: false,
      elapsedMs: 5000,
      myNotes: '',
      prompts: PROMPTS,
    });
    expect(p).toMatch(/"kind"/);
    expect(p).toMatch(/"mine"[^]*"other"[^]*"agent"/);
    expect(p).toMatch(/not every mention/i);
    expect(p).toMatch(/nobody can or should act on/i);
  });
});

describe('makeMeetingAnalyser', () => {
  const input: AnalyseInput = {
    chatId: 'c',
    previous: { now: null, topics: [], actions: [] },
    newLines: [{ clock: '00:05', speaker: 'Them', text: 'ship monday' }],
    final: false,
    elapsedMs: 5000,
    myNotes: '',
    prompts: PROMPTS,
  };

  it('runs the cheap model with the transcript and parses the reply', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: JSON.stringify(analysis()) },
      { type: 'result', sessionId: 's' },
    ]);
    const gen = makeMeetingAnalyser({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_l, run) => run('tok'),
      cwd: '/home/x',
      model: () => MEETING_MODEL,
    });
    const out = await gen(input);
    expect(out.now.headline).toBe('Ledger split timing');
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(MEETING_MODEL);
    expect(opts?.oauthAccessToken).toBe('tok');
    expect(opts?.prompt).toContain('ship monday');
  });

  it('reads the model fresh on every pass', async () => {
    const sdk = createMockSdkBackend();
    for (let i = 0; i < 2; i++)
      sdk.enqueue([
        { type: 'assistant', content: JSON.stringify(analysis()) },
        { type: 'result', sessionId: 's' },
      ]);
    let model = 'claude-haiku-4-5-20251001';
    const gen = makeMeetingAnalyser({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_l, run) => run('tok'),
      cwd: '/home/x',
      model: () => model,
    });
    await gen(input);
    expect(sdk.lastOptions()?.model).toBe('claude-haiku-4-5-20251001');
    model = 'claude-sonnet-5';
    await gen(input);
    expect(sdk.lastOptions()?.model).toBe('claude-sonnet-5');
  });

  it('throws when no account can run it, instead of returning an empty update', async () => {
    const gen = makeMeetingAnalyser({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: async () => null,
      cwd: '/home/x',
      model: () => MEETING_MODEL,
    });
    await expect(gen(input)).rejects.toThrow(/no account/);
  });

  it('throws on a model reply that is not the notes JSON', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'I cannot do that' },
      { type: 'result', sessionId: 's' },
    ]);
    const gen = makeMeetingAnalyser({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_l, run) => run('tok'),
      cwd: '/home/x',
      model: () => MEETING_MODEL,
    });
    await expect(gen(input)).rejects.toThrow(/no JSON/);
  });
});

describe('meeting events on the host link', () => {
  it('routes control, audio, action and get events to the manager', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-ev-'));
    const sent: WireEvent[] = [];
    const m = new MeetingManager({
      prompts: () => PROMPTS,
      dir,
      transcribe: async () => 'hi',
      analyse: async () => analysis({ summary: { headline: 'h', bullets: [] } }),
      startChat: async () => 'child',
      logger,
      emit: (e) => sent.push(e),
    });
    const send = (e: WireEvent): Promise<void> =>
      handleServerEvent(e, {} as never, (x) => sent.push(x), logger, { meetings: m } as never);
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'start' });
    await send({
      type: 'meeting.audio',
      chatId: 'c',
      source: 'mic',
      audioBase64: Buffer.from('x').toString('base64'),
    });
    expect(m.get('c')?.transcript).toHaveLength(1);
    await m.tick('c');
    await send({
      type: 'meeting.action_request',
      chatId: 'c',
      actionId: m.get('c')!.actions[0]!.id,
      decision: 'dismiss',
    });
    expect(m.get('c')!.actions[0]!.status).toBe('dismissed');
    await send({ type: 'meeting.research_request', chatId: 'c', on: false });
    expect(m.get('c')?.researchOn).toBe(false);
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'pause' });
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'resume' });
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'end' });
    expect(m.get('c')?.status).toBe('ended');
    await send({
      type: 'meeting.writeup_request',
      chatId: 'c',
      writeup: { title: 'Edited', sections: [] },
    });
    expect(m.get('c')?.writeup?.title).toBe('Edited');
    await send({ type: 'meeting.writeup_request', chatId: 'c', regenerate: true });
    expect(m.get('c')?.writeupError).toMatch(/no write-up generator/);
    sent.length = 0;
    await send({ type: 'meeting.get_request', chatId: 'c' });
    expect(sent[0]).toMatchObject({ type: 'meeting.state', chatId: 'c' });
    m.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes the action edits to the manager', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-ev-'));
    const m = new MeetingManager({
      prompts: () => PROMPTS,
      dir,
      transcribe: async () => 'hi',
      analyse: async () => analysis(),
      startChat: async () => 'child',
      logger,
      emit: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    });
    const sent: WireEvent[] = [];
    const daemon = { allocErrorSeq: () => 1 } as never;
    const send = (e: WireEvent): Promise<void> =>
      handleServerEvent(e, daemon, (x) => sent.push(x), logger, { meetings: m } as never);
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'start' });
    await send({
      type: 'meeting.action_request',
      chatId: 'c',
      add: { title: 'Book the room', kind: 'mine' },
    });
    const id = m.get('c')!.actions[0]!.id;
    await send({
      type: 'meeting.action_request',
      chatId: 'c',
      actionId: id,
      assign: { kind: 'other', owner: 'Sam' },
    });
    await send({ type: 'meeting.action_request', chatId: 'c', actionId: id, title: 'Book a room' });
    await send({ type: 'meeting.action_request', chatId: 'c', actionId: id, decision: 'done' });
    expect(m.get('c')!.actions[0]).toMatchObject({
      kind: 'other',
      owner: 'Sam',
      title: 'Book a room',
      status: 'done',
    });
    await send({
      type: 'meeting.action_request',
      chatId: 'c',
      actionId: id,
      title: 'x',
      decision: 'reopen',
    });
    expect(JSON.stringify(sent.at(-1))).toMatch(/exactly one/);
    expect(m.get('c')!.actions[0]!.status).toBe('done');
    m.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a chat error when a meeting op is refused, and when the host has no meeting support', async () => {
    const sent: WireEvent[] = [];
    const daemon = { allocErrorSeq: () => 1 } as never;
    await handleServerEvent(
      { type: 'meeting.control_request', chatId: 'c', action: 'start' },
      daemon,
      (x) => sent.push(x),
      logger,
      {} as never,
    );
    expect(sent[0]).toMatchObject({ type: 'chat.error', chatId: 'c' });
    sent.length = 0;
    await handleServerEvent(
      { type: 'meeting.control_request', chatId: 'c', action: 'name_voice', name: 'Pri' },
      daemon,
      (x) => sent.push(x),
      logger,
      {} as never,
    );
    expect(sent[0]).toMatchObject({ type: 'chat.error', chatId: 'c' });
  });
});

describe('transcript correction pass', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meeting-corr-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (
    correct: (i: CorrectInput) => Promise<string[]>,
    analyse: (i: AnalyseInput) => Promise<MeetingAnalysis>,
    texts: string[],
    glossary: string[] = ['WECA: Leca, Weka, WEPA'],
  ): MeetingManager => {
    const q = [...texts];
    return new MeetingManager({
      prompts: () => PROMPTS,
      dir,
      transcribe: async () => q.shift() as string,
      analyse,
      correct,
      glossary: () => glossary,
      startChat: async () => 'child',
      logger,
      emit: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
  };

  it('remembers what each correction changed', async () => {
    const correct = async (i: CorrectInput) => i.lines.map((l) => l.text.replace('Leca', 'WECA'));
    const m = make(correct, async () => analysis(), ['Leca funds the bus']);
    m.start('c');
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.tick('c');
    expect(m.get('c')!.nameFixes).toEqual([{ from: 'Leca', to: 'WECA' }]);
  });

  it('corrects lines before analysis and the notes and chat context get the fixed text', async () => {
    const correct = vi.fn(async (i: CorrectInput) =>
      i.lines.map((l) => l.text.replace('Weka', 'WECA').replace('self gloss', 'South Glos')),
    );
    const analyse = vi.fn(async (_i: AnalyseInput) => analysis());
    const m = make(correct, analyse, ['Weka funds the bus', 'self gloss agreed']);
    m.start('c');
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.tick('c');
    expect(correct.mock.calls[0]![0].glossary).toEqual(['WECA: Leca, Weka, WEPA']);
    expect(analyse.mock.calls[0]![0].newLines.map((l) => l.text)).toEqual([
      'WECA funds the bus',
      'South Glos agreed',
    ]);
    expect(m.contextFor('c')).toContain('South Glos agreed');
  });

  it('a correction failure is surfaced, analysis is skipped, and the lines are retried', async () => {
    let fail = true;
    const correct = vi.fn(async (i: CorrectInput) => {
      if (fail) throw new Error('model down');
      return i.lines.map((l) => l.text.toUpperCase());
    });
    const analyse = vi.fn(async (_i: AnalyseInput) => analysis());
    const m = make(correct, analyse, ['hello']);
    m.start('c');
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.tick('c');
    expect(m.get('c')!.error).toContain('model down');
    expect(analyse).not.toHaveBeenCalled();
    fail = false;
    await m.tick('c');
    expect(analyse.mock.calls[0]![0].newLines[0]!.text).toBe('HELLO');
  });

  it('does not re-correct lines already corrected', async () => {
    const correct = vi.fn(async (i: CorrectInput) => i.lines.map((l) => l.text));
    const m = make(correct, async () => analysis(), ['a', 'b']);
    m.start('c');
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.tick('c');
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.tick('c');
    expect(correct.mock.calls[1]![0].lines.map((l) => l.text)).toEqual(['b']);
    expect(correct.mock.calls[1]![0].before).toEqual(['a']);
  });

  it('a wrong-length correction is an error, not a silent misalignment', async () => {
    const m = make(
      async () => [],
      async () => analysis(),
      ['a'],
    );
    m.start('c');
    await m.ingestAudio('c', 'system', Buffer.from(''));
    await m.tick('c');
    expect(m.get('c')!.error).toContain('correction returned 0 lines for 1');
  });
});

describe('meeting corrector (small model)', () => {
  const input: CorrectInput = {
    chatId: 'c',
    glossary: ['South Glos: self gloss, South Wales'],
    context: { now: 'Bus funding', topics: ['WECA grant'] },
    before: [],
    lines: [{ speaker: 'Them', text: 'Leca and self gloss' }],
  };

  it('prompt carries glossary, context and the lines, and forbids rephrasing', () => {
    const p = buildCorrectionPrompt(input);
    expect(p).toContain('South Glos: self gloss');
    expect(p).toContain('WECA grant');
    expect(p).toContain('Leca and self gloss');
    expect(p).toContain('exactly 1 strings');
    expect(p).toContain('Do not rephrase');
  });

  it('parses fenced arrays and rejects a wrong count or non-array', () => {
    expect(parseCorrections('```json\n["a","b"]\n```', 2)).toEqual(['a', 'b']);
    expect(() => parseCorrections('["a"]', 2)).toThrow(/expected 2/);
    expect(() => parseCorrections('nope', 1)).toThrow(/no JSON array/);
  });

  it('runs on the cheap model and returns the corrected lines', async () => {
    const sdkBackend = createMockSdkBackend();
    sdkBackend.enqueue([
      { type: 'assistant', content: '["WECA and South Glos"]' },
      { type: 'result', sessionId: 's' },
    ]);
    const correct = makeMeetingCorrector({
      sdkBackend,
      runOnAccountWithCredit: async (_l, fn) => fn('tok'),
      cwd: '/tmp',
      model: () => 'claude-sonnet-5',
    });
    expect(await correct(input)).toEqual(['WECA and South Glos']);
    expect(sdkBackend.lastOptions()?.model).toBe('claude-sonnet-5');
  });
});
