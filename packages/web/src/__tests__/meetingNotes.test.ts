import { describe, expect, it } from 'vitest';
import { addMeetingNote, editMeetingNote, parseMeetingNotes } from '../lib/meetingNotes.js';

describe('meeting notes', () => {
  it('reads timed lines, and an untimed line as written at the start', () => {
    expect(parseMeetingNotes('old note\n08:20 ask Marco\n\n1:02:03 late one')).toEqual([
      { index: 0, at: 0, text: 'old note' },
      { index: 1, at: 500_000, text: 'ask Marco' },
      { index: 3, at: 3_723_000, text: 'late one' },
    ]);
  });

  it('appends a note with the meeting time, on one line', () => {
    expect(addMeetingNote('', 65_000, 'first')).toBe('01:05 first');
    expect(addMeetingNote('01:05 first\n', 130_000, ' two\nlines ')).toBe(
      '01:05 first\n02:10 two lines',
    );
  });

  it('rewrites a note in place keeping its time, and removes it when emptied', () => {
    const notes = '01:05 first\n02:10 second';
    expect(editMeetingNote(notes, 1, 'changed')).toBe('01:05 first\n02:10 changed');
    expect(editMeetingNote(notes, 0, '  ')).toBe('02:10 second');
    expect(() => editMeetingNote(notes, 5, 'x')).toThrow('no note on line 5');
  });
});
