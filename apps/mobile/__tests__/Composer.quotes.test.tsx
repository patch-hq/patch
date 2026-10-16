// spec/15 § Composer — quotes: leading `> ` blocks of the draft are cards
// stacked above the input; the input holds only what the user types.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { findHost, byType, renderRN as renderRNRaw, actAsync, flush } from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import {
  setComposerDraft,
  getComposerDraft,
  useComposerDraftStore,
} from '../src/lib/composerDraft';
import { deliveryTracker } from '../src/lib/deliveryTracker';

const { skillsSpy } = vi.hoisted(() => ({ skillsSpy: vi.fn() }));
// Message hooks have their own tests (Composer.hooks.test.tsx); here the check passes.
vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: async () => ({ decision: 'pass' as const, results: [] }),
}));

vi.mock('../src/api/rest', () => ({
  api: { skills: skillsSpy, uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';

let submitSpy: ReturnType<typeof vi.spyOn>;

// Tracked so `afterEach` can unmount every instance — a lingering one from a
// prior test re-renders on THIS test's own `hydrate()` call below and, now
// that the skill fetch reads `row.hostId`, can fire an extra `api.skills`
// through the same shared `skillsSpy` mock (see Composer.skills.test.tsx).
const renderers: ReactTestRenderer[] = [];
function renderRN(element: React.ReactElement): ReactTestRenderer {
  const r = renderRNRaw(element);
  renderers.push(r);
  return r;
}

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  // Skills are per-host (Todoist 6hfrrmrhG6GM3V36) — the fetch needs `c1`'s
  // row to carry a hostId.
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      name: 'Chat',
      folder: 'work',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
    },
  ]);
  useUiStore.setState({ errors: [] });
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  skillsSpy.mockReset();
  skillsSpy.mockResolvedValue({
    skills: ['plant'],
    descriptions: { plant: 'Sow what is in season.' },
  });
});

afterEach(() => {
  submitSpy.mockRestore();
  while (renderers.length > 0) {
    renderers.pop()?.unmount();
  }
});

describe('Composer — quote cards (mobile)', () => {
  it('draws leading quotes as cards and keeps them out of the input', () => {
    setComposerDraft('c1', '> one\n\n> two\n> lines\n\nask');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('ask');
    expect(
      r.root.findAll((n) => n.props?.testID === 'composer-quote' && typeof n.type === 'string'),
    ).toHaveLength(2);
  });

  it('typing keeps the quotes in the stored draft', async () => {
    setComposerDraft('c1', '> one\n\n');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('why?');
      await flush();
    });
    expect(getComposerDraft('c1')).toBe('> one\n\nwhy?');
  });

  it('removing a quote leaves the rest', async () => {
    setComposerDraft('c1', '> one\n\n> two\n\nask');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      r.root
        .findAll(
          (n) => n.props?.testID === 'composer-quote-remove' && typeof n.type === 'string',
        )[0]
        ?.props['onPress']();
      await flush();
    });
    expect(getComposerDraft('c1')).toBe('> two\n\nask');
  });
});
