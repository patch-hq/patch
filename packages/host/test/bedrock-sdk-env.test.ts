// spec/10 § Backend credentials — Claude on Amazon Bedrock: a run on a Bedrock
// account points Claude Code at Bedrock with the account's AWS profile, and
// nothing of the host's own credentials can reach it. Every run reports what it
// cost (spec/10 § Spending caps). No real AWS, no real Anthropic: the SDK is a
// spy and the backend under spend is the mock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SdkEnvelope } from '../src/sdkBackend.js';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let nextMessages: unknown[] = [{ type: 'result', subtype: 'success' }];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    const messages = nextMessages;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  },
}));

const bedrock = {
  accountId: 'b1',
  awsProfile: 'work',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu' as const,
};

const HOST_SECRETS = {
  CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
  ANTHROPIC_API_KEY: 'sk-ant-host',
  AWS_BEARER_TOKEN_BEDROCK: 'host-bearer',
  AWS_ACCESS_KEY_ID: 'AKIAHOST',
  AWS_SECRET_ACCESS_KEY: 'host-secret',
  AWS_SESSION_TOKEN: 'host-session',
  ANTHROPIC_BEDROCK_REGION_PREFIX: 'us',
  // The host's own cloud routing: none of it may decide where a run goes.
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.host.example',
  ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'https://mantle.host.example',
  AWS_PROFILE: 'host-profile',
  AWS_REGION: 'us-east-1',
};

describe('buildSdkEnv on a Bedrock account', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(HOST_SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sets Bedrock, the profile, region and prefix, and strips every host credential', async () => {
    const { buildSdkEnv } = await import('../src/sdkBackend.js');
    const { env } = buildSdkEnv({
      prompt: 'x',
      cwd: '/tmp',
      abortController: new AbortController(),
      oauthAccessToken: '',
      bedrock,
    });
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(env['AWS_PROFILE']).toBe('work');
    expect(env['AWS_REGION']).toBe('eu-west-2');
    expect(env['ANTHROPIC_BEDROCK_REGION_PREFIX']).toBe('eu');
    expect(env['CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK']).toBe('1');
    for (const name of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      expect(name in env, name).toBe(false);
    }
    // The host's own Bedrock endpoint, auth skip and other clouds never reach a Bedrock run.
    for (const name of [
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_MANTLE',
    ]) {
      expect(name in env, name).toBe(false);
    }
    // The strip is on the copy only.
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('AKIAHOST');
  });

  // A subscription, API-key or endpoint turn cannot silently run on the host's AWS.
  for (const [what, extra] of [
    ['a subscription token', { oauthAccessToken: 'tok' }],
    ['an API key', { oauthAccessToken: 'sk-ant-api03-key' }],
    [
      'a model endpoint',
      { oauthAccessToken: '', modelEndpoint: { baseUrl: 'http://127.0.0.1:4000' } },
    ],
  ] as const) {
    it(`a run on ${what} carries none of the host's AWS or Bedrock settings`, async () => {
      const { buildSdkEnv } = await import('../src/sdkBackend.js');
      const { env } = buildSdkEnv({
        prompt: 'x',
        cwd: '/tmp',
        abortController: new AbortController(),
        ...extra,
      });
      for (const name of [
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_MANTLE',
        'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
        'ANTHROPIC_BEDROCK_BASE_URL',
        'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
        'ANTHROPIC_BEDROCK_REGION_PREFIX',
        'AWS_PROFILE',
        'AWS_REGION',
        'AWS_BEARER_TOKEN_BEDROCK',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
      ]) {
        expect(name in env, name).toBe(false);
      }
    });
  }

  it('leaves the prefix to Claude Code for auto, even one the host set', async () => {
    const { buildSdkEnv } = await import('../src/sdkBackend.js');
    const { env } = buildSdkEnv({
      prompt: 'x',
      cwd: '/tmp',
      abortController: new AbortController(),
      oauthAccessToken: '',
      bedrock: { ...bedrock, regionPrefix: 'auto' },
    });
    expect('ANTHROPIC_BEDROCK_REGION_PREFIX' in env).toBe(false);
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
  });

  it('refuses a Bedrock run that also carries a token', async () => {
    const { buildSdkEnv } = await import('../src/sdkBackend.js');
    expect(() =>
      buildSdkEnv({
        prompt: 'x',
        cwd: '/tmp',
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
        bedrock,
      }),
    ).toThrow(/Bedrock/);
  });

  it('a token run is untouched by Bedrock', async () => {
    const { buildSdkEnv } = await import('../src/sdkBackend.js');
    const { env } = buildSdkEnv({
      prompt: 'x',
      cwd: '/tmp',
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok');
    expect('CLAUDE_CODE_USE_BEDROCK' in env).toBe(false);
  });

  it('the real backend hands the SDK the Bedrock env and reports a failed result’s cost', async () => {
    queryCalls.length = 0;
    nextMessages = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['boom'],
        total_cost_usd: 0.25,
      },
    ];
    const { createRealSdkBackend } = await import('../src/sdkBackend.js');
    const costs: number[] = [];
    const stream = createRealSdkBackend().run({
      prompt: 'hello',
      cwd: '/tmp',
      abortController: new AbortController(),
      oauthAccessToken: '',
      bedrock,
      onResultCost: (c) => costs.push(c),
    });
    await expect(
      (async () => {
        for await (const _ of stream) void _;
      })(),
    ).rejects.toThrow();
    const env = queryCalls[0]!.options.env as Record<string, string | undefined>;
    expect(env['AWS_PROFILE']).toBe('work');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(costs).toEqual([0.25]);
    nextMessages = [{ type: 'result', subtype: 'success' }];
  });
});

describe('withBedrockSpend', () => {
  const result = (cost: number): SdkEnvelope => ({
    type: 'result',
    sessionId: 's1',
    raw: { type: 'result', subtype: 'success', total_cost_usd: cost },
  });

  it('reports a Bedrock run’s cost against its account', async () => {
    const { createMockSdkBackend } = await import('../src/sdkBackend.js');
    const { withBedrockSpend } = await import('../src/bedrockAccounts.js');
    const mock = createMockSdkBackend({ turnDelayMs: 0 });
    const spent: Array<[string, number]> = [];
    const backend = withBedrockSpend(mock, (id, c) => spent.push([id, c]));
    mock.enqueue([{ type: 'assistant', content: 'hi' }, result(0.0123)]);
    for await (const _ of backend.run({
      prompt: 'p',
      cwd: '/tmp',
      abortController: new AbortController(),
      oauthAccessToken: '',
      bedrock,
    }))
      void _;
    expect(spent).toEqual([['b1', 0.0123]]);
  });

  it('reports nothing for a run on a token', async () => {
    const { createMockSdkBackend } = await import('../src/sdkBackend.js');
    const { withBedrockSpend } = await import('../src/bedrockAccounts.js');
    const mock = createMockSdkBackend({ turnDelayMs: 0 });
    const spent: unknown[] = [];
    const backend = withBedrockSpend(mock, (id, c) => spent.push([id, c]));
    mock.enqueue([result(0.5)]);
    for await (const _ of backend.run({
      prompt: 'p',
      cwd: '/tmp',
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    }))
      void _;
    expect(spent).toEqual([]);
  });
});
