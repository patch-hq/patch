// `patch usage` — the account allowance history and the chats which consumed it.

import { Command } from 'commander';
import type { ChatTokenUsage, UsageSample } from '@patch/wire';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';

type Period = 'day' | 'week' | 'month';

interface UsageReport {
  since: number;
  until: number;
  at: number;
  samples: (UsageSample & { hostId: string })[];
  chats: (ChatTokenUsage & { hostId: string })[];
}

function parsePeriod(raw: string): Period {
  if (raw === 'day' || raw === 'week' || raw === 'month') return raw;
  throw new Error(`--period must be day, week or month (got ${raw})`);
}

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Show Claude allowance history and chats ranked by quota consumed')
    .option('--period <period>', 'day, week or month', 'week')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts & { period: string }) => {
      await run(opts, async () => {
        const period = parsePeriod(opts.period);
        // Usage is server-owned. For a local host, force the authenticated
        // server relay rather than trying to read a host-private aggregate.
        const report = await getTransport({ ...opts, remote: true }).get<UsageReport>(
          `/api/usage-report?period=${period}`,
        );
        if (opts.json) {
          emitJson(report);
          return;
        }
        emitText(
          `Usage ${new Date(report.since).toISOString()} to ${new Date(report.until).toISOString()} (read ${new Date(report.at).toISOString()})`,
        );
        if (report.samples.length > 0) {
          const latest = new Map<string, UsageSample & { hostId: string }>();
          for (const sample of report.samples) {
            const previous = latest.get(sample.accountId);
            if (!previous || previous.ts < sample.ts) latest.set(sample.accountId, sample);
          }
          for (const sample of latest.values()) {
            const session =
              sample.session === undefined ? '—' : `${Math.round(sample.session * 100)}%`;
            const week = sample.week === undefined ? '—' : `${Math.round(sample.week * 100)}%`;
            emitText(`allowance  ${sample.label}: session ${session}, week ${week}`);
          }
        }
        if (report.chats.length === 0) {
          emitText('(no completed turns in this window)');
          return;
        }
        emitText('');
        emitText('Chats by tokens:');
        for (const chat of [...report.chats].sort((a, b) => b.tokens - a.tokens)) {
          emitText(
            `${chat.tokens.toLocaleString().padStart(10)}  ${String(chat.turns).padStart(4)} turns  ${chat.name ?? chat.chatId}  [${chat.chatId}]`,
          );
        }
      });
    });
}
