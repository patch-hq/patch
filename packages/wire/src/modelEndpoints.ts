// Model endpoints (spec/02 § Provider adapters, decision 18 of the
// server-owned plan).
//
// A local model server or a router (Ollama, LM Studio, llama.cpp, vLLM,
// OpenRouter, LiteLLM) is not a provider of its own. It is a model endpoint
// inside a harness Patch already drives: an OpenAI-compatible endpoint runs
// through Codex as one of Codex's custom model providers, an
// Anthropic-compatible one through Claude Code with its base URL pointed at
// it. A chat on an endpoint model is an ordinary Codex or Claude chat, with
// that adapter's durability and capabilities.
//
// An endpoint is configured once for the account (shared setting
// `modelEndpoints`); its key, when it has one, is a shared secret
// (`endpointKeys`), never a setting.

import { z } from 'zod';

/**
 * The API an endpoint speaks, which picks the harness it runs in. `openai` is
 * the OpenAI Responses API (`POST <baseUrl>/responses`, which Codex calls);
 * `anthropic` is the Anthropic Messages API Claude Code calls.
 */
export const ModelEndpointApi = z.enum(['openai', 'anthropic']);
export type ModelEndpointApi = z.infer<typeof ModelEndpointApi>;

export const MODEL_ENDPOINT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const ModelEndpoint = z
  .object({
    /** Stable id; part of every model id on the endpoint, so never changed once chats use it. */
    id: z.string().regex(MODEL_ENDPOINT_ID, 'an id is lowercase letters, digits and dashes'),
    /** How the endpoint is named in the model picker (`Ollama`). */
    label: z.string().trim().min(1).max(60),
    api: ModelEndpointApi,
    /**
     * Up to and including the version segment (`http://127.0.0.1:11434/v1`).
     * Reached FROM each host, so `127.0.0.1` means that host.
     */
    baseUrl: z.string().url(),
    /**
     * The models offered. Absent: whatever the endpoint itself lists at
     * `<baseUrl>/models`. A router with thousands of models is named here.
     */
    models: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();
export type ModelEndpoint = z.infer<typeof ModelEndpoint>;

export const ModelEndpoints = z
  .array(ModelEndpoint)
  .refine(
    (list) => new Set(list.map((e) => e.id)).size === list.length,
    'two endpoints share an id',
  );

/** The harness an endpoint's models run in. */
export function endpointHarness(api: ModelEndpointApi): 'codex' | 'claude' {
  return api === 'openai' ? 'codex' : 'claude';
}

// A Codex endpoint model sits under Codex's own `openai/` prefix, so it routes
// to the Codex adapter like every other Codex model. An Anthropic endpoint
// model has a prefix no provider claims, so it routes to Claude, the default.
const PREFIX: Record<ModelEndpointApi, string> = {
  openai: 'openai/endpoint/',
  anthropic: 'claude/endpoint/',
};

/** The model id a chat on `model` at `endpoint` carries. */
export function endpointModelId(
  endpoint: Pick<ModelEndpoint, 'id' | 'api'>,
  model: string,
): string {
  return `${PREFIX[endpoint.api]}${endpoint.id}/${model}`;
}

export interface EndpointModelRef {
  api: ModelEndpointApi;
  endpointId: string;
  /** The endpoint's own name for the model (`qwen3:8b`, `anthropic/claude-sonnet-4`). */
  model: string;
}

/** The endpoint and model a model id names, or undefined for a model that is not on an endpoint. */
export function parseEndpointModel(id: string | null | undefined): EndpointModelRef | undefined {
  if (!id) return undefined;
  for (const api of ModelEndpointApi.options) {
    const prefix = PREFIX[api];
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return undefined;
    const endpointId = rest.slice(0, slash);
    if (!MODEL_ENDPOINT_ID.test(endpointId)) return undefined;
    return { api, endpointId, model: rest.slice(slash + 1) };
  }
  return undefined;
}

export const isEndpointModel = (id: string | null | undefined): boolean =>
  parseEndpointModel(id) !== undefined;

/** The picker label for a model on an endpoint: the model, then where it runs. */
export function endpointModelLabel(endpoint: Pick<ModelEndpoint, 'label' | 'api'>, model: string) {
  return `${model} · ${endpoint.label} (${endpoint.api === 'openai' ? 'ChatGPT' : 'Claude Code'})`;
}

// ---- the retired local-model loop ----
//
// Before endpoints, Patch ran local models on an agent loop of its own, as a
// `local` provider with `local/<model>` ids. That loop is gone. A chat made on
// it keeps its history (the server's record) but cannot continue: the user
// starts a new chat on the same model through an endpoint.

const RETIRED_LOCAL_PREFIX = 'local/';

/**
 * The id `settingsMigration` gives the endpoint it makes from the retired
 * `localModelBaseUrl` setting, so a retired chat's model has a successor.
 */
export const MIGRATED_LOCAL_ENDPOINT_ID = 'local';

export const isRetiredLocalModel = (id: string | null | undefined): boolean =>
  id?.startsWith(RETIRED_LOCAL_PREFIX) === true;

/** What a chat on a retired local model says, and the model a new chat takes its place on. */
export function retiredModelNotice(
  id: string | null | undefined,
): { message: string; replacementModel: string } | undefined {
  if (!id || !isRetiredLocalModel(id)) return undefined;
  const model = id.slice(RETIRED_LOCAL_PREFIX.length);
  return {
    message:
      `This chat ran on Patch's own local-model loop, which has been removed. ` +
      `Its history stays here, but it cannot continue. Start a new chat to keep working with ${model}: ` +
      `local models now run through ChatGPT.`,
    replacementModel: endpointModelId({ id: MIGRATED_LOCAL_ENDPOINT_ID, api: 'openai' }, model),
  };
}

/** A fresh id from the endpoint's name, unique among the ones already set. */
export function endpointIdFor(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'endpoint';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return MODEL_ENDPOINT_ID.test(id) ? id : 'endpoint';
}
