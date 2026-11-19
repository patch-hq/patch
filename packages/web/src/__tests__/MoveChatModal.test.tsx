// spec/04 § Moving to another host, spec/14 § Chat panel header — the Move
// dialog: pick the host, get its folder with the same name offered; moving
// opens the linked chat's draft on the new-chat screen, and a refusal keeps
// the dialog open with the server's own reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render as rtlRender,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { MoveChatModal } from '../components/MoveChatModal.js';
import { useDraftStore } from '../stores/draftStore.js';
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

function Where(): ReactElement {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function render(ui: ReactElement) {
  return rtlRender(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const draft = (hostId: string, folder: string) => ({
  draft: {
    id: 'draft-linked-1',
    hostId,
    folder,
    text: 'This continues a chat',
    continuedFrom: 'c1',
    updatedAt: 5,
  },
});

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

  it('offers every host, another online one chosen, with its same-named folder filled in', () => {
    render(<MoveChatModal row={row} onClose={() => undefined} />);
    expect(screen.getByTestId('move-chat-from').textContent).toBe('Mac · /Users/tom/wpp/Unite');
    expect(screen.getByTestId('move-chat-host-box').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('move-chat-host-pi') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/Unite',
    );
  });

  it("offers the chat's own host as a target, without its current folder, and moves within it", async () => {
    usePresenceStore.setState({
      hosts: {
        mac: host('mac', 'Mac', true, ['/Users/tom/wpp/Unite', '/Users/tom/wpp/Unite2']),
        box: host('box', 'Hetzner', false, []),
      },
    });
    vi.mocked(api.moveChat).mockResolvedValue(draft('mac', '/Users/tom/wpp/Unite2'));
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    expect(screen.getByTestId('move-chat-host-mac').textContent).toContain('this machine');
    expect(screen.getByTestId('move-chat-host-mac').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/Users/tom/wpp/Unite2',
    );
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.moveChat).toHaveBeenCalledWith('c1', 'mac', '/Users/tom/wpp/Unite2');
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

  it('moves to the chosen host and folder, then closes and opens the linked chat’s draft', async () => {
    vi.mocked(api.moveChat).mockResolvedValue(draft('box', '/home/tom/Unite'));
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.moveChat).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
    expect(screen.getByTestId('where').textContent).toBe('/chats/new?draft=draft-linked-1');
    expect(useDraftStore.getState().drafts['draft-linked-1']).toMatchObject({
      hostId: 'box',
      folder: '/home/tom/Unite',
      continuedFrom: 'c1',
    });
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

  it('with no folder of that name, the first folder the host offers is selected', () => {
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

  it('moves a chat whose own host is offline the same way: nothing is taken from that host', async () => {
    usePresenceStore.setState({
      hosts: {
        mac: host('mac', 'Mac', false, ['/Users/tom/wpp/Unite']),
        box: host('box', 'Hetzner', true, ['/home/tom/projects', '/home/tom/Unite']),
      },
    });
    vi.mocked(api.moveChat).mockResolvedValue(draft('box', '/home/tom/Unite'));
    const onClose = vi.fn();
    render(<MoveChatModal row={row} onClose={onClose} />);
    expect((screen.getByTestId('move-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/Unite',
    );
    fireEvent.click(screen.getByTestId('move-chat-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.moveChat).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
  });
});
