// Tom's notes during a meeting, kept in the meeting's `myNotes` text so every
// surface (and the write-up) reads them as before: one note per line, each
// starting with the meeting time it was written ("08:20 ask Marco re datadog").
// A line without a time (typed before notes were timed) belongs at the start.

import { formatMeetingClock } from '@patch/wire';

export interface MeetingNote {
  /** Line index in `myNotes`: stable enough to edit one note in place. */
  index: number;
  /** Meeting time in ms. */
  at: number;
  text: string;
}

const TIMED = /^(?:(\d+):)?(\d{1,2}):(\d{2}) (.*)$/;

export function parseMeetingNotes(myNotes: string): MeetingNote[] {
  const out: MeetingNote[] = [];
  myNotes.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    const m = TIMED.exec(line);
    if (!m) {
      out.push({ index, at: 0, text: line.trim() });
      return;
    }
    const at = ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
    out.push({ index, at, text: m[4]!.trim() });
  });
  return out;
}

/** `myNotes` with a new note written at meeting time `at`. */
export function addMeetingNote(myNotes: string, at: number, text: string): string {
  const line = `${formatMeetingClock(at)} ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
  return myNotes.trim() === '' ? line : `${myNotes.replace(/\n+$/, '')}\n${line}`;
}

/** `myNotes` with the note on line `index` rewritten; empty text removes it. */
export function editMeetingNote(myNotes: string, index: number, text: string): string {
  const lines = myNotes.split('\n');
  const old = lines[index];
  if (old === undefined) throw new Error(`no note on line ${index}`);
  const m = TIMED.exec(old);
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  if (clean === '') lines.splice(index, 1);
  else lines[index] = m ? `${old.slice(0, old.length - m[4]!.length)}${clean}` : clean;
  return lines.join('\n');
}
