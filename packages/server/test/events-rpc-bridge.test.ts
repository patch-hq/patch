import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { InProcessHostLink } from '../src/host-link.js';
import { attachEventsRpcBridge } from '../src/events-rpc-bridge.js';

function setup() {
  const link = new InProcessHostLink();
  link.addOnlineHost('host-1');
  let tap: (e: WireEvent) => void = () => {};
  const detach = attachEventsRpcBridge({
    link,
    onBroadcast: (t) => {
      tap = t;
      return () => {};
    },
    logger: pino({ enabled: false }),
  });
  const relayed = () => link.sent.filter((s) => s.event.type === 'patch.events.event');
  return { link, publish: (e: WireEvent) => tap(e), relayed, detach };
}
const msg = { type: 'host.online', hostId: 'h' } as unknown as WireEvent;

describe('events rpc bridge', () => {
  it('relays only to a subscribed machine, only log event types, until unsubscribed', () => {
    const { link, publish, relayed } = setup();
    publish(msg);
    expect(relayed()).toHaveLength(0);

    link.emit({ type: 'patch.events.subscribe', subscriptionId: 's1' } as WireEvent, 'host-1');
    publish(msg);
    publish({ type: 'settings.changed' } as unknown as WireEvent);
    expect(relayed()).toHaveLength(1);
    expect(relayed()[0]).toMatchObject({
      hostId: 'host-1',
      event: { subscriptionId: 's1', event: { type: 'host.online' } },
    });

    link.emit({ type: 'patch.events.unsubscribe', subscriptionId: 's1' } as WireEvent, 'host-1');
    publish(msg);
    expect(relayed()).toHaveLength(1);
  });

  it('forgets a machine whose link drops', () => {
    const { link, publish, relayed } = setup();
    link.emit({ type: 'patch.events.subscribe', subscriptionId: 's1' } as WireEvent, 'host-1');
    link.dropOnlineHost('host-1');
    link.addOnlineHost('host-1');
    publish(msg);
    expect(relayed()).toHaveLength(0);
  });
});
