// Voice-session concurrency arbiter (spec/16 §Concurrency with phone Manager
// call). Priority: phone-active-call > device-active-session > idle > push.

import { describe, it, expect } from 'vitest';
import { VoiceConcurrencyArbiter } from '../src/devices/concurrency.js';

function ev(deviceId: string, ran: string[]) {
  return { kind: 'device-ring' as const, deviceId, run: () => ran.push(deviceId) };
}

describe('VoiceConcurrencyArbiter', () => {
  it('admits an idle device when nothing else is active', () => {
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => false });
    expect(a.admit(ev('kitchen', [])).decision).toBe('admit');
  });

  it('queues a device ring while a phone call is active, releases on call end', () => {
    let phone = true;
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => phone });
    const d = a.admit(ev('kitchen', ran));
    expect(d).toEqual({ decision: 'queued', reason: 'phone-call-active' });
    expect(ran).toEqual([]); // not run while phone busy
    expect(a.queueDepth()).toBe(1);

    phone = false;
    const released = a.onPhoneCallEnded();
    expect(released.map((e) => e.deviceId)).toEqual(['kitchen']);
    expect(ran).toEqual(['kitchen']); // ran on release
    expect(a.isActive('kitchen')).toBe(true);
  });

  it('admits a second device in parallel below the cap (spec/07 concurrency)', () => {
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => false, cap: 3 });
    expect(a.admit(ev('kitchen', ran)).decision).toBe('admit');
    a.markActive('kitchen');
    // Below the cap of 3, a second device runs concurrently — NOT queued.
    expect(a.admit(ev('bedroom', ran)).decision).toBe('admit');
    a.markActive('bedroom');
    expect(a.activeCount()).toBe(2);
  });

  it('queues a device once the concurrency cap is reached, drains on release', () => {
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => false, cap: 1 });
    expect(a.admit(ev('kitchen', ran)).decision).toBe('admit');
    a.markActive('kitchen');

    // At the cap (1 active) → next device queues.
    const d = a.admit(ev('bedroom', ran));
    expect(d).toEqual({ decision: 'queued', reason: 'device-session-active' });

    // kitchen session ends → bedroom drains.
    const released = a.release('kitchen');
    expect(released.map((e) => e.deviceId)).toEqual(['bedroom']);
    expect(ran).toEqual(['bedroom']);
    expect(a.isActive('bedroom')).toBe(true);
    expect(a.isActive('kitchen')).toBe(false);
  });

  it('drops a queued event whose device is no longer eligible (socket gone)', () => {
    const ran: string[] = [];
    const connected = new Set(['kitchen', 'bedroom']);
    const a = new VoiceConcurrencyArbiter({
      isPhoneCallActive: () => false,
      cap: 1,
      isEligible: (id) => connected.has(id),
    });
    a.markActive('kitchen');
    a.admit(ev('bedroom', ran)); // queued behind kitchen (cap 1)
    expect(a.queueDepth()).toBe(1);

    // bedroom's socket drops while queued.
    connected.delete('bedroom');
    // kitchen frees up → drain re-validates: bedroom is ineligible → dropped,
    // NOT run, and no slot is held by the gone device.
    const released = a.release('kitchen');
    expect(released).toEqual([]);
    expect(ran).toEqual([]);
    expect(a.activeCount()).toBe(0);
    expect(a.isActive('bedroom')).toBe(false);
  });

  it('rejects a duplicate request for an already-active device (no self-queue)', () => {
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => false });
    a.markActive('kitchen');
    expect(a.admit(ev('kitchen', [])).decision).toBe('rejected');
    expect(a.queueDepth()).toBe(0);
  });

  it('fills the whole cap when a phone call ends, not one device of it', () => {
    // Production runs cap 3 (local whisper) or 4 (Groq). A call that several
    // devices rang during frees EVERY slot at once, so draining a single event
    // leaves the rest silent behind idle capacity until some other session
    // happens to end.
    let phone = true;
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => phone, cap: 3 });
    a.admit(ev('kitchen', ran));
    a.admit(ev('bedroom', ran));
    a.admit(ev('study', ran));
    expect(a.queueDepth()).toBe(3);

    phone = false;
    const released = a.onPhoneCallEnded();
    expect(released.map((e) => e.deviceId)).toEqual(['kitchen', 'bedroom', 'study']);
    expect(ran).toEqual(['kitchen', 'bedroom', 'study']);
    expect(a.activeCount()).toBe(3);
    expect(a.queueDepth()).toBe(0);
  });

  it('stops draining at the cap and leaves the remainder queued', () => {
    let phone = true;
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => phone, cap: 2 });
    a.admit(ev('kitchen', ran));
    a.admit(ev('bedroom', ran));
    a.admit(ev('study', ran));

    phone = false;
    expect(a.onPhoneCallEnded().map((e) => e.deviceId)).toEqual(['kitchen', 'bedroom']);
    expect(a.queueDepth()).toBe(1);
    // One slot frees → exactly one more comes off the queue.
    expect(a.release('kitchen').map((e) => e.deviceId)).toEqual(['study']);
    expect(ran).toEqual(['kitchen', 'bedroom', 'study']);
  });

  it('phone call still blocks the queue drain even after a device frees up', () => {
    let phone = false;
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => phone });
    a.markActive('kitchen');
    a.admit(ev('bedroom', ran)); // queued behind kitchen
    phone = true; // a phone call started meanwhile
    const released = a.release('kitchen');
    expect(released).toEqual([]); // phone call blocks the drain
    expect(ran).toEqual([]);
    phone = false;
    expect(a.onPhoneCallEnded().map((e) => e.deviceId)).toEqual(['bedroom']);
    expect(ran).toEqual(['bedroom']);
  });

  it('a phone call ending starts every queued event that fits under the cap, not just one', () => {
    let phone = true;
    const ran: string[] = [];
    const a = new VoiceConcurrencyArbiter({ isPhoneCallActive: () => phone, cap: 3 });
    a.admit(ev('kitchen', ran));
    a.admit(ev('bedroom', ran));
    a.admit(ev('office', ran));
    a.admit(ev('hall', ran));
    phone = false;
    a.onPhoneCallEnded();
    expect(ran).toEqual(['kitchen', 'bedroom', 'office']);
    expect(a.activeCount()).toBe(3);
    expect(a.queueDepth()).toBe(1);
  });
});
