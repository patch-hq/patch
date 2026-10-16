// One notification when a host pauses an AI account because its sign-in expired.
//
// The host reports `needsSignIn` on the account in `host.account`. This rings
// once per account when it turns true, and re-arms when it clears (signed in
// again), so a host that keeps reporting the same state does not ring again.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { NotificationRouter } from './router.js';

/** Notifications need a chat id; this is not a chat. */
const SIGN_IN_CHAT_ID = 'account-sign-in';

export interface SignInNeededNotifierDeps {
  router: NotificationRouter;
  logger: Pick<Logger, 'warn'>;
}

export class SignInNeededNotifier {
  private readonly notified = new Set<string>();

  constructor(private readonly deps: SignInNeededNotifierDeps) {}

  observe(event: WireEvent): void {
    if (event.type !== 'host.account') return;
    for (const account of event.accounts ?? []) {
      const key = `${event.hostId}/${event.backendId}/${account.id}`;
      if (!account.needsSignIn) {
        this.notified.delete(key);
        continue;
      }
      if (this.notified.has(key)) continue;
      this.notified.add(key);
      const message = `${account.label} needs signing in again — its sign-in expired. Open Settings > Accounts.`;
      for (const channel of ['desktop', 'push'] as const) {
        void this.deps.router
          .route(
            { type: 'notify', chatId: SIGN_IN_CHAT_ID, channel, message, priority: 'urgent' },
            channel === 'push' ? { suppressOn: 'computer' } : {},
          )
          .catch((err: unknown) => {
            this.deps.logger.warn(
              { key, channel, err: (err as Error).message },
              'sign-in-needed: notify failed',
            );
          });
      }
    }
  }
}
