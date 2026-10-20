import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SERVER_LOST_AFTER_MS,
  readHostLink,
  serverLostText,
  serverWatchState,
  watchServerLink,
  type HostLinkReport,
} from './server-watch';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('serverWatchState', () => {
  it('is fine while online or inside the minute', () => {
    assert.deepEqual(serverWatchState({ online: true, offlineSince: null }, 1e6), { lost: false });
    assert.deepEqual(
      serverWatchState({ online: false, offlineSince: 1e6 - SERVER_LOST_AFTER_MS }, 1e6),
      { lost: false },
    );
  });
  it('is lost once the minute has passed', () => {
    assert.deepEqual(
      serverWatchState({ online: false, offlineSince: 0 }, SERVER_LOST_AFTER_MS + 1),
      {
        lost: true,
        sinceMs: SERVER_LOST_AFTER_MS + 1,
      },
    );
  });
  it('words the outage in minutes', () => {
    assert.match(serverLostText(120_000), /2 min/);
  });
});

describe('watchServerLink', () => {
  it('reports lost then restored once each, and errors loudly', async () => {
    const now = 1_000_000;
    let report: HostLinkReport = { online: false, offlineSince: now - 90_000 };
    let fail = false;
    const calls = { lost: 0, restored: 0, error: 0 };
    const stop = watchServerLink({
      read: async () => {
        if (fail) throw new Error('host not running');
        return report;
      },
      onLost: () => calls.lost++,
      onRestored: () => calls.restored++,
      onError: () => calls.error++,
      intervalMs: 10,
      now: () => now,
    });
    await sleep(45);
    assert.equal(calls.lost > 0, true);
    report = { online: true, offlineSince: null };
    await sleep(45);
    assert.equal(calls.restored, 1);
    fail = true;
    await sleep(45);
    stop();
    assert.equal(calls.error > 0, true);
    assert.equal(calls.restored, 1);
  });
});

describe('readHostLink', () => {
  it('reads the live host control socket with the local key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-sw-'));
    writeFileSync(join(home, 'local.key'), 'secret\n');
    const srv = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer secret' || req.url !== '/internal/diag/link') {
        res.statusCode = 401;
        return res.end();
      }
      res.end(JSON.stringify({ online: false, offlineSince: 42 }));
    });
    await new Promise<void>((r) => srv.listen(join(home, 'host.sock'), r));
    try {
      const got = await readHostLink(home);
      assert.equal(got.online, false);
      assert.equal(got.offlineSince, 42);
    } finally {
      srv.close();
    }
  });
});
