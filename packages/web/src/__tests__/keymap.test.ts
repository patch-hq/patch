import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIONS,
  chordFor,
  chordToGlyphs,
  loadOverrides,
  matchesAction,
  parseChord,
  recordChord,
  sameChord,
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

describe('recording Ctrl on a Mac', () => {
  it('a Ctrl-only chord is recorded as ctrl, not mod', () => {
    const chord = recordChord(ev({ code: 'KeyY', key: 'y', ctrlKey: true, altKey: true }), true)!;
    expect(chord.mod).toBe(false);
    expect(chord.ctrl).toBe(true);
    expect(chordToGlyphs(chord)).toBe('⌃⌥Y');
    expect(
      matchesAction(ev({ code: 'KeyY', key: 'y', ctrlKey: true, altKey: true }), 'newChat', {
        newChat: chord,
      }),
    ).toBe(true);
    expect(
      matchesAction(ev({ code: 'KeyY', key: 'y', metaKey: true, altKey: true }), 'newChat', {
        newChat: chord,
      }),
    ).toBe(false);
  });

  it('records ⌘ as mod on a Mac, and Ctrl as mod off a Mac', () => {
    expect(recordChord(ev({ code: 'KeyY', key: 'y', metaKey: true }), true)!.mod).toBe(true);
    const win = recordChord(ev({ code: 'KeyY', key: 'y', ctrlKey: true }), false)!;
    expect(win.mod).toBe(true);
    expect(win.ctrl).toBe(false);
  });

  it('sameChord tells ⌘K from Ctrl+K', () => {
    const cmd = recordChord(ev({ code: 'KeyK', key: 'k', metaKey: true }), true)!;
    const ctrl = recordChord(ev({ code: 'KeyK', key: 'k', ctrlKey: true }), true)!;
    expect(sameChord(cmd, ctrl)).toBe(false);
    expect(sameChord(cmd, cmd)).toBe(true);
  });
});
