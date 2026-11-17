// "Continue" after a stop must not lose the question it continues.
//
// A turn stopped before the model answered leaves a track of bare prompts; the
// session store drops those, so the next send used to start a fresh session
// that saw only the word "Continue".

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe('continue after a stopped, unanswered turn', () => {
  it('hands the model the question it never answered', async () => {
    const prompts: string[] = [];
    const backend: SdkBackend = {
      run: (opts): AsyncGenerator<SdkEnvelope> => {
        async function* gen(): AsyncGenerator<SdkEnvelope> {
          prompts.push(opts.prompt);
          if (prompts.length === 1) {
            await new Promise<void>((resolve) =>
              opts.abortController.signal.addEventListener('abort', () => resolve()),
            );
            return;
          }
          yield { type: 'assistant', content: 'ok', raw: {} };
          yield { type: 'result', sessionId: 's-2', content: 'ok', raw: {} };
        }
        return gen();
      },
    };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-cont-'))),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => {},
      logger: pino({ level: 'silent' }),
      now: (() => {
        let t = Date.UTC(2026, 10, 11);
        return () => t++;
      })(),
      generateChatId: () => 'chat-0',
      nextAccountAfterExhausted: () => undefined,
    });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-cont-f-')));
    const chatId = await daemon.spawnChat({ folder });
    const first = daemon.sendInput({ chatId, message: 'dog, fox or poodle?', localId: 'A' });
    await settle();
    await daemon.stopChat(chatId);
    await first;
    await daemon.sendInput({ chatId, message: 'Continue', localId: 'B' });
    await settle(1000);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('dog, fox or poodle?');
    expect(prompts[1]).toContain('Continue');
    daemon.shutdown();
  });
});
