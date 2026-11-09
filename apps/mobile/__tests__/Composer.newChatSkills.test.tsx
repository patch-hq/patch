// New chat: no chat row exists yet, so the `/` list must fetch against the
// setup's host (Todoist 6hwqxJc4ppw6hPjc — it never loaded).
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findHost, byType, renderRN, update, flushMicrotasks } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useComposerDraftStore } from '../src/lib/composerDraft';
import { __clearAllMmkv } from './stubs/mmkv';
import { api } from '../src/api/rest';

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: ['deploy'] }),
    models: vi.fn().mockResolvedValue({ models: [] }),
  },
}));

import { Composer } from '../src/components/Composer';

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  useChatStore.getState()._reset();
  vi.mocked(api.skills).mockClear();
});

describe('Composer skill list on a new chat', () => {
  it('fetches the folder skills from the setup host when `/` is typed', async () => {
    const el = (
      <Composer
        chatId="draft-1"
        folder="/home/tom/work"
        sendTarget={async () => null}
        setup={{
          hostId: 'h1',
          model: null,
          onModel: vi.fn(),
          mode: 'default',
          onMode: vi.fn(),
          effort: null,
          onEffort: vi.fn(),
          accountId: null,
          onAccount: vi.fn(),
        }}
      />
    );
    const r = renderRN(el);
    findHost(r.root, byType('TextInput')).props['onChangeText']('/');
    update(r, el);
    await flushMicrotasks();
    expect(api.skills).toHaveBeenCalledWith('/home/tom/work', 'h1');
  });
});
