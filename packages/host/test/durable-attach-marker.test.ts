// The reattach marker a restart leaves belongs to one turn. A later message of
// the chat must start a fresh turn, not reattach to a turn that is gone.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

type Marker = { consumed: null; localId: string | undefined };

function daemon(errors: unknown[]): Daemon {
  const home = mkdtempSync(join(tmpdir(), 'attach-marker-'));
  const logger = pino({ level: 'silent' });
  logger.error = ((o: unknown) => errors.push(o)) as typeof logger.error;
  return new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: {} as SdkBackend,
    oauthAccessToken: 'fake-token',
    emit: () => undefined,
    logger,
  });
}

const markers = (d: Daemon) =>
  (d as unknown as { durableAttach: Map<string, Marker> }).durableAttach;

describe('takeDurableAttach', () => {
  it('hands the marker to the turn it was left for', () => {
    const d = daemon([]);
    markers(d).set('c1', { consumed: null, localId: 'L1' });
    expect(d.takeDurableAttach('c1', 'L1')).toBeNull();
  });

  it('drops a marker met by a different turn, and says so', () => {
    const errors: unknown[] = [];
    const d = daemon(errors);
    markers(d).set('c1', { consumed: null, localId: 'L1' });
    expect(d.takeDurableAttach('c1', 'L2')).toBeUndefined();
    expect(markers(d).has('c1')).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('is undefined when no marker was left', () => {
    expect(daemon([]).takeDurableAttach('c1', 'L1')).toBeUndefined();
  });
});
