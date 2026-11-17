import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatEventEntry } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';

const sent = vi.hoisted(() => [] as { chatId: string; text: string }[]);
vi.mock('../lib/sendQueue.js', () => ({
  sendMessage: (chatId: string, text: string) => {
    sent.push({ chatId, text });
    return 'local';
  },
}));

import { TriagePage } from '../components/TriagePage.js';

function row(chatId: string, name: string, lastUpdated: number): ChatRow {
  return {
    chatId,
    hostId: 'd1',
    name,
    preview: null,
    statusKind: null,
    statusDeclared: null,
    todos: [],
    folder: '/w',
    activity: 'idle',
    status: 'active',
    pinned: false,
    disabled: false,
    lastUpdated,
    lastSeq: 5,
    lastReadSeq: 1,
    pendingPermissions: [],
  } as unknown as ChatRow;
}
const msg = (content: string): ChatEventEntry[] => [
  { kind: 'message', role: 'assistant', content, seq: 3 } as ChatEventEntry,
];

const ws = { send: vi.fn(), requestReplay: vi.fn() };

function mount(): void {
  render(
    <MemoryRouter>
      <TriagePage ws={ws as never} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sent.length = 0;
  ws.requestReplay.mockClear();
  useChatStore.setState({
    chats: { a: row('a', 'first chat', 10), b: row('b', 'second chat', 20) },
    timelines: { a: msg('Message from A'), b: msg('Message from B') },
  });
});

describe('TriagePage', () => {
  it('shows the oldest waiting chat in full and asks for its transcript', () => {
    mount();
    expect(screen.getByTestId('triage-title').textContent).toBe('first chat');
    expect(screen.getByTestId('triage-message').textContent).toContain('Message from A');
    expect(screen.getByTestId('triage-count').textContent).toBe('2 waiting');
    expect(ws.requestReplay).toHaveBeenCalledWith('a');
  });

  it('keeps Send off until there is text', () => {
    mount();
    expect((screen.getByTestId('triage-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('triage-input'), { target: { value: 'ok' } });
    expect((screen.getByTestId('triage-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the reply, marks the chat read and moves to the next', () => {
    mount();
    fireEvent.change(screen.getByTestId('triage-input'), { target: { value: 'do it' } });
    fireEvent.click(screen.getByTestId('triage-send'));
    expect(sent).toEqual([{ chatId: 'a', text: 'do it' }]);
    expect(useChatStore.getState().chats['a']!.lastReadSeq).toBe(5);
    expect(screen.getByTestId('triage-title').textContent).toBe('second chat');
    expect((screen.getByTestId('triage-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('puts a chat that finishes later at the end, and shows empty when done', () => {
    mount();
    act(() => {
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c: row('c', 'third chat', 30) },
        timelines: { ...useChatStore.getState().timelines, c: msg('Message from C') },
      });
    });
    expect(screen.getByTestId('triage-title').textContent).toBe('first chat');
    expect(screen.getByTestId('triage-count').textContent).toBe('3 waiting');
    for (const text of ['1', '2', '3']) {
      fireEvent.change(screen.getByTestId('triage-input'), { target: { value: text } });
      fireEvent.click(screen.getByTestId('triage-send'));
    }
    expect(sent.map((s) => s.chatId)).toEqual(['a', 'b', 'c']);
    expect(screen.getByTestId('triage-empty')).toBeTruthy();
  });
});
