// lib/docEditor.ts — the document editor's pure rules (spec/14 § Document
// editor, spec/15 § Document editor).

import { describe, it, expect } from 'vitest';
import type { DocView } from '@patch/wire';
import {
  baseName,
  detectSaveConflict,
  docRoute,
  docsRoute,
  documentEntries,
  isDocxPath,
  isMarkdownPath,
  isOpenableDoc,
  joinRel,
  orderSuggestions,
  orderThreads,
  parentRel,
  selectedText,
  versionsNewestFirst,
  withQuotedSelection,
} from '../src/lib/docEditor';

const view = (over: Partial<DocView> = {}): DocView => ({
  mode: 'change',
  suggestions: [],
  threads: [],
  versions: [],
  ...over,
});

describe('selectedText', () => {
  it('slices the selection, whichever way it was dragged', () => {
    expect(selectedText('hello world', { start: 6, end: 11 })).toBe('world');
    expect(selectedText('hello world', { start: 11, end: 6 })).toBe('world');
  });
  it('is empty for a caret', () => {
    expect(selectedText('hello', { start: 2, end: 2 })).toBe('');
  });
});

describe('withQuotedSelection', () => {
  it('quotes every line with "> " and leaves a blank line to type in', () => {
    expect(withQuotedSelection('', 'a\nb')).toBe('> a\n> b\n\n');
  });
  it('puts the quote above the existing draft, stacking after earlier quotes', () => {
    expect(withQuotedSelection('why?', 'x')).toBe('> x\n\nwhy?');
    expect(withQuotedSelection('> a\n\nwhy?', 'x')).toBe('> a\n\n> x\n\nwhy?');
  });
  it('quotes a blank line inside the selection as a bare "> "', () => {
    expect(withQuotedSelection('', 'a\n\nb')).toBe('> a\n> \n> b\n\n');
  });
});

describe('ordering', () => {
  it('lists pending suggestions before resolved ones, keeping made-order', () => {
    const s = (id: string, status: 'pending' | 'accepted' | 'rejected') => ({
      id,
      find: 'f',
      replace: 'r',
      status,
      createdAt: 1,
    });
    const o = orderSuggestions(
      view({
        suggestions: [s('a', 'accepted'), s('b', 'pending'), s('c', 'rejected'), s('d', 'pending')],
      }),
    );
    expect(o.pending.map((x) => x.id)).toEqual(['b', 'd']);
    expect(o.resolved.map((x) => x.id)).toEqual(['a', 'c']);
    expect(o.all.map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('lists open threads before resolved ones', () => {
    const t = (id: string, resolved: boolean) => ({ id, anchor: 'x', resolved, comments: [] });
    const o = orderThreads(view({ threads: [t('1', true), t('2', false), t('3', false)] }));
    expect(o.open.map((x) => x.id)).toEqual(['2', '3']);
    expect(o.all.map((x) => x.id)).toEqual(['2', '3', '1']);
  });

  it('reverses versions to newest first without mutating the view', () => {
    const v = (id: string) => ({ id, content: id, savedBy: 'user' as const, createdAt: 1 });
    const input = view({ versions: [v('1'), v('2'), v('3')] });
    expect(versionsNewestFirst(input).map((x) => x.id)).toEqual(['3', '2', '1']);
    expect(input.versions.map((x) => x.id)).toEqual(['1', '2', '3']);
  });
});

describe('paths', () => {
  it('recognises documents case-insensitively', () => {
    expect(isMarkdownPath('A.MD')).toBe(true);
    expect(isMarkdownPath('a.md.txt')).toBe(false);
    expect(isDocxPath('r.docx')).toBe(true);
    expect(isOpenableDoc('r.docx')).toBe(true);
    expect(isOpenableDoc('r.pdf')).toBe(false);
  });
  it('joins, splits and walks up', () => {
    expect(joinRel('', 'a.md')).toBe('a.md');
    expect(joinRel('docs', 'a.md')).toBe('docs/a.md');
    expect(baseName('docs/sub/a.md')).toBe('a.md');
    expect(baseName('a.md')).toBe('a.md');
    expect(parentRel('docs/sub')).toBe('docs');
    expect(parentRel('docs')).toBe('');
    expect(parentRel('')).toBeNull();
  });
  it('builds the routes', () => {
    expect(docRoute('c1', 'a/b.md')).toEqual({
      pathname: '/chats/[chatId]/doc',
      params: { chatId: 'c1', path: 'a/b.md' },
    });
    expect(docsRoute('c1')).toEqual({ pathname: '/chats/[chatId]/docs', params: { chatId: 'c1' } });
    expect(docsRoute('c1', '')).toEqual({
      pathname: '/chats/[chatId]/docs',
      params: { chatId: 'c1' },
    });
    expect(docsRoute('c1', 'a')).toEqual({
      pathname: '/chats/[chatId]/docs',
      params: { chatId: 'c1', path: 'a' },
    });
  });
});

describe('documentEntries', () => {
  it('offers folders, then .md and .docx files, and nothing else', () => {
    const out = documentEntries([
      { name: 'z.md', type: 'file' },
      { name: 'img.png', type: 'file' },
      { name: 'b', type: 'dir' },
      { name: 'a.docx', type: 'file' },
      { name: 'a', type: 'dir' },
      { name: 'notes.txt', type: 'file' },
    ]);
    expect(out.map((e) => e.name)).toEqual(['a', 'b', 'a.docx', 'z.md']);
  });
});

describe('detectSaveConflict', () => {
  it('is not a conflict when the disk is where the draft started', () => {
    expect(detectSaveConflict({ baseline: 'a', onDisk: 'a', draft: 'b' })).toBe(false);
  });
  it('is not a conflict when the disk already holds the draft', () => {
    expect(detectSaveConflict({ baseline: 'a', onDisk: 'b', draft: 'b' })).toBe(false);
  });
  it('is a conflict when someone else moved the disk elsewhere', () => {
    expect(detectSaveConflict({ baseline: 'a', onDisk: 'c', draft: 'b' })).toBe(true);
  });
});
