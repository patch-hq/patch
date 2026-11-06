import { describe, it, expect } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { ServerEventsClient } from '../src/serverEventsClient.js';

describe('ServerEventsClient', () => {
  it('subscribes, delivers events, unsubscribes, and ends on link drop', () => {
    const out: WireEvent[] = [];
    let online = true;
    const c = new ServerEventsClient({
      emit: (e) => out.push(e),
      isLinkOnline: () => online,
      idGen: () => 's1',
    });
    const got: unknown[] = [];
    const ended: string[] = [];
    const stop = c.subscribe({ onEvent: (e) => got.push(e), onEnd: (r) => ended.push(r) });
    expect(out[0]).toEqual({ type: 'patch.events.subscribe', subscriptionId: 's1' });
    c.handleEvent({
      type: 'patch.events.event',
      subscriptionId: 's1',
      event: { type: 'notify' },
    } as WireEvent);
    expect(got).toEqual([{ type: 'notify' }]);
    stop();
    expect(out[1]).toEqual({ type: 'patch.events.unsubscribe', subscriptionId: 's1' });
    expect(
      c.handleEvent({ type: 'patch.events.event', subscriptionId: 's1', event: {} } as WireEvent),
    ).toBe(false);

    c.subscribe({ onEvent: () => {}, onEnd: (r) => ended.push(r) });
    c.endAll('dropped');
    expect(ended).toEqual(['dropped']);
  });

  it('refuses to subscribe while the link is offline', () => {
    const c = new ServerEventsClient({ emit: () => {}, isLinkOnline: () => false });
    expect(() => c.subscribe({ onEvent: () => {}, onEnd: () => {} })).toThrow(/offline/);
  });
});
