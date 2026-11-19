// `patch manager home [--set <host>]` — the Manager's home host (spec/06
// § Changing home, spec/17 § Management subcommands).
//
// Server-owned: the server holds the choice, so this always goes over REST.
// Changing it is a visible handover. The server drafts the message the new
// home's fresh session starts from; the user sees it (and may replace or drop
// it) before anything moves. Interactively that is a y/N question; otherwise
// `--yes` is the confirmation, and without it the command only shows the
// handover it would make.

import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';
import { pickHost, type HostSummary } from './hosts.js';

interface ManagerHomeOpts extends CommonOpts {
  set?: string;
  /** commander's `--message <text>` / `--no-message`: a string, false, or absent. */
  message?: string | false;
  yes?: boolean;
}

type Rest = Pick<ReturnType<typeof getTransport>, 'get' | 'put'>;

export interface ManagerHomeIo {
  say(line: string): void;
  /** Ask y/N; null when there is no terminal to ask on. */
  ask(question: string): Promise<boolean | null>;
}

export type ManagerHomeResult =
  | { hostId: string | null; hostName: string | null }
  | {
      moved: boolean;
      from: { hostId: string; hostName: string | null };
      to: { hostId: string; hostName: string | null };
      message: string;
    };

const label = (h: { hostId: string; hostName: string | null }): string => h.hostName ?? h.hostId;

/** The command's logic, on a transport and an io, so it can be tested without a process. */
export async function managerHome(
  t: Rest,
  opts: ManagerHomeOpts,
  io: ManagerHomeIo,
): Promise<ManagerHomeResult> {
  const { hosts } = await t.get<{ hosts: HostSummary[] }>('/api/hosts');
  const { hostId: current } = await t.get<{ hostId: string | null }>('/api/manager/home');
  const describe = (id: string) => ({
    hostId: id,
    hostName: hosts.find((h) => h.hostId === id)?.hostName ?? null,
  });

  if (opts.set === undefined) {
    if (current === null) return { hostId: null, hostName: null };
    return describe(current);
  }

  if (current === null) throw new Error('no host is registered yet, so the Manager has no home');
  const target = pickHost(hosts, opts.set);
  if (target === current) {
    throw new Error(`${label(describe(target))} is already the Manager's home`);
  }
  const from = describe(current);
  const to = describe(target);
  const message =
    typeof opts.message === 'string'
      ? opts.message
      : opts.message === false
        ? ''
        : (
            await t.get<{ message: string }>(
              `/api/manager/home/draft?hostId=${encodeURIComponent(target)}`,
            )
          ).message;

  let confirmed = opts.yes === true;
  if (!confirmed && !opts.json) {
    io.say(`Move the Manager from ${label(from)} to ${label(to)}.`);
    io.say(`A fresh session starts on ${label(to)}. It is sent this message first:`);
    io.say(message === '' ? '(no message)' : `---\n${message}\n---`);
    const answer = await io.ask('Move? [y/N] ');
    if (answer === null) {
      io.say(
        'Not moved. Run again with --yes to confirm (--message or --no-message to change it).',
      );
    }
    confirmed = answer === true;
  }
  if (!confirmed) return { moved: false, from, to, message };

  await t.put<{ hostId: string }>('/api/manager/home', { hostId: target, message });
  return { moved: true, from, to, message };
}

export function registerManagerCommands(program: Command): void {
  const manager = program.command('manager').description('The Manager thread');

  manager
    .command('home')
    .description("Show the Manager's home host, or move it with --set (a visible handover)")
    .option('--set <host>', 'host name or hostId prefix to make the home')
    .option('--message <text>', 'handover message to send instead of the drafted one')
    .option('--no-message', 'send no handover message')
    .option('--yes', 'confirm the move without asking')
    .option('--json', 'JSON output')
    .action(async (opts: ManagerHomeOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const io: ManagerHomeIo = {
          say: (line) => process.stderr.write(line + '\n'),
          ask: async (question) => {
            if (!process.stdin.isTTY) return null;
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const answer = (await rl.question(question)).trim().toLowerCase();
            rl.close();
            return answer === 'y' || answer === 'yes';
          },
        };
        const result = await managerHome(t, opts, io);
        if (opts.json) {
          emitJson(result);
          return;
        }
        if (!('moved' in result)) {
          emitText(
            result.hostId === null
              ? '(no home: no host registered)'
              : label({ hostId: result.hostId, hostName: result.hostName }),
          );
          return;
        }
        emitText(result.moved ? `Manager moved to ${label(result.to)}` : 'Not moved');
      });
    });
}
