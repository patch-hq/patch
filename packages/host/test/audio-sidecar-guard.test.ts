import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import pino from 'pino';
import { reclaimPort, killOnHostExit } from '../src/audio/sidecarGuard.js';

const logger = pino({ level: 'silent' });

describe('sidecarGuard', () => {
  it('kills a stale listener holding the port', async () => {
    const free = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    const stale = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${free},'127.0.0.1');setInterval(()=>{},1000)`],
      { stdio: 'ignore' },
    );
    killOnHostExit(stale);
    await new Promise((r) => setTimeout(r, 500));
    await reclaimPort(free, 'test', logger);
    await new Promise<void>((res, rej) => {
      const s = net
        .createServer()
        .once('error', rej)
        .listen(free, '127.0.0.1', () => s.close(() => res()));
    });
  });

  it('is a no-op when nothing listens', async () => {
    await expect(reclaimPort(59999, 'test', logger)).resolves.toBeUndefined();
  });
});
