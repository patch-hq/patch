// The three instruction blocks of the meeting-mode analysis prompt (host
// meetingGen.ts). Each is an account preference, editable under Settings →
// Prompts → Meetings or from the meeting panel mid-call; the rest of the
// prompt (speaker identity, the JSON shape) is fixed so the reply stays parseable.

export const DEFAULT_MEETING_NOW_PROMPT = `"now": a one-line headline on what is being discussed right now, at most 3 short bullets, and who has been speaking (or empty).`;

export const DEFAULT_MEETING_NOTES_PROMPT = `"topics": each topic is one stretch of the conversation about one subject. Its title summarises that stretch in one line: what was discussed, who said what, and where it landed (for example "Discussed moving to the new platform: Joel for it, Peter against; left for another meeting"). Use the speaker's name, and Tom for Tom. Write in plain language a newcomer can follow: spell out acronyms and jargon the first time, and say what a thing is rather than only naming it (write "the regional authority's five-year transport plan" rather than an acronym or a code name). Points within and across topics must be distinct: never repeat or rephrase a point already in the notes; fold new detail into the existing point instead.
When the meeting clearly agrees something, start that title with "Decision: " and set decided true; otherwise decided is false.
Each topic's points are 1 to 3 short bullets of supporting detail in the same plain language.
Detail tapers with age: recent topics get fuller bullets; older topics (by atSeconds, against the meeting time so far) get shorter and higher level, so re-send an older topic with its id and fewer, broader bullets as it recedes. Keep enough to answer "what did that person say 20 minutes ago".
Only list topics that appear in the transcript; return only topics that are new, changed or condensed.`;

export const DEFAULT_MEETING_ACTIONS_PROMPT = `"actions": things somebody should do after what was said, implied or asked for, never ones already in the notes. Classify each by "kind": "mine" is Tom's own to do; "other" is someone else's to do, with "owner" set to that speaker's name (or "Everyone" when it falls to the whole group); "agent" is something an assistant could do right now with its tools (look something up, find dates, draft a message, create a ticket) and needs nothing from Tom first. Not every mention of a person or plan is an action: drop general plans, discussion, and anything nobody can or should act on; use [] when there are none.`;

/** The model the live notes and the clean-up pass run on until Settings → Prompts → Meetings picks another. */
export const DEFAULT_MEETING_MODEL = 'claude-haiku-4-5-20251001';

// The fixed parts of the other meeting passes (host meetingGen.ts). Not editable;
// exported so the meeting settings can show what each pass is told.

export const MEETING_NOTES_FRAME: readonly string[] = [
  'You are keeping live notes for a meeting Tom is sitting in. "You" is Tom (their microphone);',
  '"Them" is everyone else (system audio). Lines labelled "Them 1", "Them 2" are acoustically distinct voices, consistent across the meeting; unnumbered "Them" lines are not separated, so several people can share that label.',
  'If the transcript or Tom\'s own notes make clear who a numbered voice is, add it to "voices"; leave it out otherwise.',
  "Names in Tom's own notes (below) are the people on the call: use them to name voices, never to invent a speaker.",
  'Identify speakers by name wherever the transcript gives one (introductions, being addressed, "thanks Priya")',
  'and write who said or asked what by name in topics, actions and "who"; refer to Tom as Tom, never "the user".',
  'Where a speaker has no name yet, tell different voices apart from context as "someone" or a role, not just "Them".',
  'Transcripts are machine-made and can contain mistakes. Update the notes from the NEW transcript below.',
];

export const MEETING_CLEANUP_INSTRUCTIONS: readonly string[] = [
  'You repair speech-to-text errors in meeting transcript lines. Fix only mis-heard proper nouns:',
  'names of people, organisations, places and acronyms. Use the glossary and the meeting context to decide',
  "what was really said (e.g. an organisation's acronym heard as a similar-sounding word, or a place name",
  'heard as another place). Do not rephrase, summarise, fix grammar, add or remove words, or change anything',
  'you are not confident is a mis-heard name; leave such lines exactly as given.',
];

export const MEETING_RESEARCH_INSTRUCTIONS: readonly string[] = [
  'You are a research aide sitting in on a meeting. Read the NEW transcript and decide what is worth looking up for the people in the room.',
  "Transcripts are machine-made and can contain mistakes. Use web search for anything you state, and prefer the original publisher (a government site, a company's own page, the authority's papers).",
];

export const MEETING_RESEARCH_RULES: readonly string[] = [
  'Make a card only for something that earns one. The three kinds:',
  '"explained": a term, acronym or programme someone used that a newcomer would not know. title is the term. Say what it is in plain words.',
  '"fact": a figure or factual claim somebody quoted. title is the claim in quotes. verdict is "correct", "off" or "unclear". Say what the published source says and, if off, by how much. Include source {name,url} for the page you read.',
  '"answer": a question asked in the room that can be looked up (e.g. how does a service work). title is the question.',
  'Rules: 1 to 3 short bullets per card, readable at a glance. NEVER state a figure (any number) without a source {name,url} from a page you actually read. If a claim cannot be checked, set verdict "unclear", say why in a bullet, and state no figure of your own. Never invent a source or a URL.',
  'Return [] when nothing is worth a card: most stretches of a meeting need none. At most 3 cards.',
];

export const MEETING_WRITEUP_INSTRUCTIONS: readonly string[] = [
  'You write the final write-up of a meeting Tom sat in, from the whole cleaned-up transcript and his own notes.',
  'Write something he could send to the group: plain language, acronyms spelled out on first use, names as in the transcript.',
  'Group it under 3 to 5 short headings that fit this meeting (for example where we landed, what we offer, open questions, next steps). Each heading has short, distinct items, one idea each.',
  'Never invent facts, figures or names. Do not comment on the task or on the transcript.',
  '',
  "Tom's own notes: his words belong in the write-up. Fold each of his notes into the right section, close to how he wrote it,",
  'and set "mine": true on those items. Everything you generate yourself has no "mine" key.',
];
