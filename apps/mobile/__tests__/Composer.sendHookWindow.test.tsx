// A send with an image shows it once, never twice. The sent message is echoed
// into the chat (its files uploading) the moment Send is pressed, while the hook
// check is still running; the draft's chips must already be gone from the
// composer by then, and come back if the check blocks the send.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findAllHost,
  findHost,
  byLabel,
  byTestId,
  renderRN,
  update,
  actAsync,
  flush,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { _resetSendQueue } from '../src/lib/sendQueue';
import type { HookCheckResponse } from '@patch/wire/hooks';

const check = vi.fn<() => Promise<HookCheckResponse>>();
vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: () => check(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn().mockImplementation((chatId: string, f: { name: string }) =>
      Promise.resolve({
        ok: true,
        ref: {
          id: 'srv-1',
          name: f.name,
          mimeType: 'image/png',
          kind: 'image',
          url: `/x/${chatId}`,
        },
      }),
    ),
    detachAttachments: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import { Composer } from '../src/components/Composer';

const chips = (r: ReturnType<typeof renderRN>): number =>
  findAllHost(r.root, byTestId('composer-attachment')).length;

let submitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  _resetSendQueue();
  useComposerAttachmentStore.getState()._reset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});
afterEach(() => submitSpy.mockRestore());

async function sendWithImage(): Promise<ReturnType<typeof renderRN>> {
  const r = renderRN(<Composer chatId="c1" folder="work" />);
  await actAsync(async () => {
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [
        { uri: 'file:///img.png', name: 'img.png', mimeType: 'image/png' },
      ]);
    await flush();
  });
  update(r, <Composer chatId="c1" folder="work" />);
  expect(chips(r)).toBe(1);
  await actAsync(async () => {
    findHost(r.root, byLabel('Send message')).props['onPress']();
    await flush();
  });
  update(r, <Composer chatId="c1" folder="work" />);
  return r;
}

describe('Composer — image send while the hook check is running', () => {
  it('shows the image in the chat only, not also as a draft chip', async () => {
    check.mockReturnValue(new Promise(() => {}));
    const r = await sendWithImage();
    expect(useChatStore.getState().timelines['c1']?.[0]?.attachments).toHaveLength(1);
    expect(chips(r)).toBe(0);
  });

  it('brings the chip back when the check blocks the send', async () => {
    let resolve!: (v: HookCheckResponse) => void;
    check.mockReturnValue(new Promise((res) => (resolve = res)));
    const r = await sendWithImage();
    await actAsync(async () => {
      resolve({ decision: 'block', results: [] });
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(chips(r)).toBe(1);
  });

  it('releases the image from the draft once the check passes', async () => {
    let resolve!: (v: HookCheckResponse) => void;
    check.mockReturnValue(new Promise((res) => (resolve = res)));
    const r = await sendWithImage();
    await actAsync(async () => {
      resolve({ decision: 'pass', results: [] });
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(chips(r)).toBe(0);
    expect(useComposerAttachmentStore.getState().byKey['c1'] ?? []).toHaveLength(0);
  });
});
