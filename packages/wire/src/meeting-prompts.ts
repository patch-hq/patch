// The three instruction blocks of the meeting-mode analysis prompt (host
// meetingGen.ts). Each is an account preference, editable under Settings →
// Prompts → Meetings or from the meeting panel mid-call; the rest of the
// prompt (speaker identity, the JSON shape) is fixed so the reply stays parseable.

export const DEFAULT_MEETING_NOW_PROMPT = `"now": a one-line headline on what is being discussed right now, at most 3 short bullets, and who has been speaking (or empty).`;

export const DEFAULT_MEETING_NOTES_PROMPT = `"topics": each point must state the main thrust of what a speaker said (their claim, position, decision or ask), not just the subject being discussed. Points within and across topics must be distinct: never repeat or rephrase a point already in the notes; fold new detail into the existing point instead.
Detail tapers with age: recent topics get fuller points; older topics (by atSeconds, against the meeting time so far) get shorter and higher level, so re-send an older topic with its id and fewer, broader points as it recedes. Keep enough to answer "what did that person say 20 minutes ago".
Only list topics that appear in the transcript; return only topics that are new, changed or condensed; set decided true only when the meeting clearly agreed something.`;

export const DEFAULT_MEETING_ACTIONS_PROMPT = `"actions": things that are genuinely Tom's to do, or that an assistant could do for him (look something up, create a ticket, send a message, top up credit), implied or asked for, never ones already in the notes. Not every mention of a person or plan is an action: skip things someone else's to do, things nobody can act on, and general plans or discussion; use [] when there are none.`;

/** The model the live notes and the clean-up pass run on until Settings → Prompts → Meetings picks another. */
export const DEFAULT_MEETING_MODEL = 'claude-haiku-4-5-20251001';
