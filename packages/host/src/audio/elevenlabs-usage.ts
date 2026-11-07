// spec/07 § Call cost — what an ElevenLabs agent call really cost, as
// ElevenLabs reports it: credits (and a dollar value) per conversation, and
// the plan's credits used / left this month. Nothing here is a rate we wrote
// down; a lookup that fails throws and the caller says so (NO FALLBACK).

import { ELEVENLABS_API_BASE, type ElevenLabsFetch } from './elevenlabs-agent.js';

export interface ConversationCharge {
  credits: number;
  /** ElevenLabs' own dollar value for the conversation (`cost_fiat`). */
  usd: number;
}

export interface PlanCredits {
  used: number;
  limit: number;
  left: number;
  /** The plan may spend past its credits as paid usage. */
  usageBilled: boolean;
}

interface Deps {
  apiKey: string;
  fetchImpl?: ElevenLabsFetch;
  apiBase?: string;
}

async function get(deps: Deps, path: string): Promise<unknown> {
  const doFetch: ElevenLabsFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const res = await doFetch(`${deps.apiBase ?? ELEVENLABS_API_BASE}${path}`, {
    method: 'GET',
    headers: { 'xi-api-key': deps.apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`ElevenLabs GET ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * The charge for one conversation. It is read from the conversation list (the
 * detail endpoint 404s once the throwaway agent is deleted), and ElevenLabs
 * takes a few seconds to book a finished call, so it is polled.
 */
export async function fetchConversationCharge(
  deps: Deps & { attempts?: number; delayMs?: number },
  conversationId: string,
): Promise<ConversationCharge> {
  const attempts = deps.attempts ?? 6;
  const delayMs = deps.delayMs ?? 2_000;
  for (let i = 0; i < attempts; i++) {
    const body = (await get(deps, '/v1/convai/conversations?page_size=30')) as {
      conversations?: Array<{ conversation_id?: string; cost?: number; cost_fiat?: number }>;
    };
    const hit = body.conversations?.find((c) => c.conversation_id === conversationId);
    if (hit && typeof hit.cost === 'number') {
      return { credits: hit.cost, usd: typeof hit.cost_fiat === 'number' ? hit.cost_fiat : 0 };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`ElevenLabs has no charge yet for conversation ${conversationId}`);
}

/** The plan's credits this month. Needs the key's `user_read` permission. */
export async function fetchPlanCredits(deps: Deps): Promise<PlanCredits> {
  const s = (await get(deps, '/v1/user/subscription')) as {
    character_count?: number;
    character_limit?: number;
    allowed_to_extend_character_limit?: boolean;
  };
  if (typeof s.character_count !== 'number' || typeof s.character_limit !== 'number') {
    throw new Error('ElevenLabs subscription reply has no credit counts');
  }
  return {
    used: s.character_count,
    limit: s.character_limit,
    left: Math.max(0, s.character_limit - s.character_count),
    usageBilled: s.allowed_to_extend_character_limit === true,
  };
}
