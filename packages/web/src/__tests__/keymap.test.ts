import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIONS,
  chordFor,
  chordToGlyphs,
  loadOverrides,
  matchesAction,
  parseChord,
  recordChord,
  saveOverrides,
} from '../lib/keymap.js';

function ev(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

beforeEach(() => localStorage.clear());

describe('keymap defaults', () => {
  it('round-trips every default through its glyphs', () => {
    expect(chordToGlyphs(parseChord('⌘⇧N'))).toBe('⌘⇧N');
    expect(chordToGlyphs(parseChord('⌘←'))).toBe('⌘←');
    expect(chordToGlyphs(parseChord('⌃Space'))).toBe('⌃Space');
  });

  it('has no two actions on the same default chord', () => {
    const seen = new Set<string>();
    for (const a of ACTIONS) {
      const g = chordToGlyphs(a.default);
      expect(seen.has(g), g).toBe(false);
      seen.add(g);
    }
  });

  it('⌘N does not match ⌘⇧N and vice versa', () => {
    expect(matchesAction(ev({ key: 'n', metaKey: true }), 'newChat', {})).toBe(true);
    expect(matchesAction(ev({ key: 'n', metaKey: true, shiftKey: true }), 'newChat', {})).toBe(
      false,
    );
    expect(
      matchesAction(ev({ key: 'n', metaKey: true, shiftKey: true }), 'newChatPicker', {}),
    ).toBe(true);
  });
});

describe('overrides', () => {
  it('an override replaces the default and only the override matches', () => {
    const chord = recordChord(ev({ code: 'KeyY', key: 'y', metaKey: true, altKey: true }))!;
    const overrides = { newChat: chord };
    expect(
      matchesAction(
        ev({ code: 'KeyY', key: 'y', metaKey: true, altKey: true }),
        'newChat',
        overrides,
      ),
    ).toBe(true);
    expect(matchesAction(ev({ key: 'n', metaKey: true }), 'newChat', overrides)).toBe(false);
    expect(chordToGlyphs(chordFor('newChat', overrides))).toBe('⌘⌥Y');
  });

  it('persists, and a corrupt value throws rather than silently resetting', () => {
    const chord = recordChord(ev({ code: 'KeyY', key: 'y', ctrlKey: true }))!;
    saveOverrides({ newChat: chord });
    expect(loadOverrides()).toEqual({ newChat: chord });
    localStorage.setItem('patch.shortcuts.overrides', '{"nope":{}}');
    expect(() => loadOverrides()).toThrow(/invalid entry/);
    localStorage.setItem('patch.shortcuts.overrides', '[1');
    expect(() => loadOverrides()).toThrow();
  });

  it('recording refuses a bare key and a lone modifier', () => {
    expect(recordChord(ev({ code: 'KeyY', key: 'y' }))).toBeNull();
    expect(recordChord(ev({ code: 'MetaLeft', key: 'Meta', metaKey: true }))).toBeNull();
    expect(recordChord(ev({ code: 'KeyY', key: 'Y', shiftKey: true }))).toBeNull();
  });
});
