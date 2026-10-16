import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import type { NotifyEvent, WireEvent } from '@patch/wire';
import { SignInNeededNotifier } from '../src/notifications/sign-in-needed.js';
import type { NotificationRouter } from '../src/notifications/router.js';

const report = (needsSignIn: boolean): WireEvent =>
  ({
    type: 'host.account',
    hostId: 'mac',
    backendId: 'codex',
    connected: false,
    accounts: [
      { id: 'a', label: 'ChatGPT Sub', connected: false, ...(needsSignIn ? { needsSignIn } : {}) },
    ],
  }) as WireEvent;

describe('SignInNeededNotifier', () => {
  let routed: NotifyEvent[];
  let notifier: SignInNeededNotifier;
  beforeEach(() => {
    routed = [];
    const router = {
      route: async (event: NotifyEvent) => {
        routed.push(event);
      },
    } as unknown as NotificationRouter;
    notifier = new SignInNeededNotifier({ router, logger: pino({ level: 'silent' }) });
  });

  test('notifies once however often the host repeats the state', () => {
    for (let i = 0; i < 5; i++) notifier.observe(report(true));
    expect(routed.map((e) => e.channel).sort()).toEqual(['desktop', 'push']);
    // Tapping must open settings, not look up the placeholder chat id.
    expect(routed.every((e) => e.kind === 'sign-in')).toBe(true);
    expect(routed[0]!.message).toMatch(/ChatGPT Sub.*sign/i);
  });

  test('notifies again after the account was signed in and expired again', () => {
    notifier.observe(report(true));
    notifier.observe(report(false));
    notifier.observe(report(true));
    expect(routed).toHaveLength(4);
  });

  test('stays quiet for healthy accounts and other events', () => {
    notifier.observe(report(false));
    notifier.observe({ type: 'host.host', hostId: 'mac' } as WireEvent);
    expect(routed).toHaveLength(0);
  });
});
