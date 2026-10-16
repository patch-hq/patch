// spec/04 § Moving a chat to another host, spec/14 § Chat panel header — the
// Move dialog: pick the machine, get its folder with the same name offered,
// and a refusal keeps the dialog open with the server's own reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MoveChatModal } from '../components/MoveChatModal.js';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';
import { api, ApiError } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

vi.mock('../api/rest.js', async (orig) => {
  const real = await orig<typeof import('../api/rest.js')>();
  return { ...real, api: { moveChat: vi.fn() } };
});

function host(hostId: string, hostName: string, online: boolean, recent: string[]): HostPresence {
  return {
    hostId,
    online,
    lastSeenAt: null,
    host: { hostName } as HostPresence['host'],
    accounts: {},
    claudeSettings: null,
    folders: { roots: [], recent },
  };
}

const row = { chatId: 'c1', hostId: 'mac', folder: '/Users/tom/wpp/Unite' } as ChatRow;

describe('MoveChatModal', () => {
  beforeEach(() => {
    usePresenceStore.setState({
      hosts: {
        mac: host('mac', 'Mac', true, ['/Users/tom/wpp/Unite']),
        box: host('box', 'Hetzner', true, ['/home/tom/projects', '/home/tom/Unite']),
        pi: host('pi', 'Pi', false, []),
      },
    });
    vi.mocked(api.moveChat).mockReset();
  });
  afterEach(() => cleanup());

  it('offers the other machines, the online one chosen, with its same-named folder filled in', () => {
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect(screen.getByTestId('move-chat-from').textContent).toBe('Mac · /Users/tom/wpp/Unite');
    expect(screen.queryByTestId('move-chat-host-mac')).toBeNull();
    expect(screen.getByTestId('move-chat-host-box').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('move-chat-host-pi') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/Unite',
    );
  });

  it('keeps a typed folder when presence updates for an unrelated reason', () => {
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    const input = screen.getByTestId('move-chat-folder') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/my/typed/path' } });
    act(() => {
      usePresenceStore.setState({
        hosts: { ...usePresenceStore.getState().hosts, pi: host('pi', 'Pi', false, []) },
      });
    });
    expect(input.value).toBe('/my/typed/path');
  });

  it('moves to the chosen machine and folder, then closes', async () => {
    vi.mocked(api.moveChat).mockResolvedValue({
      ok: true,
      chatId: 'c1',
      hostId: 'box',
      folder: '/home/tom/Unite',
    });
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.moveChat).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
  });

  it('a refusal stays open and says why', async () => {
    vi.mocked(api.moveChat).mockRejectedValue(
      new ApiError(409, 'busy', { error: 'busy', message: 'Mac: this chat is mid-turn' }),
    );
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    expect((await screen.findByTestId('move-chat-error')).textContent).toBe(
      'Mac: this chat is mid-turn',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with no folder of that name, the first folder the machine offers is selected', () => {
    usePresenceStore.setState({
      hosts: {
        mac: host('mac', 'Mac', true, []),
        box: host('box', 'Hetzner', true, ['/home/tom/projects', '/home/tom/other']),
      },
    });
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/projects',
    );
    expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no folders at all, Move waits for a typed one', () => {
    usePresenceStore.setState({
      hosts: { mac: host('mac', 'Mac', true, []), box: host('box', 'Hetzner', true, []) },
    });
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('move-chat-folder'), { target: { value: '/srv/unite' } });
    expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  describe("when the chat's own machine is offline", () => {
    beforeEach(() => {
      usePresenceStore.setState({
        hosts: {
          mac: host('mac', 'Mac', false, ['/Users/tom/wpp/Unite']),
          box: host('box', 'Hetzner', true, ['/home/tom/projects', '/home/tom/Unite']),
        },
      });
    });

    it('says what stays behind and leaves the folder for the user to choose', () => {
      render(<MoveChatModal row={row} onClose={() => undefined} />);
      expect(screen.getByTestId('move-chat-takeover-note').textContent).toContain('Mac is offline');
      expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe('');
      expect((screen.getByTestId('move-chat-confirm') as HTMLButtonElement).disabled).toBe(true);
    });

    it('offers the same-named folder as a suggestion that is used only once accepted', async () => {
      vi.mocked(api.moveChat).mockResolvedValue({
        ok: true,
        chatId: 'c1',
        hostId: 'box',
        folder: '/home/tom/Unite',
      });
      const onClose = vi.fn();
      render(<MoveChatModal row={row} onClose={onClose} />);
      const suggest = screen.getByTestId('move-chat-suggest');
      expect(suggest.textContent).toContain('/home/tom/Unite');
      expect(api.moveChat).not.toHaveBeenCalled();
      fireEvent.click(suggest);
      expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
        '/home/tom/Unite',
      );
      fireEvent.click(screen.getByTestId('move-chat-confirm'));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(api.moveChat).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
    });

    it('a machine that is online shows neither the note nor a suggestion button', () => {
      usePresenceStore.setState({
        hosts: {
          mac: host('mac', 'Mac', true, ['/Users/tom/wpp/Unite']),
          box: host('box', 'Hetzner', true, ['/home/tom/Unite']),
        },
      });
      render(<MoveChatModal row={row} onClose={() => undefined} />);
      expect(screen.queryByTestId('move-chat-takeover-note')).toBeNull();
      expect(screen.queryByTestId('move-chat-suggest')).toBeNull();
    });
  });

  describe("choosing the server copy while the chat's machine is online", () => {
    it('is offered, switches to the takeover notice with an empty folder, and sends the choice', async () => {
      vi.mocked(api.moveChat).mockResolvedValue({
        ok: true,
        chatId: 'c1',
        hostId: 'box',
        folder: '/home/tom/Unite',
      });
      const onClose = vi.fn();
      render(<MoveChatModal row={row} onClose={onClose} />);
      expect(screen.queryByTestId('move-chat-takeover-note')).toBeNull();
      fireEvent.click(screen.getByTestId('move-chat-from-copy'));
      expect(screen.getByTestId('move-chat-takeover-note').textContent).toContain(
        'continues from the server',
      );
      expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe('');
      fireEvent.click(screen.getByTestId('move-chat-suggest'));
      fireEvent.click(screen.getByTestId('move-chat-confirm'));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(api.moveChat).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite', {
        fromServerCopy: true,
      });
    });

    it('switching back restores the same-named folder and the ordinary move', () => {
      render(<MoveChatModal row={row} onClose={() => undefined} />);
      fireEvent.click(screen.getByTestId('move-chat-from-copy'));
      fireEvent.click(screen.getByTestId('move-chat-from-copy'));
      expect(screen.queryByTestId('move-chat-takeover-note')).toBeNull();
      expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
        '/home/tom/Unite',
      );
    });

    it('is not offered when the machine is already offline, since that is the only way', () => {
      usePresenceStore.setState({
        hosts: {
          mac: host('mac', 'Mac', false, ['/Users/tom/wpp/Unite']),
          box: host('box', 'Hetzner', true, ['/home/tom/Unite']),
        },
      });
      render(<MoveChatModal row={row} onClose={() => undefined} />);
      expect(screen.queryByTestId('move-chat-from-copy')).toBeNull();
    });
  });
});
