// What each voice provider offers, read from its own API with this host's key
// (spec/07 § The voice agent, § Direct calls): the voice agent's models and
// voices, and the text to speech and speech to text models a direct call's
// cloud engines offer. Never a list built in — except where the provider's API
// has no list (Gemini Live's and OpenAI's voices, ElevenLabs' Scribe models),
// which are the ones its documentation names.
//
// The host reports the reads on `host.host.voiceCatalog`; Settings → Refresh
// sends `host.voice_catalog_refresh`. A failed read is reported with its
// reason, never as an empty list.

import {
  CatalogProvider,
  GEMINI_VOICES,
  OPENAI_TTS_VOICES,
  OPENAI_VOICES,
  VOICE_AGENT_ENGINES,
  type CatalogItem,
  type VoiceAgentSetting,
  type VoiceCatalog,
  type VoiceCatalogEntry,
} from '@patch/wire/audio';

export type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

export type CatalogEndpoints = Record<CatalogProvider, string>;

export const CATALOG_ENDPOINTS: CatalogEndpoints = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com',
  elevenlabs: 'https://api.elevenlabs.io',
  groq: 'https://api.groq.com',
};

async function getJson(
  fetchImpl: CatalogFetch,
  url: string,
  headers: Record<string, string>,
  what: string,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${what}: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }
  return res.json();
}

const byLabel = (a: CatalogItem, b: CatalogItem): number => a.label.localeCompare(b.label);

/** Gemini models that speak the Live API (`bidiGenerateContent`), every page. */
async function geminiModels(
  fetchImpl: CatalogFetch,
  key: string,
  base: string,
): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${base}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const body = (await getJson(
      fetchImpl,
      url,
      { 'x-goog-api-key': key },
      'Gemini model list failed',
    )) as {
      models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    };
    if (!Array.isArray(body.models)) throw new Error('Gemini model list failed: no models');
    for (const m of body.models) {
      if (!m.name || !m.supportedGenerationMethods?.includes('bidiGenerateContent')) continue;
      out.push({ id: m.name, label: m.displayName || m.name.replace(/^models\//, '') });
    }
    pageToken = body.nextPageToken || undefined;
  } while (pageToken);
  return out.sort(byLabel);
}

/** OpenAI's Realtime models (the voice agent) and its text to speech models (direct calls). */
async function openaiModels(
  fetchImpl: CatalogFetch,
  key: string,
  base: string,
): Promise<{ models: CatalogItem[]; speechModels: CatalogItem[] }> {
  const body = (await getJson(
    fetchImpl,
    `${base}/v1/models`,
    { authorization: `Bearer ${key}` },
    'OpenAI model list failed',
  )) as { data?: { id?: string }[] };
  if (!Array.isArray(body.data)) throw new Error('OpenAI model list failed: no data');
  const ids = body.data.flatMap((m) => (m.id ? [m.id] : []));
  const items = (keep: (id: string) => boolean): CatalogItem[] =>
    ids
      .filter(keep)
      .map((id) => ({ id, label: id }))
      .sort(byLabel);
  return {
    models: items((id) => /realtime/.test(id) && !/transcri/.test(id)),
    speechModels: items((id) => /tts/.test(id) && !/realtime/.test(id)),
  };
}

/** Groq's speech to text models: the Whisper models its API lists. */
async function groqTranscriptionModels(
  fetchImpl: CatalogFetch,
  key: string,
  base: string,
): Promise<CatalogItem[]> {
  const body = (await getJson(
    fetchImpl,
    `${base}/openai/v1/models`,
    { authorization: `Bearer ${key}` },
    'Groq model list failed',
  )) as { data?: { id?: string; active?: boolean }[] };
  if (!Array.isArray(body.data)) throw new Error('Groq model list failed: no data');
  return body.data
    .flatMap((m) => (m.id && /whisper/.test(m.id) && m.active !== false ? [m.id] : []))
    .map((id) => ({ id, label: id }))
    .sort(byLabel);
}

/** ElevenLabs Agents' LLMs, its voices (every page) and its speech models. */
async function elevenLabsCatalog(
  fetchImpl: CatalogFetch,
  key: string,
  base: string,
): Promise<Pick<VoiceCatalogEntry, 'models' | 'voices' | 'speechModels' | 'transcriptionModels'>> {
  const headers = { 'xi-api-key': key };
  const llms = (await getJson(
    fetchImpl,
    `${base}/v1/convai/llm/list`,
    headers,
    'ElevenLabs LLM list failed',
  )) as { llms?: { llm?: string; deprecation_info?: unknown }[] };
  if (!Array.isArray(llms.llms)) throw new Error('ElevenLabs LLM list failed: no llms');
  const models = llms.llms
    .flatMap((l) => (l.llm && !l.deprecation_info ? [{ id: l.llm, label: l.llm }] : []))
    .sort(byLabel);

  const voices: CatalogItem[] = [];
  let pageToken: string | undefined;
  do {
    const body = (await getJson(
      fetchImpl,
      `${base}/v2/voices?page_size=100${pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : ''}`,
      headers,
      'ElevenLabs voice list failed',
    )) as {
      voices?: { voice_id?: string; name?: string; category?: string }[];
      has_more?: boolean;
      next_page_token?: string | null;
    };
    if (!Array.isArray(body.voices)) throw new Error('ElevenLabs voice list failed: no voices');
    for (const v of body.voices) {
      if (!v.voice_id) continue;
      const name = v.name || v.voice_id;
      voices.push({
        id: v.voice_id,
        label:
          v.category && v.category !== 'premade'
            ? `${name} (${v.category === 'generated' ? 'designed' : v.category})`
            : name,
      });
    }
    pageToken = body.has_more && body.next_page_token ? body.next_page_token : undefined;
  } while (pageToken);

  const tts = (await getJson(
    fetchImpl,
    `${base}/v1/models`,
    headers,
    'ElevenLabs speech model list failed',
  )) as { model_id?: string; name?: string; can_do_text_to_speech?: boolean }[];
  if (!Array.isArray(tts)) throw new Error('ElevenLabs speech model list failed: not a list');
  const speechModels = tts.flatMap((m) =>
    m.model_id && m.can_do_text_to_speech ? [{ id: m.model_id, label: m.name || m.model_id }] : [],
  );
  // ElevenLabs' API lists no speech to text models; Scribe's is the one its
  // speech to text reference names.
  return {
    models,
    voices: voices.sort(byLabel),
    speechModels,
    transcriptionModels: documented(['scribe_v2']),
  };
}

const documented = (names: readonly string[]): CatalogItem[] =>
  names.map((n) => ({ id: n, label: n }));

/** One read of a provider. Throws with the provider's own reason. */
export async function readVoiceCatalog(
  provider: CatalogProvider,
  key: string,
  opts: { fetchImpl?: CatalogFetch; endpoints?: Partial<CatalogEndpoints> } = {},
): Promise<Omit<VoiceCatalogEntry, 'at' | 'error'>> {
  const fetchImpl = opts.fetchImpl ?? (fetch as CatalogFetch);
  const base = { ...CATALOG_ENDPOINTS, ...opts.endpoints }[provider];
  if (provider === 'gemini') {
    return { models: await geminiModels(fetchImpl, key, base), voices: documented(GEMINI_VOICES) };
  }
  if (provider === 'openai') {
    return {
      ...(await openaiModels(fetchImpl, key, base)),
      voices: documented(OPENAI_VOICES),
      speechVoices: documented(OPENAI_TTS_VOICES),
    };
  }
  if (provider === 'groq') {
    return { transcriptionModels: await groqTranscriptionModels(fetchImpl, key, base) };
  }
  return elevenLabsCatalog(fetchImpl, key, base);
}

/**
 * This host's latest read of each provider it has a key for. `refresh` reads
 * one provider again; a provider with no key here is dropped, so Settings
 * never shows a read this host can no longer make.
 */
export class VoiceCatalogStore {
  private entries: VoiceCatalog = {};

  constructor(
    private readonly opts: {
      key: (provider: CatalogProvider) => string | undefined;
      onChange: () => void;
      onError?: (provider: CatalogProvider, message: string) => void;
      fetchImpl?: CatalogFetch;
      endpoints?: Partial<CatalogEndpoints>;
      now?: () => number;
    },
  ) {}

  snapshot(): VoiceCatalog {
    return structuredClone(this.entries);
  }

  entry(provider: CatalogProvider): VoiceCatalogEntry | undefined {
    return this.entries[provider];
  }

  async refresh(provider: CatalogProvider): Promise<void> {
    const key = this.opts.key(provider);
    const now = this.opts.now ?? Date.now;
    if (key === undefined) {
      if (this.entries[provider] !== undefined) {
        delete this.entries[provider];
        this.opts.onChange();
      }
      return;
    }
    try {
      const read = await readVoiceCatalog(provider, key, {
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.endpoints ? { endpoints: this.opts.endpoints } : {}),
      });
      this.entries[provider] = { ...read, at: now() };
    } catch (err) {
      const message = (err as Error).message;
      this.entries[provider] = { error: message, at: now() };
      this.opts.onError?.(provider, message);
    }
    this.opts.onChange();
  }

  async refreshAll(): Promise<void> {
    await Promise.all(CatalogProvider.options.map((p) => this.refresh(p)));
  }
}

/**
 * Why the voice agent setup cannot open a session on this host, or null. A
 * stored model, voice or listed sound choice (a speech model) the provider no
 * longer offers is refused, naming it, never swapped (spec/07 § The voice
 * agent). Judged only against a read this host has: with none (not read yet,
 * or the read failed) the provider decides.
 */
export function voiceAgentChoiceRefusal(
  agent: VoiceAgentSetting,
  catalog: VoiceCatalogEntry | undefined,
): string | null {
  const engine = VOICE_AGENT_ENGINES[agent.provider];
  const setup = agent.setups[agent.provider];
  if (setup.model === undefined) {
    return `No ${engine.label} model is chosen for the voice agent. Choose one in Settings → Voice calls.`;
  }
  if (catalog === undefined || catalog.error !== undefined) return null;
  const chosen: Array<{ what: string; value: unknown; list: CatalogItem[] | undefined }> = [
    { what: 'model', value: setup.model, list: catalog.models },
    { what: 'voice', value: setup.voice, list: catalog.voices },
    ...engine.controls.flatMap((c) =>
      c.kind === 'list'
        ? [{ what: c.label.toLowerCase(), value: setup.sound[c.key], list: catalog[c.list] }]
        : [],
    ),
  ];
  for (const { what, value, list } of chosen) {
    if (typeof value !== 'string' || list === undefined) continue;
    if (!list.some((item) => item.id === value)) {
      return `The voice agent's ${what} ${value} is no longer offered by ${engine.label}. Choose another in Settings → Voice calls.`;
    }
  }
  return null;
}
