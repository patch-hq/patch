// Settings → Computer use: status() reports when the agent is driving the
// machine, stop() closes its windows and cancels what it was doing. Uses
// stub pages injected into the manager — the real-Chromium behaviour is
// covered by browser.test.ts; this is the bookkeeping around it.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { BrowserManager, BrowserStoppedError } from '../src/browser.js';

interface FakePage {
  closed: boolean;
  release: () => void;
  page: unknown;
}

function manager(): { m: BrowserManager; addTab: (id: string) => FakePage } {
  const m = new BrowserManager({ root: '/tmp/unused', logger: pino({ level: 'silent' }) });
  const addTab = (id: string): FakePage => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake: FakePage = { closed: false, release, page: null };
    let rejectGate!: (e: Error) => void;
    const dead = new Promise<void>((_, rej) => (rejectGate = rej));
    dead.catch(() => {});
    const locator = {
      count: async () => 1,
      first: () => locator,
      boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 }),
      click: async () => {
        await Promise.race([gate, dead]);
      },
    };
    fake.page = {
      waitForTimeout: async () => {},
      locator: () => locator,
      frames: () => [{ locator: () => locator }],
      isClosed: () => fake.closed,
      url: () => 'about:blank',
      close: async () => {
        fake.closed = true;
        rejectGate(new Error('Target page, context or browser has been closed'));
      },
    };
    (m as unknown as { tabsById: Map<string, unknown> }).tabsById.set(id, {
      tabId: id,
      page: fake.page,
      profile: 'logged-in',
      lastUrl: 'about:blank',
      crashed: false,
      contextDead: false,
      notices: [],
    });
    return fake;
  };
  return { m, addTab };
}

describe('Computer use status and stop', () => {
  it('is idle with no windows by default', () => {
    expect(manager().m.status()).toEqual({ active: false, tabs: 0 });
  });

  it('reports a running click as active with a label, and idle after', async () => {
    const { m, addTab } = manager();
    const tab = addTab('t1');
    const run = m.click('t1', 'e1');
    await new Promise((r) => setTimeout(r, 10));
    const during = m.status();
    expect(during.active).toBe(true);
    expect(during.action).toBe('Clicking');
    expect(during.tabs).toBe(1);
    tab.release();
    await run;
    expect(m.status()).toMatchObject({ active: false, tabs: 1 });
  });

  it('stop closes every window and cancels the in-flight action with BrowserStoppedError', async () => {
    const { m, addTab } = manager();
    const a = addTab('t1');
    const b = addTab('t2');
    const run = m.click('t1', 'e1');
    const outcome = run.then(
      () => 'ok',
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(await m.stop()).toBe(2);
    expect(await outcome).toBeInstanceOf(BrowserStoppedError);
    expect(a.closed && b.closed).toBe(true);
    const st = m.status();
    expect(st).toMatchObject({ active: false, tabs: 0 });
    expect(st.lastStoppedAt).toBeTypeOf('number');
  });
});
