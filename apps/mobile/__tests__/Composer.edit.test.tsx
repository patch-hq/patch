// spec/15 § Editing a queued message — the editor is the composer in edit mode,
// so it has the composer's rich editing and none of a new turn's controls.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  findHost,
  queryHost,
  byTestId,
  byLabel,
  renderRN as renderRNRaw,
  update,
  actAsync,
  flush,
} from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useComposerDraftStore } from '../src/lib/composerDraft';
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

describe('Composer — edit mode (mobile)', () => {
  function mount(initial = 'queued words') {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const el = (
      <Composer chatId="c1" folder="work" edit={{ initial, onChange, onSave, onCancel }} />
    );
    const r = renderRN(el);
    return { r, el, onChange, onSave, onCancel };
  }

  it('starts with the message text and does not touch the chat draft', async () => {
    useComposerDraftStore.getState().setDraft('c1', 'unsent thing');
    const { r, el, onChange } = mount();
    expect(findHost(r.root, byTestId('queued-edit-input')).props['value']).toBe('queued words');
    await actAsync(async () => {
      findHost(r.root, byTestId('queued-edit-input')).props['onChangeText']('changed');
      await flush();
    });
    update(r, el);
    expect(onChange).toHaveBeenCalledWith('changed');
    expect(useComposerDraftStore.getState().drafts['c1']).toBe('unsent thing');
  });

  it('offers the skill menu and chips', async () => {
    const { r, el } = mount('');
    await actAsync(async () => {
      findHost(r.root, byTestId('queued-edit-input')).props['onChangeText']('run /pl');
      await flush();
    });
    update(r, el);
    expect(findHost(r.root, byTestId('skill-option-plant'))).toBeTruthy();
  });

  it('keeps a long paste inline rather than attaching it', async () => {
    const { r, el, onChange } = mount('');
    const long = 'x'.repeat(20000);
    await actAsync(async () => {
      findHost(r.root, byTestId('queued-edit-input')).props['onChangeText'](long);
      await flush();
    });
    update(r, el);
    expect(onChange).toHaveBeenLastCalledWith(long);
  });

  it('Save passes the trimmed text, even empty; Cancel cancels', async () => {
    const { r, el, onSave, onCancel } = mount();
    await actAsync(async () => {
      findHost(r.root, byTestId('queued-edit-input')).props['onChangeText']('  ');
      await flush();
    });
    update(r, el);
    findHost(r.root, byTestId('queued-edit-save')).props['onPress']();
    expect(onSave).toHaveBeenCalledWith('');
    findHost(r.root, byTestId('queued-edit-cancel')).props['onPress']();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('leaves out attach, model, approval mode and send', () => {
    const { r } = mount();
    for (const id of ['composer-model-pill', 'permission-mode-padlock', 'composer-stop']) {
      expect(queryHost(r.root, byTestId(id))).toBeNull();
    }
    expect(queryHost(r.root, byLabel('Send message'))).toBeNull();
    expect(queryHost(r.root, byLabel('Take photo'))).toBeNull();
    expect(queryHost(r.root, byLabel('Attach any file'))).toBeNull();
    expect(findHost(r.root, byLabel('Dictate into message'))).toBeTruthy();
  });
});
