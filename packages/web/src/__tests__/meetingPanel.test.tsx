// spec/14 § Meeting mode — the pieces of the meeting panel that can be checked
// without a browser: the order of Notes, the meeting's switches in settings,
// and the Actions tab's groups.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MeetingCard, MeetingState, MeetingTopic } from '@patch/wire';
import { MeetingActions, MeetingSwitches, notesItems } from '../components/MeetingPanel.js';

const topic = (id: string, at: number): MeetingTopic =>
  ({ id, at, title: id, points: [], decided: false }) as MeetingTopic;
const card = (id: string, at: number): MeetingCard =>
  ({ id, at, kind: 'explained', key: id, title: id, bullets: ['x'] }) as MeetingCard;
const ids = (items: ReturnType<typeof notesItems>) =>
  items.map((i) => (i.kind === 'point' ? `p:${i.topic.id}` : `c:${i.card.id}`));

describe('notesItems', () => {
  it('puts points and research cards together, oldest first', () => {
    const out = notesItems(
      [topic('late', 30_000), topic('early', 1_000), topic('mid', 10_000)],
      [card('k1', 12_000), card('k0', 500), card('k2', 31_000)],
    );
    expect(ids(out)).toEqual(['c:k0', 'p:early', 'p:mid', 'c:k1', 'p:late', 'c:k2']);
  });

  it('is empty with nothing said yet', () => {
    expect(notesItems([], [])).toEqual([]);
  });
});

function meeting(status: 'live' | 'ended', actions: MeetingState['actions'] = []): MeetingState {
  return {
    status,
    transcript: [],
    researchOn: true,
    agentRunsActions: false,
    actions,
  } as unknown as MeetingState;
}

describe('MeetingSwitches', () => {
  afterEach(cleanup);

  it('offers research and the agent running its own actions while the meeting is on', () => {
    render(<MeetingSwitches chatId="c1" meeting={meeting('live')} />);
    const research = screen.getByTestId('meeting-research-on') as HTMLInputElement;
    expect(research.checked).toBe(true);
    expect(research.disabled).toBe(false);
    expect(screen.getByLabelText('Agent does its own actions')).toBeTruthy();
  });

  it('locks research and drops the agent switch once the meeting has ended', () => {
    render(<MeetingSwitches chatId="c1" meeting={meeting('ended')} />);
    expect((screen.getByTestId('meeting-research-on') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('meeting-agent-runs')).toBeNull();
  });
});

describe('MeetingActions (the Actions tab)', () => {
  afterEach(cleanup);
  const acts = [
    { id: 'a1', kind: 'mine', title: 'Top up credit', at: 1, status: 'pending' },
    { id: 'a2', kind: 'agent', title: 'Find dates', at: 2, status: 'pending' },
    { id: 'a3', kind: 'other', owner: 'Priya', title: 'Gone', at: 3, status: 'dismissed' },
  ] as unknown as MeetingState['actions'];
  const show = (m: MeetingState) =>
    render(
      <MemoryRouter>
        <MeetingActions chatId="c1" meeting={m} />
      </MemoryRouter>,
    );
  const groups = () =>
    [...document.querySelectorAll('.mm-act-grp')].map((e) => e.textContent ?? '');

  it('groups open actions Mine / Agent while live, leaving out dismissed ones and empty groups', () => {
    show(meeting('live', acts));
    expect(groups()).toEqual(['Mine', 'Agent']);
    expect(screen.getAllByTestId('meeting-action')).toHaveLength(2);
  });

  it('groups them Agent did / My actions once ended', () => {
    show(meeting('ended', acts));
    expect(groups()).toEqual(['Agent did', 'My actions']);
  });

  it('says so when there are none', () => {
    show(meeting('live'));
    expect(screen.getByTestId('meeting-actions').textContent).toContain('No actions yet');
  });
});
