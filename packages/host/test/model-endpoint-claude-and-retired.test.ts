// The other two halves of local models as harness endpoints (spec/02 §
// Provider adapters): an Anthropic-compatible endpoint runs Claude Code pointed
// at it, on no Claude account; and a chat made on Patch's retired local-model
// loop keeps its history but is refused plainly when asked to continue.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createClaudeSessionProbe } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import {
  ENDPOINT_NO_KEY,
  buildSdkEnv,
  createMockSdkBackend,
  type SdkRunOptions,
} from '../src/sdkBackend.js';

const base = {
  prompt: 'p',
  cwd: '/tmp',
  abortController: new AbortController(),
} as const;

describe('Claude Code on an Anthropic-compatible endpoint', () => {
  it('points Claude Code at the endpoint with its key, and carries no Claude credential', () => {
    const before = { ...process.env };
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'host-own-token';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'host-own-auth';
    try {
      const { env } = buildSdkEnv({
        ...base,
        oauthAccessToken: '',
        modelEndpoint: { baseUrl: 'http://127.0.0.1:4000', key: 'sk-router-key-123456' },
      } as SdkRunOptions);
      expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4000');
      expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-router-key-123456');
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();

      const keyless = buildSdkEnv({
        ...base,
        oauthAccessToken: '',
        modelEndpoint: { baseUrl: 'http://127.0.0.1:4000' },
      } as SdkRunOptions).env;
      // No key: nothing of the host's own reaches the endpoint, and a token is
      // still set so Claude Code never falls back to a stored Claude login.
      expect(keyless['ANTHROPIC_AUTH_TOKEN']).toBe(ENDPOINT_NO_KEY);
      expect(keyless['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
      expect(keyless['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      process.env = before;
    }
  });

  it('an ordinary Claude turn still runs on the account token', () => {
    const { env } = buildSdkEnv({ ...base, oauthAccessToken: 'sk-ant-oat01-x' } as SdkRunOptions);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-x');
  });
});

describe('a chat on the retired local-model loop', () => {
  it('is refused with model_retired, naming why, and never reaches a backend', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-retired-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-retired-folder-'));
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-retired-projects-'));
    const events: WireEvent[] = [];
    const mock = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    let ran = 0;
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (opts) => {
          ran++;
          return mock.run(opts);
        },
      },
      sessionProbe: createClaudeSessionProbe({ claudeProjectsRoot: projectsRoot }),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
    });
    const chatId = await daemon.spawnChat({ folder, model: 'local/qwen3:8b' });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'carry on', localId: 'l1' });
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'chat.error'); i++)
      await new Promise((r) => setTimeout(r, 10));
    const error = events.find((e) => e.type === 'chat.error') as
      | { error: { code: string; message: string } }
      | undefined;
    expect(error?.error.code).toBe('model_retired');
    expect(error?.error.message).toMatch(/cannot continue/);
    expect(ran).toBe(0);
  });
});
