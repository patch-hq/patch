// Pressing ⏎ twice quickly must send once (Todoist 6hr98jvf9m4jR6C6, "pressing
// enter quickly can add multiple new messages in patch").
//
// A send's attachments leave the draft only once the host has accepted the turn
// (`onSend` resolving), so for that window the composer still held a sendable
// attachment and a second ⏎ sent the same message again, queued behind the first.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useComposerAttachmentStore } from '../stores/composerAttachmentStore.js';
import { api } from '../api/rest.js';
import * as imageResizeModule from '../lib/imageResize.js';

describe('Composer — ⏎ pressed twice quickly', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useComposerAttachmentStore.getState()._reset();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(imageResizeModule, 'downscaleImageFile').mockImplementation(async (f) => f);
    vi.spyOn(api, 'uploadAttachment').mockImplementation(async (chatId, file) => ({
      ok: true,
      ref: {
        id: 'srv-1',
        name: file.name,
        mimeType: file.type,
        kind: 'image',
        url: `/api/chats/${chatId}/attachment/srv-1`,
      },
    }));
    vi.spyOn(api, 'deleteAttachment').mockResolvedValue({ ok: true });
    vi.spyOn(api, 'detachAttachments').mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    cleanup();
    useComposerAttachmentStore.getState()._reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup(onSend: (m: string) => Promise<boolean>) {
    render(<Composer chatId="c1" hostId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
    const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['b'], 'shot.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1));
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    return input;
  }

  it('sends a message with an attachment once while the first send is unconfirmed', async () => {
    let accept: (ok: boolean) => void = () => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const input = await setup(onSend);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      accept(true);
    });
  });

  it('accepts a new send once the first has settled', async () => {
    const onSend = vi.fn(async () => true);
    const input = await setup(onSend);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'again' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(2);
  });
});
