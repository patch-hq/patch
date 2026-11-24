// The compact message box under an open artifact: type, Send, and the turn goes
// to the chat the artifact belongs to — nothing else on offer.

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actAsync, byTestId, findHost, renderRN } from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import {
  ArtifactViewerHost,
  __resetArtifactViewer,
  openArtifactViewer,
} from '../src/components/ArtifactViewer';

const sendMessage = vi.fn();
vi.mock('../src/lib/sendQueue', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));

beforeEach(() => {
  __clearAllMmkv();
  __resetArtifactViewer();
  sendMessage.mockReset();
});

describe('QuickMessageBox in the artifact viewer', () => {
  it('sends the typed text to the viewer chat and clears the box', async () => {
    const r = renderRN(<ArtifactViewerHost chatId="c9" />);
    await actAsync(() => openArtifactViewer('http://h/api/chats/c9/artifact/a', 'Page'));
    const input = findHost(r.root, byTestId('quick-message-input'));
    await actAsync(() => input.props.onChangeText('  hello  '));
    await actAsync(() => findHost(r.root, byTestId('quick-message-send')).props.onPress());
    expect(sendMessage).toHaveBeenCalledWith('c9', 'hello', []);
    expect(findHost(r.root, byTestId('quick-message-input')).props.value).toBe('');
  });

  it('cannot send an empty box', async () => {
    const r = renderRN(<ArtifactViewerHost chatId="c9" />);
    await actAsync(() => openArtifactViewer('http://h/api/chats/c9/artifact/a', 'Page'));
    const send = findHost(r.root, byTestId('quick-message-send'));
    expect(send.props.onPress).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
