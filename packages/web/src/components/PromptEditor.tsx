// The job action's Prompt box (spec/08 ## Action). A prompt runs to several
// paragraphs of markdown, so the plain textarea gains two things: a Preview
// tab that renders it as markdown, and a find bar that counts matches and
// steps through them by selecting each in the textarea. The textarea stays the
// single source of truth; Preview is read-only.

import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './Markdown.js';

/** Start offsets of every case-insensitive occurrence of `query` in `text`. */
export function findMatches(text: string, query: string): number[] {
  if (query === '') return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    out.push(i);
  }
  return out;
}

export function PromptEditor({
  value,
  onChange,
  testid,
}: {
  value: string;
  onChange: (next: string) => void;
  testid: string;
}): JSX.Element {
  const [preview, setPreview] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => findMatches(value, query), [value, query]);
  const current = matches.length === 0 ? -1 : Math.min(index, matches.length - 1);

  const select = (i: number): void => {
    const area = areaRef.current;
    const at = matches[i];
    if (area === null || at === undefined) return;
    area.setSelectionRange(at, at + query.length);
    // A selection scrolls into view only while the textarea has focus.
    area.focus();
    const line = value.slice(0, at).split('\n').length - 1;
    area.scrollTop = Math.max(0, line * 24 - area.clientHeight / 2);
    findRef.current?.focus();
  };

  const step = (dir: 1 | -1): void => {
    if (matches.length === 0) return;
    const next = (current + dir + matches.length) % matches.length;
    setIndex(next);
    select(next);
  };

  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);

  const closeFind = (): void => {
    setFindOpen(false);
    setQuery('');
    setIndex(0);
  };

  return (
    <div className="prompt-editor" data-testid={`${testid}-editor`}>
      <div className="prompt-editor-bar">
        <div role="tablist" className="prompt-editor-tabs">
          <button
            type="button"
            role="tab"
            aria-selected={!preview}
            data-testid={`${testid}-write`}
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={preview}
            data-testid={`${testid}-preview-tab`}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>
        {!preview ? (
          <button
            type="button"
            aria-expanded={findOpen}
            data-testid={`${testid}-find-toggle`}
            onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
          >
            Find
          </button>
        ) : null}
      </div>
      {findOpen && !preview ? (
        <div className="prompt-editor-find" data-testid={`${testid}-find`}>
          <input
            ref={findRef}
            value={query}
            placeholder="Find in prompt"
            aria-label="Find in prompt"
            data-testid={`${testid}-find-input`}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // Enter steps through matches; it must not submit the job form.
                e.preventDefault();
                e.stopPropagation();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
          <span data-testid={`${testid}-find-count`}>
            {query === ''
              ? ''
              : matches.length === 0
                ? 'No matches'
                : `${current + 1} of ${matches.length}`}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            data-testid={`${testid}-find-prev`}
            onClick={() => step(-1)}
          >
            Prev
          </button>
          <button
            type="button"
            aria-label="Next match"
            data-testid={`${testid}-find-next`}
            onClick={() => step(1)}
          >
            Next
          </button>
        </div>
      ) : null}
      {/* The textarea stays mounted under Preview so its scroll and selection survive. */}
      <textarea
        ref={areaRef}
        className="job-prompt"
        rows={12}
        hidden={preview}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            e.stopPropagation();
            setFindOpen(true);
            findRef.current?.focus();
          }
        }}
        data-testid={testid}
      />
      {preview ? (
        <div className="prompt-editor-preview" data-testid={`${testid}-preview`}>
          {value.trim() === '' ? null : <Markdown content={value} />}
        </div>
      ) : null}
    </div>
  );
}
