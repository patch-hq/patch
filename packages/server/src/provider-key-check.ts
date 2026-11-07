// Live check of a provider key (spec/01 § Settings → provider keys).
//
// One free, read-only request per probe, to the provider the key belongs to.
// Each probe that succeeds proves the key can power the features it names, so
// a key that passes some probes and is refused on others is reported as
// `limited` with exactly what it can and cannot do. A refusal of the key
// itself is `rejected`; a network failure or provider outage is `unreachable`
// and says nothing about the key. No retries, no guessing: what the provider
// answered is what is reported.

import type { ProviderKeyCheck, ProviderKeyId } from '@patch/wire';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Probe {
  feature: string;
  url: string;
  headers: (key: string) => Record<string, string>;
}

const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

export const PROBES: Record<ProviderKeyId, Probe[]> = {
  gemini: [
    {
      feature: 'Gemini voice',
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      headers: (key) => ({ 'x-goog-api-key': key }),
    },
  ],
  openai: [{ feature: 'OpenAI voice', url: 'https://api.openai.com/v1/models', headers: bearer }],
  groq: [
    {
      feature: 'Groq transcription',
      url: 'https://api.groq.com/openai/v1/models',
      headers: bearer,
    },
  ],
  deepgram: [
    {
      feature: 'Live dictation',
      url: 'https://api.deepgram.com/v1/auth/token',
      headers: (key) => ({ Authorization: `Token ${key}` }),
    },
  ],
  elevenlabs: [
    {
      feature: 'Voice and speech',
      url: 'https://api.elevenlabs.io/v1/models',
      headers: (key) => ({ 'xi-api-key': key }),
    },
    {
      feature: 'Account details',
      url: 'https://api.elevenlabs.io/v1/user',
      headers: (key) => ({ 'xi-api-key': key }),
    },
  ],
};

type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'rejected'; message: string }
  | { kind: 'missing_permission'; message: string }
  | { kind: 'unreachable'; message: string };

async function runProbe(fetchFn: FetchLike, probe: Probe, key: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchFn(probe.url, {
      headers: probe.headers(key),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { kind: 'unreachable', message: (err as Error).message };
  }
  if (res.ok) return { kind: 'ok' };
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    // ElevenLabs answers 401 `missing_permissions` for a valid key scoped away
    // from this endpoint; every other refusal is the key itself.
    if (/missing_permissions/.test(body)) {
      return { kind: 'missing_permission', message: `HTTP ${res.status}` };
    }
    return { kind: 'rejected', message: `HTTP ${res.status}` };
  }
  return { kind: 'unreachable', message: `HTTP ${res.status}` };
}

/** Run every probe for `id` and summarise what the key can do. */
export async function checkProviderKey(
  id: ProviderKeyId,
  key: string,
  fetchFn: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<ProviderKeyCheck> {
  const probes = PROBES[id];
  const results = await Promise.all(probes.map((p) => runProbe(fetchFn, p, key)));
  const checkedAt = now().toISOString();
  const works = probes.filter((_, i) => results[i]!.kind === 'ok').map((p) => p.feature);
  const lacks = probes
    .filter((_, i) => results[i]!.kind === 'missing_permission')
    .map((p) => p.feature);
  const unreachable = results.find((r) => r.kind === 'unreachable');
  const rejected = results.find((r) => r.kind === 'rejected');

  if (works.length > 0 && lacks.length > 0) {
    return { status: 'limited', features: works, missing: lacks, checkedAt };
  }
  if (works.length > 0) return { status: 'ok', features: works, checkedAt };
  if (rejected) {
    return {
      status: 'rejected',
      features: [],
      message: `The provider refused this key (${(rejected as { message: string }).message})`,
      checkedAt,
    };
  }
  if (unreachable) {
    return {
      status: 'unreachable',
      features: [],
      message: `Could not reach the provider to check the key: ${(unreachable as { message: string }).message}`,
      checkedAt,
    };
  }
  // Every probe said the key is valid but lacks permission for it.
  return {
    status: 'rejected',
    features: [],
    message: 'This key is valid but has no permission for anything Patch uses it for',
    checkedAt,
  };
}
