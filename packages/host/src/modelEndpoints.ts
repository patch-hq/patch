// Model endpoints on the host (spec/02 § Provider adapters).
//
// A local model server or router is a model endpoint inside a harness Patch
// already drives, never a provider of its own (`@patch/wire`
// `modelEndpoints.ts`). This holds the account's endpoints and their keys, as
// the server's settings snapshot last gave them, and turns a chat's endpoint
// model into what its harness needs:
//
// - Codex (an OpenAI-compatible endpoint): a custom model provider handed to
//   `thread/start` and `thread/resume` (`model_providers.<id>` with
//   `wire_api = "responses"`), its key in an environment variable Codex reads
//   (`env_key`). Codex needs no ChatGPT sign-in for it.
// - Claude Code (an Anthropic-compatible endpoint): `ANTHROPIC_BASE_URL` and
//   `ANTHROPIC_AUTH_TOKEN` in the turn's environment.
//
// There is no fallback: a model naming an endpoint that is not configured, or
// an endpoint that cannot be reached, is an error that says so.

import {
  endpointModelId,
  endpointModelLabel,
  parseEndpointModel,
  type ModelEndpoint,
  type ModelEndpointApi,
} from '@patch/wire';

export class ModelEndpointError extends Error {
  override readonly name = 'ModelEndpointError';
}

/** The environment variable a Codex endpoint turn reads the endpoint's key from. */
export const CODEX_ENDPOINT_KEY_ENV = 'PATCH_MODEL_ENDPOINT_KEY';

export interface ResolvedEndpointModel {
  endpoint: ModelEndpoint;
  /** The endpoint's own name for the model. */
  model: string;
  key: string | undefined;
}

/** What a Codex thread on an endpoint model is started (and resumed) with. */
export interface CodexEndpointLaunch {
  model: string;
  modelProvider: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
}

export class ModelEndpointRegistry {
  private endpoints: ModelEndpoint[] = [];
  private keys: Record<string, string> = {};

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Replace everything from a settings snapshot. */
  apply(endpoints: readonly ModelEndpoint[] | undefined, keys?: Record<string, string>): void {
    this.endpoints = [...(endpoints ?? [])].map((e) => ({
      ...e,
      baseUrl: e.baseUrl.replace(/\/+$/, ''),
    }));
    this.keys = { ...(keys ?? {}) };
  }

  list(api?: ModelEndpointApi): ModelEndpoint[] {
    return this.endpoints.filter((e) => api === undefined || e.api === api);
  }

  /** The endpoint and model an endpoint model id names; throws for one that is not configured. */
  resolve(modelId: string | undefined): ResolvedEndpointModel {
    const ref = parseEndpointModel(modelId);
    if (!ref) throw new ModelEndpointError(`${modelId ?? 'No model'} is not on a model endpoint`);
    const endpoint = this.endpoints.find((e) => e.id === ref.endpointId && e.api === ref.api);
    if (!endpoint)
      throw new ModelEndpointError(
        `This chat's model endpoint "${ref.endpointId}" is not set up. Add it again under Settings → Providers → Model endpoints, or start a new chat on another model.`,
      );
    return { endpoint, model: ref.model, key: this.keys[endpoint.id] };
  }

  /** The Codex launch for an OpenAI-compatible endpoint model. */
  codexLaunch(modelId: string | undefined): CodexEndpointLaunch {
    const { endpoint, model, key } = this.resolve(modelId);
    if (endpoint.api !== 'openai')
      throw new ModelEndpointError(`${endpoint.label} is not an OpenAI-compatible endpoint`);
    const provider = `patch-${endpoint.id}`;
    return {
      model,
      modelProvider: provider,
      config: {
        model_providers: {
          [provider]: {
            name: endpoint.label,
            base_url: endpoint.baseUrl,
            wire_api: 'responses',
            ...(key !== undefined ? { env_key: CODEX_ENDPOINT_KEY_ENV } : {}),
          },
        },
      },
      env: key !== undefined ? { [CODEX_ENDPOINT_KEY_ENV]: key } : {},
    };
  }

  /** The Claude Code environment for an Anthropic-compatible endpoint model. */
  claudeLaunch(modelId: string | undefined): { model: string; baseUrl: string; key?: string } {
    const { endpoint, model, key } = this.resolve(modelId);
    if (endpoint.api !== 'anthropic')
      throw new ModelEndpointError(`${endpoint.label} is not an Anthropic-compatible endpoint`);
    return { model, baseUrl: endpoint.baseUrl, ...(key !== undefined ? { key } : {}) };
  }

  /**
   * One endpoint's models as catalogue entries: the ones named in its
   * settings, or else what it lists at `<baseUrl>/models`.
   */
  async models(endpoint: ModelEndpoint): Promise<Array<{ id: string; label: string }>> {
    const names = endpoint.models ?? (await this.listed(endpoint));
    return names.map((m) => ({
      id: endpointModelId(endpoint, m),
      label: endpointModelLabel(endpoint, m),
    }));
  }

  private async listed(endpoint: ModelEndpoint): Promise<string[]> {
    const url = `${endpoint.baseUrl}/models`;
    const key = this.keys[endpoint.id];
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(5000),
        headers: {
          ...(key !== undefined
            ? endpoint.api === 'anthropic'
              ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
              : { authorization: `Bearer ${key}` }
            : {}),
        },
      });
    } catch (e) {
      throw new ModelEndpointError(
        `Cannot reach ${endpoint.label} at ${url}: ${(e as Error).message}`,
      );
    }
    if (!res.ok) throw new ModelEndpointError(`${endpoint.label}: ${url} answered ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data))
      throw new ModelEndpointError(`${endpoint.label}: ${url} did not return a model list`);
    return body.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
  }
}
