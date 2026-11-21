// The limit card says what happens next (spec/12 § A usage or rate limit), and a
// chat stopped for credit is offered Continue when credit is back — it is never
// re-run on its own (decision 25).
import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RateLimitCard, limitNextText } from '../components/RateLimitCard.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';

function row(over: Partial<ChatRow>): ChatRow {
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'test chat',
      folder: '/tmp/foo',
      chatStatus: { state: 'failed', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      rateLimitResumingAt: null,
      resumeKind: 'rate_limit',
    },
  ]);
  return { ...useChatStore.getState().chats['c1']!, ...over };
}

describe('the limit card under decision 25', () => {
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });

  it('a chat whose credit came back offers Continue, and Continue re-sends the turn', () => {
    const sent: unknown[] = [];
    setActiveWs({ send: (e: unknown) => sent.push(e) } as never);
    render(
      <MemoryRouter>
        <RateLimitCard row={row({ creditReturned: true, limitNext: 'ask' })} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('rate-limit-headline').textContent).toMatch(/Credit available again/);
    const send = screen.getByTestId('rate-limit-send');
    expect(send.textContent).toBe('Continue');
    expect(send.getAttribute('data-enabled')).toBe('true');
    fireEvent.click(send);
    expect(sent).toContainEqual({ type: 'chat.resume_now_request', chatId: 'c1' });
  });

  it('out of credit says nothing runs until the user continues', () => {
    render(
      <MemoryRouter>
        <RateLimitCard row={row({ limitBlock: { scope: 'unknown' }, limitNext: 'ask' })} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('rate-limit-next').textContent).toMatch(/until you continue/);
    expect(screen.getByTestId('rate-limit-send').textContent).toBe('Continue');
  });

  it('with a single account never says it continues on the next account', () => {
    render(
      <MemoryRouter>
        <RateLimitCard row={row({ limitBlock: { scope: 'week' }, limitNext: 'other_account' })} />
      </MemoryRouter>,
    );
    const next = screen.getByTestId('rate-limit-next');
    expect(next.textContent).not.toMatch(/next account/);
    expect(next.textContent).toMatch(/only account/);
    expect(screen.getByTestId('rate-limit-add-account').getAttribute('href')).toBe('/connect');
  });

  it('says what each behaviour will do', () => {
    expect(limitNextText('resume_at_reset', false)).toMatch(/resets/);
    expect(limitNextText('other_account', false)).toMatch(/next account/);
    expect(limitNextText('switch_provider', false)).toMatch(/switch provider/);
    expect(limitNextText(null, false)).toBeNull();
  });
});
