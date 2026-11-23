// The composer's account select (spec/10 § Backend credentials — preferred
// account). Its closed label must follow the account the chat is actually on,
// and it must not carry a native tooltip: a tooltip that is already showing
// when the option list opens draws over the list.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { AccountControl } from '../components/ChatModelControl.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import type { ChatRow } from '../stores/types.js';

function seed(account: { id: string; label: string } | null): void {
  const row = {
    chatId: 'c1',
    hostId: 'd1',
    model: 'claude-sonnet',
    preferredAccountId: null,
    account,
  } as unknown as ChatRow;
  useChatStore.setState((s) => ({ chats: { ...s.chats, c1: row } }));
}

function seedAccounts(): void {
  const mk = (id: string, label: string) => ({ id, label, connected: true });
  usePreferencesStore.setState({
    shared: { secrets: { claude: [mk('a1', 'Default'), mk('a2', 'work')], codex: [] } },
  } as unknown as Parameters<typeof usePreferencesStore.setState>[0]);
}

beforeEach(() => {
  seedAccounts();
  seed({ id: 'a2', label: 'work' });
});
afterEach(cleanup);

describe('AccountControl', () => {
  it('has no native tooltip on the select', () => {
    render(<AccountControl chatId="c1" />);
    expect(screen.getByTestId('chat-account')).not.toHaveAttribute('title');
  });

  it('reads the account the chat is on, and the list says what each choice does', () => {
    render(<AccountControl chatId="c1" />);
    expect(screen.getByTestId('chat-account')).toHaveTextContent('work');
    act(() => seed({ id: 'a1', label: 'Default' }));
    expect(screen.getByTestId('chat-account')).toHaveTextContent('Default');
    fireEvent.click(screen.getByTestId('chat-account'));
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Switch automatically');
    expect(options[0]).toHaveTextContent('Current: Default');
    expect(options.slice(1).every((o) => o.textContent?.startsWith('Always '))).toBe(true);
  });

  it('offers a Bedrock account only for a chat on its own host, as pay per use', () => {
    const bedrock = (hostId: string) => ({
      hostId,
      awsProfile: 'work-bedrock',
      awsRegion: 'eu-west-2',
      regionPrefix: 'auto',
      monthlyCapUsd: 100,
      spentUsd: 0,
      spentMonth: '2026-11',
    });
    usePreferencesStore.setState({
      shared: {
        secrets: {
          claude: [
            { id: 'a1', label: 'Default', connected: true },
            { id: 'a2', label: 'work', connected: true },
            {
              id: 'b1',
              label: 'Work Bedrock',
              connected: true,
              auto: false,
              bedrock: bedrock('d1'),
            },
            { id: 'b2', label: 'Client X', connected: true, auto: false, bedrock: bedrock('d2') },
          ],
          codex: [],
        },
      },
    } as unknown as Parameters<typeof usePreferencesStore.setState>[0]);
    render(<AccountControl chatId="c1" />);
    fireEvent.click(screen.getByTestId('chat-account'));
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).toContain('Always Work Bedrock (pay per use)');
    expect(labels.some((l) => l?.includes('Client X'))).toBe(false);
    expect(labels).toContain('Always work');
  });

  it('offers an ACP agent’s own accounts for a chat on that agent, so it can be locked', () => {
    usePreferencesStore.setState({
      shared: {
        secrets: {
          claude: [{ id: 'a1', label: 'Default', connected: true }],
          codex: [],
          acp: [
            { id: 'g1', agentId: 'gemini', label: 'Gemini work', last4: '1111' },
            { id: 'g2', agentId: 'gemini', label: 'Gemini home', last4: '2222' },
            { id: 'o1', agentId: 'other', label: 'Other agent', last4: '3333' },
          ],
        },
      },
    } as unknown as Parameters<typeof usePreferencesStore.setState>[0]);
    const row = {
      chatId: 'c2',
      hostId: 'd1',
      model: 'acp/gemini/auto',
      preferredAccountId: null,
      account: { id: 'g1', label: 'Gemini work' },
    } as unknown as ChatRow;
    useChatStore.setState((s) => ({ chats: { ...s.chats, c2: row } }));
    render(<AccountControl chatId="c2" />);
    fireEvent.click(screen.getByTestId('chat-account'));
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('Gemini home'))).toBe(true);
    expect(labels.some((l) => l.includes('Other agent') || l.includes('Default'))).toBe(false);
  });
});
