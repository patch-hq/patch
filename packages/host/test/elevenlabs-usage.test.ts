// spec/07 § Call cost — real ElevenLabs charge lookup.

import { describe, it, expect } from 'vitest';
import { fetchConversationCharge, fetchPlanCredits } from '../src/audio/elevenlabs-usage.js';

const reply =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('fetchConversationCharge', () => {
  it('reads credits and dollars for the conversation from the list', async () => {
    const r = await fetchConversationCharge(
      {
        apiKey: 'k',
        fetchImpl: reply({
          conversations: [
            { conversation_id: 'other', cost: 5, cost_fiat: 0.01 },
            { conversation_id: 'conv_1', cost: 1616, cost_fiat: 0.29 },
          ],
        }),
      },
      'conv_1',
    );
    expect(r).toEqual({ credits: 1616, usd: 0.29 });
  });

  it('waits for ElevenLabs to book the call, then gives up loudly', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ conversations: [] }));
    };
    await expect(
      fetchConversationCharge({ apiKey: 'k', fetchImpl, attempts: 3, delayMs: 1 }, 'conv_1'),
    ).rejects.toThrow(/no charge yet/);
    expect(calls).toBe(3);
  });

  it('throws on an HTTP error', async () => {
    await expect(
      fetchConversationCharge({ apiKey: 'k', fetchImpl: reply({}, 401) }, 'c'),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('fetchPlanCredits', () => {
  it('works out credits left and whether usage is billed', async () => {
    const r = await fetchPlanCredits({
      apiKey: 'k',
      fetchImpl: reply({
        character_count: 18000,
        character_limit: 100000,
        allowed_to_extend_character_limit: false,
      }),
    });
    expect(r).toEqual({ used: 18000, limit: 100000, left: 82000, usageBilled: false });
  });

  it('throws when the permission is missing', async () => {
    await expect(fetchPlanCredits({ apiKey: 'k', fetchImpl: reply({}, 401) })).rejects.toThrow(
      /HTTP 401/,
    );
  });
});
