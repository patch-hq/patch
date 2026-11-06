// Settings → Shortcuts: every keyboard shortcut in one place, each rebindable
// on this host (spec/14 § Keyboard shortcuts → Customising). The rows are
// the actions in lib/keymap.ts plus the dictate chord; the keys that only mean
// something inside one widget (the composer's ↵, a permission card's 1/2/3, Esc
// on a modal) are listed beneath, fixed.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useUiStore } from '../../stores/uiStore.js';
import {
  chordFromEvent,
  chordGlyphs,
  matchesChord as matchesDictate,
} from '../../lib/dictateChord.js';
import {
  ACTIONS,
  chordFor,
  chordToGlyphs,
  matchesChord,
  recordChord,
  type ActionId,
} from '../../lib/keymap.js';
import { SHORTCUT_TABLE, shortcutLabel, shortcutScopeLabel } from '../../lib/shortcuts.js';
import { Group, Row, SettingsPage } from './ui.js';

type Target = ActionId | 'dictate';

export function ShortcutsPage(): JSX.Element {
  const overrides = useUiStore((s) => s.shortcutOverrides);
  const setShortcutChord = useUiStore((s) => s.setShortcutChord);
  const dictate = useUiStore((s) => s.dictateChord);
  const setDictate = useUiStore((s) => s.setDictateChord);
  const [recording, setRecording] = useState<Target | null>(null);
  const [clash, setClash] = useState<string | null>(null);

  // Listens in the capture phase and stops the event there, so the chord being
  // recorded doesn't also fire whatever it is bound to. Esc leaves the old one.
  useEffect(() => {
    if (recording === null) return;
    const target = recording;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      if (target === 'dictate') {
        const next = chordFromEvent(e);
        if (!next) return;
        const owner = ACTIONS.find((a) => matchesChord(e, chordFor(a.id, overrides)));
        if (owner) {
          setClash(`Already used by ${owner.label}`);
          return;
        }
        setDictate(next);
      } else {
        const next = recordChord(e);
        if (!next) return;
        const owner = ACTIONS.find(
          (a) => a.id !== target && matchesChord(e, chordFor(a.id, overrides)),
        );
        if (owner) {
          setClash(`Already used by ${owner.label}`);
          return;
        }
        if (matchesDictate(e, dictate)) {
          setClash('Already used by Dictate');
          return;
        }
        setShortcutChord(target, next);
      }
      setClash(null);
      setRecording(null);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides, dictate, setDictate, setShortcutChord]);

  function change(target: Target): void {
    setClash(null);
    setRecording(recording === target ? null : target);
  }

  const fixed = SHORTCUT_TABLE.filter((r) => !r.ids && !r.dictate);

  return (
    <SettingsPage title="Shortcuts" testid="settings-shortcuts">
      <Group label="Customisable" testid="settings-shortcuts-bindable">
        {ACTIONS.map((a) => {
          const custom = overrides[a.id] !== undefined;
          const active = recording === a.id;
          return (
            <Row key={a.id} title={a.label} testid={`shortcut-row-${a.id}`}>
              <kbd className="set-chord" data-testid={`shortcut-chord-${a.id}`}>
                {active ? 'Press keys…' : shortcutLabel(chordToGlyphs(chordFor(a.id, overrides)))}
              </kbd>
              <button
                type="button"
                className="set-btn"
                data-testid={`shortcut-change-${a.id}`}
                aria-pressed={active}
                onClick={() => change(a.id)}
              >
                {active ? 'Cancel' : 'Change'}
              </button>
              {custom ? (
                <button
                  type="button"
                  className="set-btn"
                  data-testid={`shortcut-reset-${a.id}`}
                  onClick={() => setShortcutChord(a.id, null)}
                >
                  Reset
                </button>
              ) : null}
            </Row>
          );
        })}
        <Row title="Dictate" testid="shortcut-row-dictate">
          <kbd className="set-chord" data-testid="shortcut-chord-dictate">
            {recording === 'dictate' ? 'Press keys…' : shortcutLabel(chordGlyphs(dictate))}
          </kbd>
          <button
            type="button"
            className="set-btn"
            data-testid="shortcut-change-dictate"
            aria-pressed={recording === 'dictate'}
            onClick={() => change('dictate')}
          >
            {recording === 'dictate' ? 'Cancel' : 'Change'}
          </button>
        </Row>
        {clash ? (
          <Row title={<span className="set-error">{clash}</span>} testid="shortcut-clash" />
        ) : null}
      </Group>
      <Group label="Fixed" testid="settings-shortcuts-fixed">
        {fixed.map((r) => (
          <Row key={`${r.keys}-${r.action}`} title={r.action} sub={shortcutScopeLabel(r.scope)}>
            <kbd className="set-chord">{shortcutLabel(r.keys)}</kbd>
          </Row>
        ))}
      </Group>
    </SettingsPage>
  );
}
