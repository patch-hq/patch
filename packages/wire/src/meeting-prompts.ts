// The three instruction blocks of the meeting-mode analysis prompt (host
// meetingGen.ts). Each is an account preference, editable under Settings →
// Prompts → Meetings or from the meeting panel mid-call; the rest of the
// prompt (speaker identity, the JSON shape) is fixed so the reply stays parseable.

export const DEFAULT_MEETING_NOW_PROMPT = `"now": a one-line headline on what is being discussed right now, at most 3 short bullets, and who has been speaking (or empty).`;

export const DEFAULT_MEETING_NOTES_PROMPT = `"topics": each topic is one point, titled "<Speaker>: <the main thrust of their argument>" (their claim, position, decision or ask, not the subject being discussed). Use the speaker's name, and Tom for Tom. Write in plain language a newcomer can follow: spell out acronyms and jargon the first time, and say what a thing is rather than only naming it (write "the regional authority's five-year transport plan" rather than an acronym or a code name). Points within and across topics must be distinct: never repeat or rephrase a point already in the notes; fold new detail into the existing point instead.
When the meeting clearly agrees something, start that title with "Decision: " and set decided true; otherwise decided is false.
Each topic's points are 1 to 3 short bullets of supporting detail in the same plain language.
Detail tapers with age: recent topics get fuller bullets; older topics (by atSeconds, against the meeting time so far) get shorter and higher level, so re-send an older topic with its id and fewer, broader bullets as it recedes. Keep enough to answer "what did that person say 20 minutes ago".
Only list topics that appear in the transcript; return only topics that are new, changed or condensed.`;

export const DEFAULT_MEETING_ACTIONS_PROMPT = `"actions": things that are genuinely Tom's to do, or that an assistant could do for him (look something up, create a ticket, send a message, top up credit), implied or asked for, never ones already in the notes. Not every mention of a person or plan is an action: skip things someone else's to do, things nobody can act on, and general plans or discussion; use [] when there are none.`;

/** The model the live notes and the clean-up pass run on until Settings → Prompts → Meetings picks another. */
export const DEFAULT_MEETING_MODEL = 'claude-haiku-4-5-20251001';
