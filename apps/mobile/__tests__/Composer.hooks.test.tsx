// Composer — message hooks (spec/15 § Composer — Message hooks, spec/20-hooks.md).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findHost,
  queryHost,
  byLabel,
  byType,
  byTestId,
  renderRN,
  update,
  flushMicrotasks,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { useComposerDraftStore } from '../src/lib/composerDraft';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { __clearAllMmkv } from './stubs/mmkv';
import type { HookCheckResponse } from '@patch/wire/hooks';

const check = vi.fn<(c: string, m: string, n?: unknown) => Promise<HookCheckResponse>>();
vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: (c: string, m: string, n?: unknown) => check(c, m, n),
}));
vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';

const blockResult = {
  hookId: 'h1',
  hookName: 'Tone',
  status: 'ok' as const,
  decision: 'block' as const,
  analysis: 'Too curt',
  suggestion: 'Please could you…',
  durationMs: 1,
};

let submitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  useComposerAttachmentStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  check.mockReset();
});
afterEach(() => submitSpy.mockRestore());

function type(r: ReturnType<typeof renderRN>, text: string) {
  findHost(r.root, byType('TextInput')).props['onChangeText'](text);
  update(r, <Composer chatId="c1" folder="work" />);
}
const press = async (r: ReturnType<typeof renderRN>, label: string) => {
  findHost(r.root, byLabel(label)).props['onPress']();
  await flushMicrotasks();
  update(r, <Composer chatId="c1" folder="work" />);
};
const pressId = async (r: ReturnType<typeof renderRN>, id: string) => {
  findHost(r.root, byTestId(id)).props['onPress']();
  await flushMicrotasks();
  update(r, <Composer chatId="c1" folder="work" />);
};

describe('Composer — message hooks', () => {
  it('Send reads Checking… and is disabled while the check is in flight', async () => {
    let release!: (r: HookCheckResponse) => void;
    check.mockReturnValue(new Promise((res) => (release = res)));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'hello');
    await press(r, 'Send message');
    const busy = findHost(r.root, byLabel('Checking…'));
    expect(busy.props['disabled']).toBe(true);
    expect(submitSpy).not.toHaveBeenCalled();
    release({ decision: 'pass', results: [] });
    await flushMicrotasks();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('c1', 'hello', []);
  });

  it('text typed while the check runs is kept, and the part already sent is not left to be sent again', async () => {
    let release!: (r: HookCheckResponse) => void;
    check.mockReturnValue(new Promise((res) => (release = res)));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'hello');
    await press(r, 'Send message');
    type(r, 'hello world');
    release({ decision: 'pass', results: [] });
    await flushMicrotasks();
    update(r, <Composer chatId="c1" folder="work" />);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![1]).toBe('hello');
    // What was sent is gone from the box; what was typed after it stays.
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('world');
  });

  it('an attachment added while the check runs stays in the composer; only the sent one goes', async () => {
    let release!: (r: HookCheckResponse) => void;
    check.mockReturnValue(new Promise((res) => (release = res)));
    const att = (key: string) => ({
      key,
      uri: `file:///${key}.txt`,
      name: `${key}.txt`,
      mimeType: 'text/plain',
      kind: 'file' as const,
    });
    useComposerAttachmentStore.getState().add('c1', [att('a')]);
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'hello');
    await press(r, 'Send message');
    useComposerAttachmentStore.getState().add('c1', [att('b')]);
    release({ decision: 'pass', results: [] });
    await flushMicrotasks();
    expect(useComposerAttachmentStore.getState().byKey['c1']?.map((a) => a.key)).toEqual(['b']);
  });

  it('a block keeps the text, opens the sheet and sends nothing', async () => {
    check.mockResolvedValue({ decision: 'block', results: [blockResult] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'give me it');
    await press(r, 'Send message');
    expect(findHost(r.root, byTestId('hook-block-sheet'))).toBeTruthy();
    expect(findHost(r.root, byTestId('hook-block-analysis')).props['children']).toBe('Too curt');
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('give me it');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('Use suggestion replaces the draft without sending', async () => {
    check.mockResolvedValue({ decision: 'block', results: [blockResult] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'give me it');
    await press(r, 'Send message');
    await pressId(r, 'hook-use-suggestion-h1');
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('Please could you…');
    expect(queryHost(r.root, byTestId('hook-block-sheet'))).toBeNull();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('Edit closes the sheet and leaves the text', async () => {
    check.mockResolvedValue({ decision: 'block', results: [blockResult] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'give me it');
    await press(r, 'Send message');
    await pressId(r, 'hook-block-edit');
    expect(queryHost(r.root, byTestId('hook-block-sheet'))).toBeNull();
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('give me it');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('Send anyway sends the original text without a second check, with no advise note for the block', async () => {
    check.mockResolvedValue({ decision: 'block', results: [blockResult] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'give me it');
    await press(r, 'Send message');
    await pressId(r, 'hook-block-send-anyway');
    expect(check).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(queryHost(r.root, byTestId('hook-block-sheet'))).toBeNull();
  });

  it('a failed hook renders its error in place of an analysis, with no suggestion', async () => {
    check.mockResolvedValue({
      decision: 'block',
      results: [
        blockResult,
        { hookId: 'h2', hookName: 'Slow', status: 'timeout', error: '30s', durationMs: 1 },
        { hookId: 'h3', hookName: 'Broke', status: 'failed', durationMs: 1 },
      ],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'x');
    await press(r, 'Send message');
    const errs = r.root.findAll(
      (i) => i.props?.testID === 'hook-block-error' && typeof i.type === 'string',
    );
    expect(errs.map((e) => e.props['children'].join(''))).toEqual(['Timed out: 30s', 'Failed']);
    expect(queryHost(r.root, byTestId('hook-use-suggestion-h2'))).toBeNull();
  });

  it('advise sends and attaches the note to the sent message', async () => {
    check.mockResolvedValue({
      decision: 'advise',
      results: [
        {
          hookId: 'h4',
          hookName: 'Nudge',
          status: 'ok',
          decision: 'advise',
          analysis: 'a thought',
          durationMs: 1,
        },
      ],
    });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    type(r, 'hello');
    await press(r, 'Send message');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const msg = (useChatStore.getState().timelines['c1'] ?? []).find((e) => e.kind === 'message');
    expect(msg?.hookAdvise).toEqual([{ hookId: 'h4', hookName: 'Nudge', analysis: 'a thought' }]);
  });
});
