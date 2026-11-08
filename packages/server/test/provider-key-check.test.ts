import { describe, expect, it } from 'vitest';
import { checkProviderKey, type FetchLike } from '../src/provider-key-check.js';

const KEY = 'k'.repeat(24);
const reply =
  (routes: Record<string, { status: number; body?: string }>): FetchLike =>
  async (url) => {
    const hit = Object.entries(routes).find(([u]) => url.includes(u));
    if (!hit) throw new Error(`unexpected ${url}`);
    return new Response(hit[1].body ?? '{}', { status: hit[1].status });
  };

describe('checkProviderKey', () => {
  it('reports a working key and what it powers', async () => {
    const c = await checkProviderKey('groq', KEY, reply({ 'api.groq.com': { status: 200 } }));
    expect(c).toMatchObject({ status: 'ok', features: ['Groq transcription'] });
  });

  it('reports a refused key as rejected', async () => {
    const c = await checkProviderKey('openai', KEY, reply({ 'api.openai.com': { status: 401 } }));
    expect(c.status).toBe('rejected');
    expect(c.message).toContain('401');
  });

  it('reports an ElevenLabs key scoped away from the account as limited', async () => {
    const c = await checkProviderKey(
      'elevenlabs',
      KEY,
      reply({
        '/v1/models': { status: 200 },
        '/v1/user': { status: 401, body: '{"detail":{"status":"missing_permissions"}}' },
      }),
    );
    expect(c).toMatchObject({
      status: 'limited',
      features: ['Voice and speech'],
      missing: ['Account details'],
    });
  });

  it('reports a network failure as unreachable, not rejected', async () => {
    const c = await checkProviderKey('gemini', KEY, async () => {
      throw new Error('ENOTFOUND');
    });
    expect(c.status).toBe('unreachable');
  });

  it('treats a provider 5xx as unreachable', async () => {
    const c = await checkProviderKey(
      'deepgram',
      KEY,
      reply({ 'api.deepgram.com': { status: 503 } }),
    );
    expect(c.status).toBe('unreachable');
  });
});
