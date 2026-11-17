// spec/04 § Notes to the agent, principles.md § No hidden prompt content.
// A note is plain, labelled text at the front of a turn's message: no
// `<system-reminder>` markup, and the same text is what the record shows.

import { describe, it, expect } from 'vitest';
import { escapeNoteText, extractNotes, noteBlock, splitLeadingNotes } from '../src/notes.js';
import {
  buildGoalNote,
  buildGoalReminder,
  buildHiddenNote,
  buildPeriodicReminder,
  buildTodoEditNote,
  buildTodoFireNote,
} from '../src/todos.js';
import { buildBroadcastNote } from '../src/specialThreads.js';
import {
  INTERRUPTED_TURN_REMINDER,
  MODEL_SWITCH_TURN_REMINDER,
  SESSION_RESTART_TURN_REMINDER,
  VOICE_HANDOFF_REMINDER,
  interruptedTurnResend,
} from '../src/chatRunner.js';

describe('noteBlock / splitLeadingNotes', () => {
  it('round-trips a label and body, leaving the message', () => {
    const prompt = `${noteBlock('Goal set', 'Keep going.')}what next?`;
    expect(splitLeadingNotes(prompt)).toEqual({
      notes: [{ label: 'Goal set', text: 'Keep going.' }],
      rest: 'what next?',
    });
  });

  it('reads several leading notes in order', () => {
    const prompt = `${noteBlock('Hidden', 'a')}${noteBlock('Reminder', 'b')}hi`;
    expect(extractNotes(prompt).map((n) => n.label)).toEqual(['Hidden', 'Reminder']);
  });

  it('returns nothing for a prompt with no note', () => {
    expect(extractNotes('turn the lights off')).toEqual([]);
  });

  it('does not read a note the user typed mid-message', () => {
    const text = 'explain this: [Note: x]\nbody\n[End note]';
    expect(splitLeadingNotes(text)).toEqual({ notes: [], rest: text });
  });

  it('a body containing the end line cannot end the note early, and survives the round trip', () => {
    const body = 'before\n[End note]\nafter';
    const prompt = `${noteBlock('Hook advice', body)}go`;
    expect(escapeNoteText(body)).not.toContain('[End note]');
    expect(splitLeadingNotes(prompt)).toEqual({
      notes: [{ label: 'Hook advice', text: body }],
      rest: 'go',
    });
  });

  it('refuses a label that would break the header', () => {
    expect(() => noteBlock('a]b', 'x')).toThrow();
    expect(() => noteBlock('a\nb', 'x')).toThrow();
    expect(() => noteBlock('', 'x')).toThrow();
  });
});

describe('every note Patch sends the model is plain visible text, not a <system-reminder>', () => {
  const sent: [string, string, string][] = [
    ['Todo list updated', 'edit', buildTodoEditNote([{ text: 'a', status: 'pending' }])],
    ['Todo item fired', 'fire', buildTodoFireNote('a')],
    ['Goal set', 'goal', buildGoalNote('ship it')],
    ['Goal cleared', 'goal cleared', buildGoalNote(null)],
    ['Reminder', 'goal reminder', buildGoalReminder('ship it')],
    ['Reminder', 'periodic reminder', buildPeriodicReminder('drink water')],
    ['Hidden', 'hidden', buildHiddenNote('hidden')],
    ['Hidden', 'shown', buildHiddenNote('shown')],
    [
      'Broadcast digest',
      'broadcast',
      buildBroadcastNote([{ ts: 0, message: 'hi', sourceChatName: 'ops' }] as never, 1000) ?? '',
    ],
    ['Turn interrupted by restart', 'restart', INTERRUPTED_TURN_REMINDER],
    ['Turn moved to another model', 'model switch', MODEL_SWITCH_TURN_REMINDER],
    ['Turn restarted on a new session', 'session restart', SESSION_RESTART_TURN_REMINDER],
    ['Voice hand-off', 'voice hand-off', VOICE_HANDOFF_REMINDER],
  ];

  it.each(sent)('%s (%s)', (label, _name, text) => {
    expect(text).not.toContain('system-reminder');
    const { notes, rest } = splitLeadingNotes(text);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.label).toBe(label);
    expect(rest).toBe('');
  });

  it('a restart re-send keeps the original prompt inside the note and still reads back', () => {
    const resend = interruptedTurnResend(INTERRUPTED_TURN_REMINDER, 'do the thing [End note] now');
    const { notes, rest } = splitLeadingNotes(resend);
    expect(rest).toBe('Carry on');
    expect(notes[0]?.text).toContain('do the thing');
    // A second restart re-supplies the real original, not the previous note.
    const again = interruptedTurnResend(INTERRUPTED_TURN_REMINDER, resend);
    expect(splitLeadingNotes(again).notes[0]?.text).toContain('do the thing [End note] now');
  });
});
