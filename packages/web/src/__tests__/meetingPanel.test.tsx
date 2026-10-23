// spec/14 § Meeting mode — the pieces of the meeting panel that can be checked
// without a browser: how the feed files things under topics, how long each
// topic ran, how far back "Just said" reaches, the research switch, and the
// actions list.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MeetingCard, MeetingState, MeetingTopic } from '@patch/wire';
import {
  ActionsList,
  MeetingSwitches,
  feedTopics,
  justSaid,
  topicSpanLabel,
} from '../components/MeetingPanel.js';

const topic = (id: string, at: number): MeetingTopic =>
  ({ id, at, title: id, points: [], decided: false }) as MeetingTopic;
const card = (id: string, at: number): MeetingCard =>
  ({ id, at, kind: 'explained', key: id, title: id, bullets: ['x'] }) as MeetingCard;
const action = (id: string, at: number, status = 'pending') =>
  ({ id, at, kind: 'mine', title: id, why: '', status }) as MeetingState['actions'][number];

describe('feedTopics', () => {
  it('runs each topic until the next starts, the last until now, and files what came up in it', () => {
    const { before, topics } = feedTopics(
      {
        topics: [topic('late', 30_000), topic('early', 1_000), topic('mid', 10_000)],
        cards: [card('k1', 12_000), card('k0', 500), card('k2', 31_000)],
        actions: [action('a1', 2_000), action('gone', 3_000, 'dismissed')],
        myNotes: '00:20 note in mid',
      },
      45_000,
    );
    expect(before.map((i) => i.kind)).toEqual(['card']);
    expect(topics.map((t) => [t.topic.id, t.start, t.end])).toEqual([
      ['early', 1_000, 10_000],
      ['mid', 10_000, 30_000],
      ['late', 30_000, 45_000],
    ]);
    expect(topics.map((t) => t.items.length)).toEqual([1, 2, 1]);
    expect(topics[1]!.items.map((i) => i.kind)).toEqual(['card', 'note']);
  });

  it('is empty with nothing said yet', () => {
    expect(feedTopics({ topics: [], cards: [], actions: [], myNotes: '' }, 0)).toEqual({
      before: [],
      topics: [],
    });
  });
});

describe('topicSpanLabel', () => {
  it('says when a topic ran and for how long, never less than a minute', () => {
    expect(topicSpanLabel(9 * 60_000 + 40_000, 13 * 60_000 + 20_000)).toBe('09:40–13:20 · 4 min');
    expect(topicSpanLabel(0, 10_000)).toBe('00:00–00:10 · 1 min');
  });
});

describe('justSaid', () => {
  const line = (at: number) => ({ at, speaker: 'you' as const, text: String(at) });

  it('reaches back half a minute from the last line', () => {
    const t = [0, 10_000, 40_000, 50_000, 55_000, 60_000, 65_000].map(line);
    expect(justSaid(t).map((l) => l.at)).toEqual([40_000, 50_000, 55_000, 60_000, 65_000]);
  });

  it('never shows fewer than four lines when there are that many', () => {
    const t = [0, 60_000, 120_000, 180_000, 240_000].map(line);
    expect(justSaid(t).map((l) => l.at)).toEqual([60_000, 120_000, 180_000, 240_000]);
  });

  it('is empty before anyone speaks', () => {
    expect(justSaid([])).toEqual([]);
  });
});

function meeting(status: 'live' | 'ended', actions: MeetingState['actions'] = []): MeetingState {
  return {
    status,
    transcript: [{ at: 0, speaker: 'them', name: 'Priya', text: 'hi' }],
    researchOn: true,
    actions,
  } as unknown as MeetingState;
}

describe('MeetingSwitches', () => {
  afterEach(cleanup);

  it('offers the agent researching during the call, and nothing that acts on its own', () => {
    render(<MeetingSwitches chatId="c1" meeting={meeting('live')} />);
    const research = screen.getByTestId('meeting-research-on') as HTMLInputElement;
    expect(research.checked).toBe(true);
    expect(research.disabled).toBe(false);
    expect(screen.getByLabelText('Agent researches during call')).toBeTruthy();
    expect(screen.queryByTestId('meeting-agent-runs')).toBeNull();
  });

  it('locks research once the meeting has ended', () => {
    render(<MeetingSwitches chatId="c1" meeting={meeting('ended')} />);
    expect((screen.getByTestId('meeting-research-on') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('ActionsList', () => {
  afterEach(cleanup);
  const acts = [
    { id: 'a1', kind: 'mine', title: 'Top up credit', why: '', at: 3, status: 'pending' },
    { id: 'a2', kind: 'agent', title: 'Find dates', why: '', at: 1, status: 'pending' },
    { id: 'a3', kind: 'other', owner: 'Dev', title: 'Gone', why: '', at: 2, status: 'dismissed' },
    { id: 'a4', kind: 'other', owner: 'Sam', title: 'Send deck', why: '', at: 4, status: 'done' },
  ] as unknown as MeetingState['actions'];
  const show = (m: MeetingState) =>
    render(
      <MemoryRouter>
        <ActionsList chatId="c1" meeting={m} />
      </MemoryRouter>,
    );

  it('lists every action not dismissed, oldest first, done ones ticked', () => {
    show(meeting('live', acts));
    const rows = screen.getAllByTestId('meeting-action');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['pending', 'pending', 'done']);
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['agent', 'mine', 'other']);
    const ticks = screen.getAllByTestId('meeting-action-done') as HTMLInputElement[];
    expect(ticks.map((t) => t.checked)).toEqual([false, false, true]);
  });

  it('asks for Approve on an agent action, and offers You, Agent and everyone named', () => {
    show(meeting('live', acts));
    expect(screen.getAllByTestId('meeting-action-do')).toHaveLength(1);
    const owner = screen.getAllByTestId('meeting-action-owner')[2] as HTMLSelectElement;
    expect([...owner.options].map((o) => o.textContent)).toEqual([
      'You',
      'Agent',
      'Priya',
      'Dev',
      'Sam',
      'Everyone',
    ]);
    expect(owner.value).toBe('other:Sam');
  });

  it('always offers a way to add one', () => {
    show(meeting('live'));
    expect(screen.queryAllByTestId('meeting-action')).toHaveLength(0);
    expect(screen.getByTestId('meeting-action-add')).toBeTruthy();
  });
});
