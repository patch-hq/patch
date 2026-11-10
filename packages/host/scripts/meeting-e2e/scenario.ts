// The scripted call for the synthetic meeting test: who says what, the stretches of
// silence and background music that made the 10 Nov meeting invent lines, and the
// facts the notes must come back with. Pure data plus the arithmetic that turns it
// into a timeline; audio.ts voices it, evaluate.ts judges the result.

export type Who = 'owner' | 'priya' | 'marcus';

export interface SpokenLine {
  kind: 'line';
  who: Who;
  text: string;
}
export interface Stretch {
  kind: 'silence' | 'music';
  seconds: number;
}
/** The input device is switched here (a `devicechange`), and the mic re-opens. */
export interface MicSwitch {
  kind: 'mic-switch';
}
export type Step = SpokenLine | Stretch | MicSwitch;

export const PARTICIPANTS = {
  priya: 'Priya Nair',
  marcus: 'Marcus Webb',
} as const;
export const OWNER_LABEL = 'Tom Chambers';
/** The call app whose mic use the scripted detector events imitate. */
export const CALL_APP_BUNDLE = 'com.microsoft.teams2';
export const CALL_APP_NAME = 'Microsoft Teams';

/** Said by the owner as the first thing on every microphone, so each is proven live. */
export const MIC_CHECK = 'Microphone check, one two three.';

export const SCRIPT: Step[] = [
  { kind: 'line', who: 'owner', text: MIC_CHECK },
  {
    kind: 'line',
    who: 'priya',
    text: "Morning everyone, this is the Harbour Street launch review. Let's start with the budget.",
  },
  {
    kind: 'line',
    who: 'marcus',
    text: 'The budget is four hundred and twenty thousand pounds, and we are fifteen thousand under.',
  },
  { kind: 'silence', seconds: 20 },
  { kind: 'mic-switch' },
  { kind: 'music', seconds: 20 },
  {
    kind: 'line',
    who: 'owner',
    text: 'Thanks both. On the schedule, I propose we move the launch to the twelfth of March.',
  },
  {
    kind: 'line',
    who: 'priya',
    text: 'Agreed. Decision made: the launch moves to the twelfth of March.',
  },
  {
    kind: 'line',
    who: 'marcus',
    text: 'Then I will send the revised test plan to everyone by Friday.',
  },
  {
    kind: 'line',
    who: 'priya',
    text: 'Tom, please book the venue for the launch party before the end of this week.',
  },
  { kind: 'line', who: 'owner', text: 'Yes, I will book the venue by Thursday.' },
  {
    kind: 'line',
    who: 'priya',
    text: 'Last item, the security review. Marcus, are the penetration tests finished?',
  },
  {
    kind: 'line',
    who: 'marcus',
    text: 'Not yet. They finish next Tuesday, so the security sign off waits until then.',
  },
  {
    kind: 'line',
    who: 'priya',
    text: 'Okay. Decision: the security sign off is deferred to the following week. Thanks everyone.',
  },
  { kind: 'silence', seconds: 8 },
];

/** Topics the notes must cover: every one needs a hit in the topics, summary or write-up. */
export const EXPECTED_TOPICS: { name: string; pattern: RegExp }[] = [
  { name: 'budget', pattern: /budget|420|four hundred/i },
  { name: 'launch date', pattern: /launch|march|schedule/i },
  { name: 'security', pattern: /security|penetration/i },
];

/** Actions the analysis must propose (title or reason). */
export const EXPECTED_ACTIONS: { name: string; pattern: RegExp }[] = [
  { name: 'Marcus sends the test plan', pattern: /test plan/i },
  { name: 'Tom books the venue', pattern: /venue/i },
];

/** Gap between consecutive steps, seconds. Long enough for the 6 s clip to close on a line. */
export const GAP_SECONDS = 1.5;
/** The owner's microphone restarts from the start of its file at the switch; this is how
 *  much of the file's head the check line takes, so scripted owner speech after the
 *  switch starts at least this far in. */
export const MIC_HEAD_SECONDS = 5;

export interface TimedLine {
  index: number;
  who: Who;
  text: string;
  /** Seconds from the start of the meeting. */
  start: number;
  end: number;
}
export interface TimedStretch {
  kind: 'silence' | 'music';
  start: number;
  end: number;
}
export interface Timeline {
  lines: TimedLine[];
  stretches: TimedStretch[];
  /** Seconds from meeting start at which the mic is switched. */
  switchAt: number;
  totalSeconds: number;
}

/**
 * Lays the script out in time. `durations[i]` is the spoken length in seconds of the
 * i-th line step, in script order. The first owner line (the mic check) sits at 1 s.
 */
export function layout(steps: readonly Step[], durations: readonly number[]): Timeline {
  const lines: TimedLine[] = [];
  const stretches: TimedStretch[] = [];
  let t = 1;
  let spoken = 0;
  let switchAt = -1;
  for (const step of steps) {
    if (step.kind === 'line') {
      const d = durations[spoken];
      if (d === undefined) throw new Error(`no duration for line ${spoken}`);
      lines.push({ index: spoken, who: step.who, text: step.text, start: t, end: t + d });
      spoken += 1;
      t += d + GAP_SECONDS;
    } else if (step.kind === 'mic-switch') {
      switchAt = t;
    } else {
      stretches.push({ kind: step.kind, start: t, end: t + step.seconds });
      t += step.seconds;
    }
  }
  if (spoken !== durations.length) throw new Error('more durations than lines');
  if (switchAt < 0) throw new Error('the script has no mic switch');
  const afterSwitch = lines.filter((l) => l.who === 'owner' && l.start >= switchAt);
  const earliest = afterSwitch[0];
  if (earliest && earliest.start < switchAt + MIC_HEAD_SECONDS) {
    throw new Error(
      'an owner line follows the mic switch too closely: the fresh mic is still on its check line',
    );
  }
  return { lines, stretches, switchAt, totalSeconds: t };
}
