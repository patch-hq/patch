// Document editor (spec/14 § Document editor — Working with the agent):
// selection-to-ask attaches the selection to the chat by quoting it into the
// chat's own composer draft.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { withQuotedSelection, quoteSelectionIntoComposer } from '../lib/quoteSelection.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { setActiveWs } from '../api/ws.js';

describe('withQuotedSelection', () => {
  it('quotes each line of the selection with "> "', () => {
    expect(withQuotedSelection('', 'line one\nline two')).toBe('> line one\n> line two\n\n');
  });

  it('puts the quote ahead of the existing draft text', () => {
    expect(withQuotedSelection('already typed  \n', 'quoted')).toBe(
      '> quoted\n\nalready typed  \n',
    );
  });
});

describe('withQuotedSelection stacking', () => {
  it('keeps the typed text as the reply to the first quote and adds the next after it', () => {
    expect(withQuotedSelection('> one\n\nmy question', 'two')).toBe(
      '> one\n\nmy question\n\n> two\n\n',
    );
  });
  it('stacks quotes when nothing has been typed under the first', () => {
    expect(withQuotedSelection('> one\n\n', 'two')).toBe('> one\n\n> two\n\n');
  });
});

describe('quoteSelectionIntoComposer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setActiveWs(null);
    vi.useFakeTimers();
    useComposerDraftStore.getState()._reset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setActiveWs(null);
  });

  it('sets the composer draft for the given chat from nothing', () => {
    quoteSelectionIntoComposer('chat-1', 'a passage');
    expect(useComposerDraftStore.getState().get('chat-1')).toBe('> a passage\n\n');
  });

  it('stacks above an existing draft for that chat', () => {
    useComposerDraftStore.getState().setDraft('chat-1', 'what about this');
    quoteSelectionIntoComposer('chat-1', 'a passage');
    expect(useComposerDraftStore.getState().get('chat-1')).toBe('> a passage\n\nwhat about this');
  });
});
