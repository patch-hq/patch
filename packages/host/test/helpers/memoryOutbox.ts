// An outbox held in memory, for tests that build a server link but are not
// about what the outbox keeps on disk.

import pino from 'pino';
import { Outbox } from '../../src/outbox.js';

export function memoryOutbox(): Outbox {
  const files = new Map<string, string>();
  return new Outbox({
    path: '/memory/outbox.jsonl',
    logger: pino({ level: 'silent' }),
    fs: {
      existsSync: (p) => files.has(String(p)),
      readFileSync: ((p: string) => files.get(String(p)) ?? '') as never,
      appendFileSync: (p, data) => {
        files.set(String(p), (files.get(String(p)) ?? '') + String(data));
      },
      writeFileSync: (p, data) => {
        files.set(String(p), String(data));
      },
      renameSync: (from, to) => {
        files.set(String(to), files.get(String(from)) ?? '');
        files.delete(String(from));
      },
      mkdirSync: (() => undefined) as never,
    },
  });
}
