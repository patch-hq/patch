// Notes to the agent (spec/04 § Notes to the agent, principles.md § No hidden
// prompt content). Patch tells a chat's agent about things that happened
// outside its turns — a rewritten task list, a goal, a hook's advice — as a
// labelled block of plain text at the front of the next turn's message. The
// block is not hidden markup: the record shows each one as its own `chat.note`
// entry carrying exactly the text the model was sent.

export interface NoteItem {
  label: string;
  text: string;
}

const NOTE_END = '[End note]';
const NOTE_END_ESCAPED = '[End note (escaped)]';

/** Body text made safe to sit inside a note: the end line cannot appear in it. */
export function escapeNoteText(text: string): string {
  return text.split(NOTE_END).join(NOTE_END_ESCAPED);
}

/** Undo `escapeNoteText`. */
export function unescapeNoteText(text: string): string {
  return text.split(NOTE_END_ESCAPED).join(NOTE_END);
}

/** The line that closes a finished note block. */
export const NOTE_END_LINE = NOTE_END;

/** A note ready to go in front of a turn's message: header line, body, end line. */
export function noteBlock(label: string, body: string): string {
  if (label.length === 0 || /[\]\n]/.test(label)) {
    throw new Error(`notes: label must be non-empty, single-line and free of "]": ${label}`);
  }
  return `[Note: ${label}]\n${escapeNoteText(body)}\n${NOTE_END}\n\n`;
}

const NOTE_RE = /^\[Note: ([^\]\n]+)\]\n([\s\S]*?)\n\[End note\]\s*/;

/**
 * Every leading note block of `text`, in order, and what follows them. Only
 * leading blocks count: the same words in the middle of a message are the
 * user's own text.
 */
export function splitLeadingNotes(text: string): { notes: NoteItem[]; rest: string } {
  const notes: NoteItem[] = [];
  let rest = text;
  for (;;) {
    const match = NOTE_RE.exec(rest);
    if (!match) break;
    const body = unescapeNoteText(match[2] ?? '');
    if (body.trim().length > 0) notes.push({ label: match[1] ?? '', text: body });
    rest = rest.slice(match[0].length);
  }
  return { notes, rest };
}

/** The notes at the front of a prompt, for the `chat.note` entries that precede its message. */
export function extractNotes(prompt: string): NoteItem[] {
  return splitLeadingNotes(prompt).notes;
}
