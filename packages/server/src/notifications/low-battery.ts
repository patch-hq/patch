// Low-battery warning for hosts that run scheduled jobs.
//
// A laptop host on battery hibernates when it runs flat, and every cron job it
// owns is missed until someone plugs it in. The host reports its charge in
// `host.host.power`; this rings once per discharge when a host that owns
// enabled cron jobs is on battery below the threshold. Plugging in (or
// rising back to the threshold) re-arms it.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { NotificationRouter } from './router.js';

export const LOW_BATTERY_PERCENT = 20;
/** Notifications need a chat id; this is not a chat. */
const LOW_BATTERY_CHAT_ID = 'host-power';

export interface LowBatteryNotifierDeps {
  router: NotificationRouter;
  logger: Pick<Logger, 'warn'>;
  /** Does this host own at least one enabled cron job? */
  ownsEnabledCronJobs: (hostId: string) => boolean;
}

export class LowBatteryNotifier {
  private readonly warned = new Set<string>();

  constructor(private readonly deps: LowBatteryNotifierDeps) {}

  observe(event: WireEvent): void {
    if (event.type !== 'host.host') return;
    const { power, hostId } = event;
    const low = power !== undefined && power.onBattery && power.percent < LOW_BATTERY_PERCENT;
    if (!low) {
      this.warned.delete(hostId);
      return;
    }
    if (this.warned.has(hostId)) return;
    if (!this.deps.ownsEnabledCronJobs(hostId)) return;
    this.warned.add(hostId);
    const message = `${event.hostName} is on battery at ${power.percent}% — its scheduled jobs will be missed unless it is plugged in`;
    for (const channel of ['desktop', 'push'] as const) {
      void this.deps.router
        .route(
          { type: 'notify', chatId: LOW_BATTERY_CHAT_ID, channel, message, priority: 'urgent' },
          channel === 'push' ? { suppressOn: 'computer' } : {},
        )
        .catch((err: unknown) => {
          this.deps.logger.warn(
            { hostId, channel, err: (err as Error).message },
            'low-battery: notify failed',
          );
        });
    }
  }
}
