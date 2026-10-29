import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { sendFileEditorEvent } from '../lib/fileEditorSend.js';
import type { PatchWs } from '../api/ws.js';

// Todoist: "question answers for chats on the Mac go to Hetzner and are lost" —
// the server routes a permission answer by its chatId, so a file tab's
// Approve/Deny must name the tab's chat.
describe('sendFileEditorEvent', () => {
  it("stamps the tab's chatId on a permission response", () => {
    const send = vi.fn();
    sendFileEditorEvent({ send } as unknown as PatchWs, 'c-mac', {
      type: 'chat.permission_response',
      requestId: 'req-fe-1',
      approve: true,
      decision: 'approve',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        chatId: 'c-mac',
        requestId: 'req-fe-1',
      }),
    );
  });

  // spec/12 § Host-offline UX: an editor save into an offline host is accepted
  // and buffered by the server, and says so rather than claiming it is saved.
  describe('file.write', () => {
    const save = { type: 'file.write', chatId: 'c-off', path: 'a.md', content: 'x' } as const;
    const noticeText = (): string[] =>
      useUiStore.getState().errors.map((n: { message: string }) => n.message);

    beforeEach(() => {
      useUiStore.setState({ errors: [] });
      useChatStore.setState({
        chats: { 'c-off': { hostId: 'h1' } },
      } as unknown as Partial<ReturnType<typeof useChatStore.getState>>);
    });

    it('says it saved when the chat host is online', () => {
      usePresenceStore.setState({
        hosts: { h1: { hostId: 'h1', online: true } },
      } as unknown as Partial<ReturnType<typeof usePresenceStore.getState>>);
      const send = vi.fn();
      sendFileEditorEvent({ send } as unknown as PatchWs, 'c-off', save);
      expect(send).toHaveBeenCalledWith(save);
      expect(noticeText()).toEqual(['Saved a.md']);
    });

    it('sends it and says it will save on reconnect when the chat host is offline', () => {
      usePresenceStore.setState({
        hosts: { h1: { hostId: 'h1', online: false } },
      } as unknown as Partial<ReturnType<typeof usePresenceStore.getState>>);
      const send = vi.fn();
      sendFileEditorEvent({ send } as unknown as PatchWs, 'c-off', save);
      expect(send).toHaveBeenCalledWith(save);
      expect(noticeText()).toEqual(['h1 host is offline. a.md saves when it is back.']);
    });
  });
});
