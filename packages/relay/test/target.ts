// The relay the relay suite runs against. By default each test starts a Node
// relay of its own. With PATCH_RELAY_TEST_URL set (an http(s) or ws(s) base
// address) the same tests run against that relay instead: the Cloudflare Worker
// under `wrangler dev` (packages/relay-worker/test/run.mjs) or the deployed one.
// An external relay cannot be restarted or looked inside, so the suite asks it
// questions a device could ask, and reads its limits from /healthz.

import WebSocket from 'ws';
import {
  createRelayServer,
  type RelayServerHandle,
  type RelayServerOptions,
} from '../src/server.js';

const EXTERNAL = process.env['PATCH_RELAY_TEST_URL']?.replace(/\/+$/, '') || null;

/** True when the suite is running against a relay it did not start. */
export const external = EXTERNAL !== null;

/**
 * How much longer than on loopback to wait for anything. A relay across the
 * internet needs some slack; the Worker under `wrangler dev` needs more, because
 * local workerd holds a connection open ~10 s after a close handshake the relay
 * started (the deployed Worker ends it at once), and the socket only reports
 * closed then. PATCH_RELAY_TEST_PATIENCE says how much.
 */
const PATIENCE = Number(process.env['PATCH_RELAY_TEST_PATIENCE'] || (external ? 4 : 1));
if (!Number.isFinite(PATIENCE) || PATIENCE < 1) {
  throw new Error(`PATCH_RELAY_TEST_PATIENCE must be a number >= 1`);
}

/** Scale a wait to the relay under test. */
export const budget = (ms: number): number => ms * PATIENCE;

export interface RelayLimits {
  maxClientsPerChannel: number;
  maxMessageBytes: number;
  helloTimeoutMs: number;
}

export interface TestRelay {
  /** The `ws(s)://` base devices and servers dial. */
  url: string;
  /** The `http(s)://` base, for /healthz. */
  httpUrl: string;
  limits: RelayLimits;
  /** The Node relay when the suite started one; null for an external relay. */
  local: RelayServerHandle | null;
  close(): Promise<void>;
}

const DEFAULTS: RelayLimits = {
  maxClientsPerChannel: 16,
  maxMessageBytes: 128 * 1024,
  helloTimeoutMs: 10_000,
};

/**
 * A relay for one test. `opts` configure a local relay; an external relay has
 * the limits it was deployed with, which the tests read rather than assume.
 */
export async function startRelay(
  opts: Omit<RelayServerOptions, 'port' | 'host'> & { port?: number } = {},
): Promise<TestRelay> {
  if (EXTERNAL) {
    const httpUrl = EXTERNAL.replace(/^ws/, 'http');
    const res = await fetch(`${httpUrl}/healthz`);
    if (!res.ok) throw new Error(`${httpUrl}/healthz answered ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; limits?: RelayLimits };
    if (body.ok !== true || !body.limits) {
      throw new Error(`${httpUrl}/healthz did not report its limits: ${JSON.stringify(body)}`);
    }
    return {
      url: httpUrl.replace(/^http/, 'ws'),
      httpUrl,
      limits: body.limits,
      local: null,
      close: async () => undefined,
    };
  }
  const local = await createRelayServer({ port: 0, host: '127.0.0.1', ...opts });
  return {
    url: `ws://127.0.0.1:${local.port}`,
    httpUrl: `http://127.0.0.1:${local.port}`,
    limits: {
      maxClientsPerChannel: opts.maxClientsPerChannel ?? DEFAULTS.maxClientsPerChannel,
      maxMessageBytes: opts.maxMessageBytes ?? DEFAULTS.maxMessageBytes,
      helloTimeoutMs: opts.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs,
    },
    local,
    close: () => local.close(),
  };
}

/**
 * Whether a server holds `channel`, asked the way a device would: dial it as a
 * client and see whether the relay says ready or "server offline".
 */
export function serverOnline(relayUrl: string, channel: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${relayUrl}/v1/connect?channel=${channel}&role=client`);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary && (JSON.parse(data.toString()) as { type?: string }).type === 'ready') {
        ws.close();
        resolve(true);
      }
    });
    ws.on('close', (code: number) => {
      if (code === 4404) resolve(false);
    });
    ws.on('error', (e) => reject(e));
  });
}

/** Wait until nothing holds `channel` any more. */
export async function untilOffline(relayUrl: string, channel: string, ms = 3000): Promise<void> {
  const end = Date.now() + budget(ms);
  while (await serverOnline(relayUrl, channel)) {
    if (Date.now() > end) throw new Error(`a server still holds ${channel}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
