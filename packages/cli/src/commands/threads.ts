// `patch threads *` — primitives for the two special threads
// (manager / speakers).
//
// Filters the chats list to those whose chatId matches `thread_*` per
// spec/06. send-to is identical to `chats send-to`, but resolved by name.

import { Command } from 'commander';
import type { CommonOpts } from './_common.js';
import { accountChatsPath, emitJson, emitText, getTransport, run } from './_common.js';

interface ChatSummary {
  chatId: string;
  name?: string;
  /** The server's status for the chat (spec/12 § Chat status). */
  chatStatus?: { state: string };
}

const NAME_TO_ID: Record<string, string> = {
  manager: 'thread_manager',
  speakers: 'thread_speakers',
};

export function registerThreadsCommands(program: Command): void {
  const threads = program.command('threads').description('Special-thread ops');

  threads
    .command('list')
    .description('List the two special threads')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport(opts);
        const res = await t.get<{ chats: ChatSummary[] }>(accountChatsPath(t));
        const threads = res.chats.filter((c) => c.chatId.startsWith('thread_'));
        if (opts.json) emitJson({ threads });
        else
          for (const c of threads)
            emitText(`${c.chatId}  ${c.chatStatus?.state ?? '-'}  ${c.name ?? ''}`);
      });
    });

  threads
    .command('send-to <name> <message>')
    .description('Send a message to a named thread')
    .option('--json', 'JSON output')
    .action(async (name: string, message: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const id = NAME_TO_ID[name];
        if (!id) throw new Error(`unknown thread name: ${name} (try manager/speakers)`);
        const t = getTransport(opts);
        if (t.kind === 'uds') {
          const res = await t.post<{ ok: true; queued: boolean }>('/internal/send-to', {
            chatId: id,
            message,
          });
          if (opts.json) emitJson(res);
          else emitText(`queued → ${id}`);
        } else {
          const res = await t.post<{ ok: true; queued: boolean; chatId: string }>(
            `/api/threads/${name}/send-to`,
            { message },
          );
          if (opts.json) emitJson(res);
          else emitText(`queued → ${res.chatId}`);
        }
      });
    });

  // Finished chats → the Manager (spec/06 § Finished chats) — account-wide,
  // server-owned state with no local UDS equivalent: nothing a host can answer
  // on its own, so this always goes straight to the server (`remote: true`).
  threads
    .command('send-finished')
    .description('Deliver the chats finished so far to the Manager now (spec/06 § Finished chats)')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const t = getTransport({ ...opts, remote: true });
        const res = await t.post<{ sent: boolean }>('/api/manager/finished/send-now', {});
        if (opts.json) emitJson(res);
        else emitText(res.sent ? 'sent to the Manager' : 'nothing finished — nothing sent');
      });
    });
}
