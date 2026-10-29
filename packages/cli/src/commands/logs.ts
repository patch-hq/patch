// `patch logs` — tail the host log over WS.
//
// Host publishes server events on /ws; we open a WS, print everything
// we receive, until SIGINT or `--limit`. JSON mode emits one event per
// line.

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, fail, getTransport, parseLimit, run } from './_common.js';
import { resolveHost } from './hosts.js';
import { loadConfig } from '../config.js';
import { bearerToken } from '../auth.js';
import { PatchWsClient } from '../transport/ws.js';

export function registerLogsCommands(program: Command): void {
  program
    .command('logs')
    .description('Tail host/server events over /ws')
    .option('--json', 'JSON output')
    .option('--limit <n>', 'exit after N events')
    .option('--server <url>', 'override server URL')
    .option('--host <h>', "print that host's daemon.log instead (name or hostId prefix)")
    .option('--lines <n>', 'with --host: last N lines (default 200)')
    .action(
      async (
        opts: CommonOpts & { limit?: string; server?: string; host?: string; lines?: string },
      ) => {
        await run(opts, async () => {
          if (opts.host !== undefined) {
            await printRemoteDaemonLog(opts, opts.host, opts.lines);
            return;
          }
          const config = loadConfig();
          const url = wsUrl(opts.server ?? config.serverUrl);
          let bearer: string | null = null;
          try {
            bearer = bearerToken();
          } catch {
            fail(opts, new Error('not authenticated — run `patch auth login`'));
          }
          const limit =
            opts.limit !== undefined ? parseLimit(opts.limit) : Number.POSITIVE_INFINITY;
          let count = 0;
          const ws = new PatchWsClient({
            url,
            bearer,
            clientType: 'surface-cli',
            clientVersion: '0.0.0',
            noAutoReconnect: true,
          });
          const eventTypes = [
            'chat.spawned',
            'chat.message',
            'chat.tool_call',
            'chat.tool_result',
            'chat.state',
            'chat.stopped',
            'chat.error',
            'host.online',
            'host.offline',
            'notify',
          ] as const;
          await new Promise<void>((resolve, reject) => {
            for (const t of eventTypes) {
              ws.on(t, (event) => {
                count++;
                if (opts.json) emitJson(event);
                else emitText(`${event.type} ${JSON.stringify(event)}`);
                if (count >= limit) {
                  ws.close().then(resolve, reject);
                }
              });
            }
            ws.connect().catch(reject);
            process.on('SIGINT', () => {
              ws.close().then(resolve, reject);
            });
          });
        });
      },
    );
}

/** Read another host's daemon.log through the server's host-files route. */
async function printRemoteDaemonLog(
  opts: CommonOpts,
  host: string,
  linesRaw: string | undefined,
): Promise<void> {
  const lines = linesRaw === undefined ? 200 : parseLimit(linesRaw);
  const hostId = await resolveHost({ ...opts, host });
  const t = getTransport({ ...opts, remote: true });
  const home = await t.get<{ path: string }>(`/api/hosts/${encodeURIComponent(hostId)}/files`);
  const logPath = `${home.path.replace(/\/$/, '')}/.patch/logs/daemon.log`;
  // 256 bytes a line is generous for pino JSON; trimmed to N lines below.
  const res = await t.get<{ content: string }>(
    `/api/hosts/${encodeURIComponent(hostId)}/files/content?path=${encodeURIComponent(logPath)}&tailBytes=${lines * 512}`,
  );
  const tail = res.content
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .slice(-lines);
  if (opts.json) emitJson({ hostId, path: logPath, lines: tail });
  else emitText(tail.join('\n'));
}

function wsUrl(httpUrl: string): string {
  const u = new URL('/ws', httpUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  return u.toString();
}
