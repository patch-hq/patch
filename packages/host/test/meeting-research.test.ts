// Meeting mode v2 (5/8): the agent feed. Live research cards (throttled, deduped,
// every figure sourced) and the chat agent changing the notes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  MeetingAgentNotesEdit,
  meetingCardProblem,
} from '@patch/wire';
import {
  MeetingManager,
  MeetingResearchResult,
  type AnalyseInput,
  type MeetingAnalysis,
  type ResearchInput,
} from '../src/meeting.js';
import { buildResearchPrompt, makeMeetingResearcher, parseResearch } from '../src/meetingGen.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { createMetaStore } from '../src/meta.js';

const logger = pino({ level: 'silent' });
const PROMPTS = {
  now: DEFAULT_MEETING_NOW_PROMPT,
  notes: DEFAULT_MEETING_NOTES_PROMPT,
  actions: DEFAULT_MEETING_ACTIONS_PROMPT,
};
const analysis = (): MeetingAnalysis => ({
  now: { headline: 'Ferry timetable', bullets: [], who: 'Sam' },
  topics: [
    { id: null, title: 'Sam: the ferry should run hourly', points: ['Cheaper'], atSeconds: 5 },
  ],
  actions: [],
  summary: null,
});
const card = (title: string, over: Record<string, unknown> = {}) => ({
  kind: 'explained' as const,
  title,
  atSeconds: 12,
  bullets: ['A plain explanation'],
  ...over,
});
const SRC = { name: 'Harbour authority', url: 'https://example.org/timetable' };

describe('research cards', () => {
  let dir: string;
  let clock: number;
  let n: number;
  let research: ReturnType<typeof vi.fn<(i: ResearchInput) => Promise<MeetingResearchResult>>>;
  let transcribe: ReturnType<typeof vi.fn<(b: Buffer) => Promise<string>>>;
  let gap: number;
  let m: MeetingManager;

  const say = async (text: string): Promise<void> => {
    transcribe.mockResolvedValueOnce(text);
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
  };
  const pass = async (): Promise<void> => {
    await m.tick('c1');
    await m.settleResearch('c1');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meeting-research-'));
    clock = 1_000_000;
    n = 0;
    gap = 60;
    research = vi.fn(async () => ({ cards: [] }));
    transcribe = vi.fn(async () => 'x');
    m = new MeetingManager({
      dir,
      transcribe,
      analyse: vi.fn(async (_i: AnalyseInput) => analysis()),
      research,
      researchSeconds: () => gap,
      prompts: () => PROMPTS,
      startChat: async () => 'child',
      logger,
      emit: () => undefined,
      now: () => clock,
      newId: () => `id${++n}`,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('researches new lines after an analysis pass and shows the card', async () => {
    m.start('c1');
    await say('We should explain the harbour levy');
    research.mockResolvedValueOnce({ cards: [card('Harbour levy')] });
    await pass();
    expect(research).toHaveBeenCalledOnce();
    expect(research.mock.calls[0]![0].lines[0]!.text).toContain('harbour levy');
    expect(m.get('c1')?.cards).toMatchObject([
      { id: 'id2', kind: 'explained', title: 'Harbour levy', at: 12000 },
    ]);
  });

  it('runs at most once per gap, keeps the waiting lines, and researches them when the gap is up', async () => {
    m.start('c1');
    await say('first thing');
    await pass();
    await say('second thing');
    clock += 30_000;
    await pass();
    expect(research).toHaveBeenCalledOnce();
    clock += 31_000;
    await pass();
    expect(research).toHaveBeenCalledTimes(2);
    expect(research.mock.calls[1]![0].lines.map((l) => l.text)).toEqual(['second thing']);
  });

  it('reads the gap fresh, so a Settings change applies mid-meeting', async () => {
    m.start('c1');
    await say('one');
    await pass();
    await say('two');
    clock += 20_000;
    gap = 15;
    await pass();
    expect(research).toHaveBeenCalledTimes(2);
  });

  it('does not research again what is already a card, and tells the model what exists', async () => {
    m.start('c1');
    await say('about the levy');
    research.mockResolvedValueOnce({ cards: [card('Harbour levy')] });
    await pass();
    await say('the levy again');
    clock += 61_000;
    research.mockResolvedValueOnce({ cards: [card('harbour  LEVY'), card('Tidal gate')] });
    await pass();
    expect(research.mock.calls[1]![0].existing).toEqual(['Harbour levy']);
    expect(m.get('c1')?.cards?.map((c) => c.title)).toEqual(['Harbour levy', 'Tidal gate']);
  });

  it('never shows a figure without a source, and says so where the feed is', async () => {
    m.start('c1');
    await say('it costs about fifty');
    research.mockResolvedValueOnce({
      cards: [
        card('Levy cost', { bullets: ['It costs £50m'] }),
        card('Tidal gate', { bullets: ['It costs £50m'], source: SRC }),
      ],
    });
    await pass();
    const s = m.get('c1')!;
    expect(s.cards?.map((c) => c.title)).toEqual(['Tidal gate']);
    expect(s.researchError).toContain('"Levy cost": a figure is stated without a source');
  });

  it('a fact check needs a verdict, and a Correct or Off verdict needs its source; Unclear does not', () => {
    const fact = { kind: 'fact' as const, title: '"fifty"', bullets: ['Says why'] };
    expect(meetingCardProblem(fact)).toMatch(/needs a verdict/);
    expect(meetingCardProblem({ ...fact, verdict: 'off' })).toMatch(/needs the source/);
    expect(meetingCardProblem({ ...fact, verdict: 'off', source: SRC })).toBeNull();
    expect(meetingCardProblem({ ...fact, verdict: 'unclear' })).toBeNull();
    expect(meetingCardProblem({ ...fact, kind: 'answer', verdict: 'correct' })).toMatch(
      /only a fact check/,
    );
    expect(meetingCardProblem({ ...fact, bullets: [] })).toMatch(/1 to 3/);
    expect(
      meetingCardProblem({ ...fact, verdict: 'unclear', bullets: ['a', 'b', 'c', 'd'] }),
    ).toMatch(/1 to 3/);
  });

  it('a failed research pass is put on the panel, not swallowed, and retried after the gap', async () => {
    m.start('c1');
    await say('the levy');
    research.mockRejectedValueOnce(new Error('search is down'));
    await pass();
    expect(m.get('c1')?.researchError).toBe('research failed: search is down');
    clock += 61_000;
    research.mockResolvedValueOnce({ cards: [card('Harbour levy')] });
    await pass();
    expect(research.mock.calls[1]![0].lines.map((l) => l.text)).toEqual(['the levy']);
    expect(m.get('c1')).toMatchObject({ researchError: null });
    expect(m.get('c1')?.cards).toHaveLength(1);
  });

  it('does nothing while the checkbox is off, and starts from now when it is turned on', async () => {
    m.start('c1');
    m.setResearch('c1', false);
    await say('unresearched talk');
    await pass();
    expect(research).not.toHaveBeenCalled();
    m.setResearch('c1', true);
    await pass();
    expect(research).not.toHaveBeenCalled();
    await say('fresh talk');
    await pass();
    expect(research.mock.calls[0]![0].lines.map((l) => l.text)).toEqual(['fresh talk']);
  });

  it('keeps cards across a restart and the research position with them', async () => {
    m.start('c1');
    await say('the levy');
    research.mockResolvedValueOnce({ cards: [card('Harbour levy')] });
    await pass();
    const again = new MeetingManager({
      dir,
      transcribe,
      analyse: vi.fn(async () => analysis()),
      research,
      prompts: () => PROMPTS,
      startChat: async () => 'x',
      logger,
      emit: () => undefined,
      now: () => clock,
    });
    expect(again.get('c1')?.cards?.map((c) => c.title)).toEqual(['Harbour levy']);
    expect(again.get('c1')?.researchOn).toBe(true);
  });

  it('puts cards and their sources in the chat context so the agent can use them', async () => {
    m.start('c1');
    await say('the levy');
    research.mockResolvedValueOnce({
      cards: [card('Harbour levy', { bullets: ['Charged per ship, 3 bands'], source: SRC })],
    });
    await pass();
    const ctx = m.contextFor('c1')!;
    expect(ctx).toContain('Harbour levy');
    expect(ctx).toContain(SRC.url);
    expect(ctx).toContain('[id1]');
    expect(ctx).toContain('patch_meeting_notes');
  });
});

describe('the chat agent changing the notes', () => {
  let dir: string;
  let m: MeetingManager;
  let n = 0;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'meeting-agent-'));
    n = 0;
    m = new MeetingManager({
      dir,
      transcribe: async () => 'Sam wants an hourly ferry',
      analyse: async () => analysis(),
      prompts: () => PROMPTS,
      startChat: async () => 'x',
      logger,
      emit: () => undefined,
      now: () => 5_000,
      newId: () => `id${++n}`,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds a point as the user's own, with the chip label", () => {
    const label = m.agentEdit('c1', {
      op: 'add_point',
      title: 'Tom: ask who drafts the offer',
      bullets: ['Nobody has picked it up'],
    });
    expect(label).toBe('Added to points');
    const s = m.get('c1')!;
    expect(s.topics.at(-1)).toMatchObject({ title: 'Tom: ask who drafts the offer', fixed: true });
    expect(s.agentEdits).toMatchObject([{ label: 'Added to points', at: 5000 }]);
  });

  it('edits a point, adds sourced research to it, and edits the summary', () => {
    const id = m.get('c1')!.topics[0]!.id;
    expect(
      m.agentEdit('c1', { op: 'edit_point', topicId: id, title: 'Sam: hourly, not daily' }),
    ).toBe('Edited a point');
    expect(
      m.agentEdit('c1', {
        op: 'add_research',
        topicId: id,
        bullets: ['Runs 6 sailings a day today'],
        source: SRC,
      }),
    ).toBe('Added research to points');
    expect(m.agentEdit('c1', { op: 'set_summary', headline: 'Ferry', bullets: ['Hourly'] })).toBe(
      'Edited the summary',
    );
    const s = m.get('c1')!;
    expect(s.topics[0]).toMatchObject({ title: 'Sam: hourly, not daily', fixed: true });
    expect(s.topics[0]!.points.at(-1)).toBe(
      `Runs 6 sailings a day today (${SRC.name}: ${SRC.url})`,
    );
    expect(s.summary).toEqual({ headline: 'Ferry', bullets: ['Hourly'] });
    expect(s.agentEdits?.map((e) => e.label)).toEqual([
      'Edited a point',
      'Added research to points',
      'Edited the summary',
    ]);
  });

  it('refuses a figure with no source, an unknown point, and an edit that changes nothing', () => {
    const id = m.get('c1')!.topics[0]!.id;
    expect(() =>
      m.agentEdit('c1', { op: 'add_research', topicId: id, bullets: ['It carries 40 cars'] }),
    ).toThrow(/figure is stated without a source/);
    expect(() => m.agentEdit('c1', { op: 'edit_point', topicId: 'nope', title: 'x' })).toThrow(
      /no point nope/,
    );
    expect(() => m.agentEdit('c1', { op: 'edit_point', topicId: id })).toThrow(/needs a title/);
    expect(() => m.agentEdit('zz', { op: 'set_summary', headline: 'x', bullets: [] })).toThrow(
      /no meeting/,
    );
    expect(m.get('c1')?.agentEdits).toEqual([]);
  });

  it('an agent-added point survives the next analysis pass', async () => {
    m.agentEdit('c1', { op: 'add_point', title: 'Tom: mine' });
    await m.ingestAudio('c1', 'mic', Buffer.from('b'));
    await m.tick('c1');
    expect(m.get('c1')!.topics.some((t) => t.title === 'Tom: mine')).toBe(true);
  });

  it('the edit schema takes only the four operations', () => {
    expect(MeetingAgentNotesEdit.safeParse({ op: 'delete_all' }).success).toBe(false);
    expect(MeetingAgentNotesEdit.safeParse({ op: 'add_point', title: '' }).success).toBe(false);
  });
});

describe('the researcher', () => {
  it('asks for sourced cards of three kinds from the new lines only', () => {
    const p = buildResearchPrompt({
      chatId: 'c',
      lines: [{ clock: '01:00', speaker: 'Sam', text: 'about the harbour levy' }],
      existing: ['Tidal gate'],
      context: { now: 'Ferries' },
    });
    expect(p).toContain('[01:00 Sam] about the harbour levy');
    expect(p).toContain('Tidal gate');
    expect(p).toMatch(/NEVER state a figure/);
    expect(p).toContain('"unclear"');
    expect(p).toContain('"verdict":"correct | off | unclear');
    expect(p).not.toContain('"verdict":"fact only"');
  });

  it('rejects a verdict outside correct, off, unclear rather than papering over it', () => {
    expect(() =>
      parseResearch(
        '{"cards":[{"kind":"fact","title":"x","bullets":["y"],"verdict":"explained"}]}',
      ),
    ).toThrow(/verdict/);
  });

  it('parses fenced JSON and rejects a malformed reply', () => {
    expect(parseResearch('```json\n{"cards":[]}\n```')).toEqual({ cards: [] });
    expect(() => parseResearch('nothing')).toThrow(/no JSON/);
    expect(() =>
      parseResearch('{"cards":[{"kind":"gossip","title":"x","bullets":["y"]}]}'),
    ).toThrow();
  });

  it('runs the research profile on the chosen model and reads the last message as the answer', async () => {
    const sdkBackend = createMockSdkBackend();
    sdkBackend.enqueue([
      { type: 'assistant', content: 'Let me search for that.' },
      { type: 'assistant', content: '{"cards":[]}' },
      { type: 'result', sessionId: 's' },
    ]);
    const run = makeMeetingResearcher({
      sdkBackend,
      runOnAccountWithCredit: async (_l, fn) => fn('tok'),
      cwd: '/tmp',
      model: () => 'claude-sonnet-5',
    });
    expect(await run({ chatId: 'c', lines: [], existing: [], context: { now: null } })).toEqual({
      cards: [],
    });
    expect(sdkBackend.lastOptions()?.inferenceProfile).toBe('research');
    expect(sdkBackend.lastOptions()?.model).toBe('claude-sonnet-5');
  });

  it('throws when no account can run it', async () => {
    const run = makeMeetingResearcher({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: async () => null,
      cwd: '/tmp',
      model: () => 'm',
    });
    await expect(
      run({ chatId: 'c', lines: [], existing: [], context: { now: null } }),
    ).rejects.toThrow(/no account/);
  });
});

describe('POST /internal/meeting-notes', () => {
  const AUTH = { authorization: 'Bearer k' };
  async function setup(edit: (chatId: string, e: MeetingAgentNotesEdit) => string) {
    const home = mkdtempSync(join(tmpdir(), 'patch-mn-'));
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'x',
      emit: () => undefined,
      logger,
      now: () => 1_700_000_000_000,
    });
    return buildControl({ localKey: 'k', daemon, meetingAgentEdit: edit });
  }
  type MeetingAgentNotesEdit = import('@patch/wire').MeetingAgentNotesEdit;

  it('hands a valid edit to the meeting and returns the chip label', async () => {
    const edit = vi.fn(() => 'Added to points');
    const app = await setup(edit);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/meeting-notes',
      headers: AUTH,
      payload: { callerChatId: 'c1', edit: { op: 'add_point', title: 'Tom: x' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, changed: 'Added to points' });
    expect(edit).toHaveBeenCalledWith('c1', { op: 'add_point', title: 'Tom: x' });
  });

  it('refuses a malformed edit (400) and reports a meeting refusal to the agent (409)', async () => {
    const app = await setup(() => {
      throw new Error('chat c1 has no meeting');
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/internal/meeting-notes',
      headers: AUTH,
      payload: { callerChatId: 'c1', edit: { op: 'nope' } },
    });
    expect(bad.statusCode).toBe(400);
    const refused = await app.inject({
      method: 'POST',
      url: '/internal/meeting-notes',
      headers: AUTH,
      payload: { callerChatId: 'c1', edit: { op: 'set_summary', headline: 'x', bullets: [] } },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe('chat c1 has no meeting');
  });
});
