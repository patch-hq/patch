import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import type { NotifyEvent, WireEvent } from '@patch/wire';
import { LowBatteryNotifier } from '../src/notifications/low-battery.js';
import type { NotificationRouter, RouteOptions } from '../src/notifications/router.js';

const logger = pino({ level: 'silent' });

function report(hostId: string, power?: { onBattery: boolean; percent: number }): WireEvent {
  return {
    type: 'host.host',
    hostId,
    hostName: 'Tom Mac',
    ...(power ? { power } : {}),
  } as WireEvent;
}

describe('LowBatteryNotifier', () => {
  let routed: { event: NotifyEvent; opts: RouteOptions }[];
  let ownsJobs: Record<string, boolean>;
  let notifier: LowBatteryNotifier;

  beforeEach(() => {
    routed = [];
    ownsJobs = { mac: true, other: false };
    const router = {
      route: async (event: NotifyEvent, opts: RouteOptions = {}) => {
        routed.push({ event, opts });
      },
    } as unknown as NotificationRouter;
    notifier = new LowBatteryNotifier({
      router,
      logger,
      ownsEnabledCronJobs: (hostId) => ownsJobs[hostId] ?? false,
    });
  });

  const texts = () => routed.map((r) => r.event.message);

  test('warns on desktop and push when a job host is on battery under 20%', () => {
    notifier.observe(report('mac', { onBattery: true, percent: 12 }));
    expect(routed.map((r) => r.event.channel).sort()).toEqual(['desktop', 'push']);
    expect(texts()[0]).toMatch(/Tom Mac.*12%.*plug/i);
  });

  test('warns once per discharge, not on every report', () => {
    notifier.observe(report('mac', { onBattery: true, percent: 15 }));
    notifier.observe(report('mac', { onBattery: true, percent: 10 }));
    notifier.observe(report('mac', { onBattery: true, percent: 1 }));
    expect(routed).toHaveLength(2);
  });

  test('warns again after it was plugged in and ran low again', () => {
    notifier.observe(report('mac', { onBattery: true, percent: 15 }));
    notifier.observe(report('mac', { onBattery: false, percent: 30 }));
    notifier.observe(report('mac', { onBattery: true, percent: 19 }));
    expect(routed).toHaveLength(4);
  });

  test('stays quiet at 20% or more, on AC, or with no battery', () => {
    notifier.observe(report('mac', { onBattery: true, percent: 20 }));
    notifier.observe(report('mac', { onBattery: false, percent: 5 }));
    notifier.observe(report('mac'));
    expect(routed).toHaveLength(0);
  });

  test('stays quiet for a host that owns no enabled cron jobs', () => {
    notifier.observe(report('other', { onBattery: true, percent: 3 }));
    expect(routed).toHaveLength(0);
  });

  test('ignores other events', () => {
    notifier.observe({ type: 'notify', chatId: 'c', message: 'x' } as WireEvent);
    expect(routed).toHaveLength(0);
  });
});
