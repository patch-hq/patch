// `patch activity` — the user's own messages (spec/17 § CLI, spec/06 §
// Cross-chat toolset).
//
// On a host machine this goes over UDS to the daemon's `/internal/activity`, which asks the
// server on the host's behalf (the same path as the `patch_activity` tool) — so a paired host
// needs no CLI credential. The daemon wants the calling chat to correlate the server round
// trip, so UDS needs PATCH_CHAT_ID (set inside every chat). Off-host it is REST with the CLI
// credential. Either way the answer spans every host's chat logs; only the server gathers them.

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, parseLimit, run } from './_common.js';

interface ActivityMessage {
  chatId: string;
  chatName: string | null;
  hostId: string;
  folder: string;
  text: string;
  ts: number;
}

interface ActivityChatSession {
  chatId: string;
  chatName: string | null;
  hostId: string;
  folder: string;
  start: number;
  end: number;
  durationMs: number;
}

interface ActivityResult {
  messages: ActivityMessage[];
  messagesTruncated: boolean;
  nextMessagesCursor?: number;
  /** Present only with --sessions / --sessions-cursor. */
  chatSessions?: ActivityChatSession[];
  sessionsTruncated?: boolean;
  nextSessionsCursor?: number;
}

/**
 * A `--messages-cursor` value: the ms-epoch the server handed back with a
 * truncated page, so a non-negative integer. Rejected here, with the flag
 * named, rather than forwarded for the server to refuse opaquely.
 */
function parseCursor(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--messages-cursor must be a non-negative integer (got ${raw})`);
  }
  return Number(raw);
}

/** Accepts an ISO-8601 date/time, or a bare ms-epoch integer. */
function parseTimestamp(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} must be an ISO-8601 timestamp or ms-epoch integer (got ${raw})`);
  }
  return parsed;
}

export function registerActivityCommands(program: Command): void {
  program
    .command('activity')
    .description("Read the user's own timeline: messages you sent")
    .option('--since <when>', 'ISO-8601 or ms-epoch; default 24h before --until')
    .option('--until <when>', 'ISO-8601 or ms-epoch; default now')
    .option('--messages-cursor <ms>', 'resume a truncated messages page')
    .option(
      '--sessions',
      'also return chat dwell sessions (chats open on a focused, visible surface)',
    )
    .option('--sessions-cursor <ms>', 'resume a truncated sessions page (implies --sessions)')
    .option('--limit <n>', 'max rows per list (server-capped)')
    .option('--json', 'JSON output')
    .action(
      async (
        opts: CommonOpts & {
          since?: string;
          until?: string;
          messagesCursor?: string;
          sessions?: boolean;
          sessionsCursor?: string;
          limit?: string;
        },
      ) => {
        await run(opts, async () => {
          const until =
            opts.until !== undefined ? parseTimestamp(opts.until, '--until') : Date.now();
          const since =
            opts.since !== undefined
              ? parseTimestamp(opts.since, '--since')
              : until - 24 * 60 * 60 * 1000;
          const t = getTransport(opts);
          const params = new URLSearchParams();
          params.set('since', String(since));
          params.set('until', String(until));
          // Validated client-side like every other --limit (parseLimit's
          // contract), never forwarded as typed.
          if (opts.messagesCursor !== undefined) {
            params.set('messagesCursor', String(parseCursor(opts.messagesCursor)));
          }
          if (opts.sessions) params.set('includeSessions', 'true');
          if (opts.sessionsCursor !== undefined) params.set('sessionsCursor', opts.sessionsCursor);
          if (opts.limit !== undefined) params.set('limit', String(parseLimit(opts.limit)));
          if (t.kind === 'uds') {
            const callerChatId = process.env['PATCH_CHAT_ID'];
            if (!callerChatId) {
              throw new Error(
                'patch activity over the host socket needs PATCH_CHAT_ID (run it inside a chat), or use --remote with a CLI credential',
              );
            }
            params.set('callerChatId', callerChatId);
          }
          const res = await t.get<ActivityResult>(
            `${t.kind === 'uds' ? '/internal/activity' : '/api/activity'}?${params.toString()}`,
          );
          if (opts.json) {
            emitJson(res);
            return;
          }
          const sessions = res.chatSessions ?? [];
          if (res.messages.length === 0 && sessions.length === 0) {
            emitText('(no activity in this window)');
            return;
          }
          for (const s of sessions) {
            emitText(
              `[open]    ${new Date(s.start).toISOString()}  ${Math.round(s.durationMs / 1000)}s  ${s.folder}  ${s.chatName ?? s.chatId}`,
            );
          }
          if (res.sessionsTruncated)
            emitText(
              `(sessions truncated — resume with --sessions-cursor ${res.nextSessionsCursor})`,
            );
          for (const m of res.messages) {
            emitText(`[sent]    ${new Date(m.ts).toISOString()}  ${m.folder}  ${m.text}`);
          }
          if (res.messagesTruncated)
            emitText(
              `(messages truncated — resume with --messages-cursor ${res.nextMessagesCursor})`,
            );
        });
      },
    );
}
