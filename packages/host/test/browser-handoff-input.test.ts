// The user's input during a browser hand-off reaches the tab one event at a
// time, in order, with a burst of pointer moves collapsed to the newest.

import { it, expect } from 'vitest';
import pino from 'pino';
import type { BrowserHandoffInput, WireEvent } from '@patch/wire';
import type { BrowserManager } from '../src/browser.js';
import { BrowserHandoff } from '../src/browserHandoff.js';

it('runs inputs in order, one at a time, and drops moves a newer move replaced', async () => {
  const done: BrowserHandoffInput[] = [];
  let running = 0;
  let overlapped = false;
  const fake = {
    beginHandoff: () => undefined,
    endHandoff: () => undefined,
    isHandedOff: () => true,
    redactedUrl: () => 'https://example.com/',
    screencast: async () => ({ stop: async () => undefined, refresh: async () => undefined }),
    viewerOf: () => undefined,
    ownerOf: () => 'c1',
    driverOf: () => 'agent',
    setViewerViewport: async () => undefined,
    userInput: async (_tab: string, input: BrowserHandoffInput) => {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      done.push(input);
      running--;
    },
  } as unknown as BrowserManager;
  const events: WireEvent[] = [];
  const handoff = new BrowserHandoff({
    browser: fake,
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
  });
  const run = handoff.request({ chatId: 'c1', tabId: 't1', reason: 'x' });
  const { handoffId } = events.find((e) => e.type === 'patch.browser_handoff.state') as {
    handoffId: string;
  };

  const move = (x: number): BrowserHandoffInput => ({ kind: 'pointer', action: 'move', x, y: 1 });
  const click: BrowserHandoffInput = { kind: 'pointer', action: 'click', x: 9, y: 9 };
  void handoff.input('c1', handoffId, move(1));
  void handoff.input('c1', handoffId, move(2));
  void handoff.input('c1', handoffId, move(3));
  void handoff.input('c1', handoffId, click);
  await handoff.input('c1', handoffId, { kind: 'text', text: 'a' });

  expect(overlapped).toBe(false);
  expect(done).toEqual([move(3), click, { kind: 'text', text: 'a' }]);

  handoff.control('c1', 'done', handoffId);
  expect((await run).outcome).toBe('done');
  handoff.dispose();
});

it('takes the tab over on a press or a key, not on a move or a scroll, and drives in order', async () => {
  const done: string[] = [];
  let driver: 'agent' | 'user' = 'agent';
  const fake = {
    isHandedOff: () => false,
    ownerOf: (tab: string) => (tab === 't1' ? 'c1' : undefined),
    driverOf: () => driver,
    setDriver: (_tab: string, d: 'agent' | 'user') => {
      driver = d;
      done.push(`driver:${d}`);
    },
    viewInput: async (_tab: string, input: { kind: string; action?: string }) => {
      await new Promise((r) => setTimeout(r, 2));
      done.push(`${input.kind}${input.action ? `:${input.action}` : ''}`);
      return input.kind === 'copy' ? 'selected words' : undefined;
    },
  } as unknown as BrowserManager;
  const events: WireEvent[] = [];
  const handoff = new BrowserHandoff({
    browser: fake,
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
  });
  await handoff.viewInput('c1', 't1', { kind: 'pointer', action: 'move', x: 1, y: 1 });
  await handoff.viewInput('c1', 't1', { kind: 'scroll', x: 1, y: 1, dx: 0, dy: 40 });
  expect(driver).toBe('agent');
  void handoff.viewInput('c1', 't1', { kind: 'pointer', action: 'down', x: 5, y: 5 });
  void handoff.viewInput('c1', 't1', { kind: 'pointer', action: 'move', x: 9, y: 5 });
  await handoff.viewInput('c1', 't1', { kind: 'pointer', action: 'up', x: 9, y: 5 });
  await handoff.viewInput('c1', 't1', { kind: 'copy' });
  expect(done).toEqual([
    'pointer:move',
    'scroll',
    'driver:user',
    'pointer:down',
    'pointer:move',
    'pointer:up',
    'copy',
  ]);
  expect(events).toContainEqual({
    type: 'patch.browser_view.clipboard',
    chatId: 'c1',
    tabId: 't1',
    text: 'selected words',
  });

  // Another chat's tab is not this chat's to touch.
  await handoff.viewInput('c2', 't1', { kind: 'text', text: 'x' });
  expect(done).not.toContain('text');

  handoff.drive('c1', 't1', 'agent');
  expect(driver).toBe('agent');
  handoff.dispose();
});
