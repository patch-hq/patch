// One prompt in Settings: shows the text in force and whether it is Patch's
// default or a custom version; Custom opens it for editing, Default writes the
// built-in text back. Every prompt lives on the page for the feature it drives.

import { useState } from 'react';
import type { JSX } from 'react';
import { Pills } from './ui.js';

type Mode = 'default' | 'custom';

export function PromptRow({
  id,
  title,
  sub,
  defaultText,
  current,
  onSave,
  onDefault,
  allowEmpty = false,
  emptyLabel,
}: {
  id: string;
  title: string;
  sub?: string;
  /** What Patch sends when nothing is customised. */
  defaultText: string;
  /** The text in force; equal to `defaultText` while on the default. */
  current: string;
  onSave: (text: string) => Promise<boolean>;
  onDefault: () => Promise<boolean>;
  /** Saving empty text is meaningful here (it turns the thing off). */
  allowEmpty?: boolean;
  /** Shown in place of empty text, so a blank default still says what it means. */
  emptyLabel?: string;
}): JSX.Element {
  const custom = current !== defaultText;
  const [draft, setDraft] = useState<string | null>(null);
  // Long prompts start folded to a few lines, so a page of them stays scannable.
  const [open, setOpen] = useState(false);
  const shown = current === '' && emptyLabel !== undefined ? emptyLabel : current;
  const long = shown.length > 280 || shown.split('\n').length > 4;
  const editing = draft !== null;
  const mode: Mode = custom || editing ? 'custom' : 'default';

  const choose = (next: Mode): void => {
    if (next === 'custom') {
      setDraft(current);
      return;
    }
    void onDefault().then((ok) => {
      if (ok) setDraft(null);
    });
  };
  const save = (): void => {
    if (draft === null) return;
    void onSave(draft).then((ok) => {
      if (ok) setDraft(null);
    });
  };

  return (
    <div className="set-row stack" data-testid={`prompt-${id}`}>
      <div className="set-row-head">
        <div className="set-row-text">
          <span className="set-row-title">{title}</span>
          {sub !== undefined ? <span className="set-sub">{sub}</span> : null}
        </div>
        {custom && !editing ? (
          <button
            type="button"
            className="set-btn ghost"
            data-testid={`prompt-${id}-edit`}
            onClick={() => setDraft(current)}
          >
            Edit
          </button>
        ) : null}
        <Pills
          label={`${title} version`}
          options={['default', 'custom'] as const}
          labels={{ default: 'Default', custom: 'Custom' }}
          value={mode}
          testid={`prompt-${id}-mode`}
          onChange={choose}
        />
      </div>
      {editing ? (
        <>
          <textarea
            aria-label={title}
            data-testid={`prompt-${id}-text`}
            value={draft}
            rows={10}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="set-actions">
            <button
              type="button"
              className="set-btn ghost"
              data-testid={`prompt-${id}-cancel`}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn primary"
              data-testid={`prompt-${id}-save`}
              disabled={(!allowEmpty && draft.trim() === '') || draft === current}
              onClick={save}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <pre
            className={`${custom ? 'set-pre' : 'set-pre default'}${long && !open ? ' folded' : ''}`}
            data-testid={`prompt-${id}-shown`}
          >
            {shown}
          </pre>
          {long ? (
            <button
              type="button"
              className="set-link"
              aria-expanded={open}
              data-testid={`prompt-${id}-more`}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Show less' : 'Show all'}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
