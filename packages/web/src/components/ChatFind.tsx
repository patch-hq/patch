// Find in this chat (spec/14 § Find in chat). ⌘F over a chat opens this bar;
// it highlights every match in the transcript, Enter / ⇧Enter step through
// them, Esc closes. The browser's own find bar cannot be used here: the
// desktop shell has none, and the transcript is what the user is searching.

import type { JSX, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isEditorFindTarget } from '../lib/searchTarget.js';
import { clearFind, findRanges, paintFind, revealRange, stepIndex } from '../lib/chatFind.js';

export function ChatFind({
  streamRef,
  contentVersion,
  onOpen,
}: {
  streamRef: RefObject<HTMLElement | null>;
  /** Changes whenever the transcript does, so matches are re-collected. */
  contentVersion: number;
  /** Called as the bar opens — the page mounts the whole transcript so every match exists. */
  onOpen?: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(-1);
  const rangesRef = useRef<Range[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        if (isEditorFindTarget(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        onOpenRef.current?.();
        setOpen(true);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    clearFind();
  }, []);

  // Re-collect matches when the query or transcript changes. A new query (or a
  // reopened bar) starts at the first match; the transcript merely growing — a
  // reply streaming in — keeps whichever match the reader had stepped to.
  const searchedRef = useRef<{ open: boolean; query: string }>({ open: false, query: '' });
  useEffect(() => {
    const root = streamRef.current;
    if (!open || root === null) {
      searchedRef.current = { open: false, query: '' };
      return;
    }
    const ranges = findRanges(root, query);
    rangesRef.current = ranges;
    setCount(ranges.length);
    const same = searchedRef.current.open && searchedRef.current.query === query;
    searchedRef.current = { open, query };
    setIndex((i) =>
      ranges.length === 0 ? -1 : same ? Math.min(Math.max(i, 0), ranges.length - 1) : 0,
    );
  }, [open, query, contentVersion, streamRef]);

  useEffect(() => {
    const root = streamRef.current;
    if (!open || root === null) return;
    paintFind(rangesRef.current, index);
    const cur = rangesRef.current[index];
    if (cur !== undefined) revealRange(root, cur);
  }, [open, index, count, streamRef]);

  useEffect(() => clearFind, []);

  if (!open) return null;
  const step = (d: 1 | -1): void => setIndex((i) => stepIndex(i, d, count));
  return (
    <div className="chat-find" data-testid="chat-find" role="search">
      <input
        ref={inputRef}
        data-search-input=""
        data-testid="chat-find-input"
        className="chat-find-input"
        value={query}
        aria-label="Find in chat"
        placeholder="Find in chat"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="chat-find-count" data-testid="chat-find-count">
        {query.trim() === '' ? '' : count === 0 ? '0' : `${index + 1}/${count}`}
      </span>
      <button
        type="button"
        data-testid="chat-find-prev"
        aria-label="Previous match"
        onClick={() => step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid="chat-find-next"
        aria-label="Next match"
        onClick={() => step(1)}
      >
        ↓
      </button>
      <button type="button" data-testid="chat-find-close" aria-label="Close find" onClick={close}>
        ✕
      </button>
    </div>
  );
}
