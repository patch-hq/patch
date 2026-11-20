import { describe, expect, it } from 'vitest';
import { hasFirstReply } from '../lib/useGuideProgress.js';
import { connectedNames, modelHint } from '../routes/WelcomeRoute.js';
import { usageCardSubtitle } from '../components/AccountUsageStrip.js';
import { strayErrorText } from '../components/StrayProcessBar.js';
import { showsOnlyChatlessPages, type PaneNode } from '../stores/layoutStore.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const msg = (role: 'user' | 'assistant'): ChatEventEntry =>
  ({ seq: 1, at: 1, kind: 'message', role }) as ChatEventEntry;

describe('first-run polish', () => {
  it('ticks the chat step only after an ordinary chat has been answered', () => {
    expect(hasFirstReply({})).toBe(false);
    expect(hasFirstReply({ c1: [msg('user')] })).toBe(false);
    expect(hasFirstReply({ thread_manager: [msg('assistant')] })).toBe(false);
    expect(hasFirstReply({ c1: [msg('user'), msg('assistant')] })).toBe(true);
  });

  it('names a connected account once', () => {
    expect(connectedNames('Claude', [{ label: 'Claude', email: 'a@b.c' }])).toBe('a@b.c');
    expect(connectedNames('Claude', [{ label: 'Claude' }])).toBe('Connected');
    expect(connectedNames('Claude', [{ label: 'Work' }])).toBe('Work');
  });

  it('describes every Claude family', () => {
    for (const id of [
      'claude-fable-5-2',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]) {
      expect(modelHint(id)).toBeTruthy();
    }
    expect(modelHint('claude-fable-5-2')).not.toBe(modelHint('claude-opus-5-5'));
  });

  it('does not repeat the account name on the usage card', () => {
    const base = { label: 'Claude', backend: 'Claude' } as never;
    expect(usageCardSubtitle(base)).toBeUndefined();
    expect(usageCardSubtitle({ label: 'Claude', backend: 'Claude', email: 'a@b.c' } as never)).toBe(
      'a@b.c',
    );
    expect(usageCardSubtitle({ label: 'Work', backend: 'Claude' } as never)).toBe('Claude');
  });

  it('puts daemon_timeout in words', () => {
    expect(strayErrorText('daemon_timeout')).not.toContain('daemon_timeout');
  });

  it('knows when a group shows only pages that belong to no chat', () => {
    const leaf = (descriptor: object): PaneNode =>
      ({
        type: 'leaf',
        id: 'p',
        activeTabId: 't',
        tabs: [{ id: 't', descriptor }],
      }) as never;
    expect(showsOnlyChatlessPages(leaf({ kind: 'page', page: 'settings' }))).toBe(true);
    expect(showsOnlyChatlessPages(leaf({ kind: 'chat', chatId: 'c' }))).toBe(false);
    expect(showsOnlyChatlessPages(leaf({ kind: 'page', page: 'files', chatId: 'c' }))).toBe(false);
  });
});
