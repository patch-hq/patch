import { describe, it, expect } from 'vitest';
import {
  PresenceTracker,
  PRESENCE_STALE_MS,
  AWAY_THRESHOLD_MS,
  PAGE_SCOPE_THRESHOLD_MS,
  INPUT_REPORT_STALE_MS,
} from '../src/presence.js';

describe('PresenceTracker', () => {
  it('marks a surface online on connect, then stale after 30s w/o heartbeat', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'web', 1000);
    expect(p.get('acc', 'srf-1')?.status).toBe('online');

    p.sweep(1000 + PRESENCE_STALE_MS - 1);
    expect(p.get('acc', 'srf-1')?.status).toBe('online');

    p.sweep(1000 + PRESENCE_STALE_MS + 1);
    expect(p.get('acc', 'srf-1')?.status).toBe('stale');
  });

  it('a second hello from an already-online surface keeps its input and focus; after going offline it starts fresh', () => {
    const p = new PresenceTracker();
    p.online('acc', 'desk', 'desktop', 1000);
    p.input('acc', 'desk', 0, 1000);
    p.setFocus('acc', 'desk', 'chatX');
    // A second window (or a reconnect that overlaps the first socket) says hello.
    p.online('acc', 'desk', 'desktop', 2000);
    expect(p.isComputerActive('acc', 2000)).toBe(true);
    expect(p.get('acc', 'desk')?.lastFocusedChatId).toBe('chatX');
    // Once every socket is gone the old input is no evidence about the new session.
    p.offline('acc', 'desk');
    p.online('acc', 'desk', 'desktop', 3000);
    expect(p.get('acc', 'desk')?.lastFocusedChatId).toBeUndefined();
    expect(p.isComputerActive('acc', 3000)).toBe(false);
  });

  it('heartbeat resets stale to online', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'web', 1000);
    p.sweep(1000 + PRESENCE_STALE_MS + 1);
    expect(p.get('acc', 'srf-1')?.status).toBe('stale');
    p.heartbeat('acc', 'srf-1', 100_000);
    expect(p.get('acc', 'srf-1')?.status).toBe('online');
  });

  it('throws on heartbeat for unknown surface (NO FALLBACK)', () => {
    const p = new PresenceTracker();
    expect(() => p.heartbeat('acc', 'nope')).toThrowError(/unknown surface/);
  });

  it('snapshot returns all records', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'web');
    p.online('acc', 'srf-2', 'mobile');
    expect(p.snapshot()).toHaveLength(2);
  });

  it('snapshot carries surfaceKind and a derived online boolean (CLI contract)', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'web', 1000);
    p.heartbeat('acc', 'srf-1', 1000);
    const row = p.snapshot().find((r) => r.surfaceId === 'srf-1');
    expect(row?.surfaceKind).toBe('web');
    expect(row?.online).toBe(true);

    // After it goes stale/offline, online is false.
    p.offline('acc', 'srf-1');
    const off = p.snapshot().find((r) => r.surfaceId === 'srf-1');
    expect(off?.online).toBe(false);
    expect(off?.surfaceKind).toBe('web');
  });

  it('offline() on an unknown surface is a silent no-op', () => {
    const p = new PresenceTracker();
    expect(() => p.offline('acc', 'nope')).not.toThrow();
    expect(p.get('acc', 'nope')).toBeUndefined();
  });

  it('drop() removes a tracked surface entirely', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'web', 1000);
    expect(p.get('acc', 'srf-1')).toBeDefined();
    p.drop('acc', 'srf-1');
    expect(p.get('acc', 'srf-1')).toBeUndefined();
  });

  it('setFocus sets and clears lastFocusedChatId', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'web', 1000);
    p.setFocus('acc', 'srf-1', 'chat-1');
    expect(p.get('acc', 'srf-1')?.lastFocusedChatId).toBe('chat-1');
    p.setFocus('acc', 'srf-1', null);
    expect(p.get('acc', 'srf-1')?.lastFocusedChatId).toBeUndefined();
  });

  it('setFocus throws on unknown surface (NO FALLBACK)', () => {
    const p = new PresenceTracker();
    expect(() => p.setFocus('acc', 'nope', 'chat-1')).toThrowError(/unknown surface/);
  });

  it('isActive is true for a phone heartbeated within staleMs, false after', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'mobile', 1000);
    expect(p.isActive('acc', 1000 + PRESENCE_STALE_MS - 1)).toBe(true);
    expect(p.isActive('acc', 1000 + PRESENCE_STALE_MS + 1)).toBe(false);
  });

  it('isActive skips records for a different account', () => {
    const p = new PresenceTracker();
    p.online('other-acc', 'srf-1', 'mobile', 1000);
    expect(p.isActive('acc', 1000)).toBe(false);
  });

  it('isActive skips a record whose status is offline even within staleMs', () => {
    const p = new PresenceTracker();
    p.online('acc', 'srf-1', 'mobile', 1000);
    p.offline('acc', 'srf-1');
    expect(p.isActive('acc', 1000)).toBe(false);
  });

  it('isActive returns false with no records at all', () => {
    const p = new PresenceTracker();
    expect(p.isActive('acc', 1000)).toBe(false);
  });

  // spec/09 ## Presence heuristic — at a computer means TOUCHING it, not a
  // Patch window being open on it.
  describe('isComputerActive', () => {
    it('a visible, heartbeating window with no input reported is not presence', () => {
      for (const kind of ['web', 'desktop'] as const) {
        const p = new PresenceTracker();
        p.online('acc', 'srf-1', kind, 1000);
        p.heartbeat('acc', 'srf-1', 5000);
        expect(p.isComputerActive('acc', 5000)).toBe(false);
        expect(p.isActive('acc', 5000)).toBe(false);
      }
    });

    it('is true for input within a minute, on either computer surface', () => {
      for (const kind of ['web', 'desktop'] as const) {
        const p = new PresenceTracker();
        p.online('acc', 'srf-1', kind, 0);
        p.input('acc', 'srf-1', AWAY_THRESHOLD_MS['1m'] - 1000, 100_000);
        expect(p.isComputerActive('acc', 100_000)).toBe(true);
        // The broad check follows it.
        expect(p.isActive('acc', 100_000)).toBe(true);
      }
    });

    it('goes false once the last input is a minute old', () => {
      const p = new PresenceTracker();
      p.online('acc', 'srf-1', 'desktop', 0);
      p.input('acc', 'srf-1', 0, 100_000);
      expect(p.isComputerActive('acc', 100_000 + INPUT_REPORT_STALE_MS + 1)).toBe(false); // report stale too
      p.input('acc', 'srf-1', AWAY_THRESHOLD_MS['1m'], 200_000);
      expect(p.isComputerActive('acc', 200_000)).toBe(false);
    });

    it('a surface that stops reporting is no evidence, however recent its last input', () => {
      const p = new PresenceTracker();
      p.online('acc', 'srf-1', 'desktop', 0);
      p.input('acc', 'srf-1', 0, 100_000);
      expect(p.isComputerActive('acc', 100_000 + INPUT_REPORT_STALE_MS)).toBe(true);
      expect(p.isComputerActive('acc', 100_000 + INPUT_REPORT_STALE_MS + 1)).toBe(false);
    });

    it('any computer counts: an idle browser does not hide an active desktop', () => {
      const p = new PresenceTracker();
      p.online('acc', 'srf-web', 'web', 0);
      p.online('acc', 'srf-mac', 'desktop', 0);
      p.input('acc', 'srf-web', 600_000, 1_000_000);
      p.input('acc', 'srf-mac', 3_000, 1_000_000);
      expect(p.isComputerActive('acc', 1_000_000)).toBe(true);
    });

    it('is false when only the phone is live, though isActive sees the phone', () => {
      const p = new PresenceTracker();
      p.online('acc', 'srf-phone', 'mobile', 1000);
      expect(p.isComputerActive('acc', 1000)).toBe(false);
      expect(p.isActive('acc', 1000)).toBe(true);
    });

    it('ignores a terminal surface', () => {
      const p = new PresenceTracker();
      p.online('acc', 'srf-cli', 'terminal', 1000);
      expect(p.isComputerActive('acc', 1000)).toBe(false);
    });

    it('skips offline records and other accounts', () => {
      const p = new PresenceTracker();
      p.online('acc', 'srf-1', 'desktop', 0);
      p.input('acc', 'srf-1', 0, 1000);
      p.offline('acc', 'srf-1');
      expect(p.isComputerActive('acc', 1000)).toBe(false);
      p.online('other-acc', 'srf-2', 'web', 0);
      p.input('other-acc', 'srf-2', 0, 1000);
      expect(p.isComputerActive('acc', 1000)).toBe(false);
    });

    it('an input report from an unknown surface is an error', () => {
      const p = new PresenceTracker();
      expect(() => p.input('acc', 'nope', 0, 1000)).toThrow(/unknown surface/);
    });

    describe('away and the Send to my phone after threshold', () => {
      const mk = (setting: '1m' | '5m' | 'lock' = '1m') =>
        new PresenceTracker({ sendToPhoneAfter: () => setting });

      it('a locked or asleep report is away at once, whatever the idle time', () => {
        for (const away of ['locked', 'asleep'] as const) {
          const p = mk();
          p.online('acc', 'mac', 'desktop', 0);
          p.input('acc', 'mac', 0, 1000, { scope: 'system', away });
          expect(p.isComputerActive('acc', 1000)).toBe(false);
          expect(p.computers('acc', 1000)).toEqual([
            { surfaceId: 'mac', surfaceKind: 'desktop', state: 'away', away, scope: 'system' },
          ]);
        }
      });

      it('the next report without away makes the computer active again', () => {
        const p = mk();
        p.online('acc', 'mac', 'desktop', 0);
        p.input('acc', 'mac', 0, 1000, { scope: 'system', away: 'locked' });
        p.input('acc', 'mac', 0, 2000, { scope: 'system' });
        expect(p.isComputerActive('acc', 2000)).toBe(true);
        expect(p.computers('acc', 2000)[0]).toMatchObject({ state: 'active', idleMs: 0 });
      });

      it('1 minute: idle for a minute is away; 5 minutes: not until five', () => {
        const one = mk('1m');
        one.online('acc', 'mac', 'desktop', 0);
        one.input('acc', 'mac', 59_000, 100_000, { scope: 'system' });
        expect(one.isComputerActive('acc', 100_000)).toBe(true);
        one.input('acc', 'mac', 60_000, 100_000, { scope: 'system' });
        expect(one.isComputerActive('acc', 100_000)).toBe(false);
        expect(one.computers('acc', 100_000)[0]).toMatchObject({ state: 'idle', idleMs: 60_000 });

        const five = mk('5m');
        five.online('acc', 'mac', 'desktop', 0);
        five.input('acc', 'mac', 299_000, 400_000, { scope: 'system' });
        expect(five.isComputerActive('acc', 400_000)).toBe(true);
        five.input('acc', 'mac', 300_000, 400_000, { scope: 'system' });
        expect(five.isComputerActive('acc', 400_000)).toBe(false);
      });

      it('Only when I lock: idle time alone never makes a computer inactive, a lock does', () => {
        const p = mk('lock');
        p.online('acc', 'mac', 'desktop', 0);
        p.input('acc', 'mac', 3 * 3_600_000, 4_000_000, { scope: 'system' });
        expect(p.isComputerActive('acc', 4_000_000)).toBe(true);
        p.input('acc', 'mac', 3 * 3_600_000, 4_000_000, { scope: 'system', away: 'locked' });
        expect(p.isComputerActive('acc', 4_000_000)).toBe(false);
      });

      it('page-scope evidence waits five minutes under the 1 minute setting', () => {
        const p = mk('1m');
        p.online('acc', 'tab', 'web', 0);
        p.input('acc', 'tab', 120_000, 500_000, { scope: 'page' });
        expect(p.isComputerActive('acc', 500_000)).toBe(true);
        p.input('acc', 'tab', PAGE_SCOPE_THRESHOLD_MS, 500_000, { scope: 'page' });
        expect(p.isComputerActive('acc', 500_000)).toBe(false);
      });

      it('page-scope evidence uses the chosen threshold under the 5 minute setting', () => {
        const p = mk('5m');
        p.online('acc', 'tab', 'web', 0);
        p.input('acc', 'tab', 299_000, 500_000, { scope: 'page' });
        expect(p.isComputerActive('acc', 500_000)).toBe(true);
      });

      it('the setting is read at each decision, so a change applies at once', () => {
        let setting: '1m' | '5m' = '1m';
        const p = new PresenceTracker({ sendToPhoneAfter: () => setting });
        p.online('acc', 'mac', 'desktop', 0);
        p.input('acc', 'mac', 120_000, 500_000, { scope: 'system' });
        expect(p.isComputerActive('acc', 500_000)).toBe(false);
        setting = '5m';
        expect(p.isComputerActive('acc', 500_000)).toBe(true);
      });

      it('reports each computer: active, idle, away, or not reporting', () => {
        const p = mk();
        p.online('acc', 'a', 'desktop', 0);
        p.online('acc', 'b', 'web', 0);
        p.input('acc', 'a', 5000, 10_000, { scope: 'system' });
        expect(p.computerOf('acc', 'a', 'desktop', 10_000)).toMatchObject({
          state: 'active',
          idleMs: 5000,
        });
        expect(p.computerOf('acc', 'b', 'web', 10_000).state).toBe('not-reporting');
        expect(p.computerOf('acc', 'ghost', 'web', 10_000).state).toBe('not-reporting');
        expect(p.computerOf('acc', 'a', 'desktop', 10_000 + INPUT_REPORT_STALE_MS + 1).state).toBe(
          'not-reporting',
        );
      });
    });
  });
});
