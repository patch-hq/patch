# Providers

A provider is an agent harness a chat can run on (today: `claude`, `codex`, `local`, `acp`).

## Adding an ACP agent

An agent that speaks the Agent Client Protocol needs no code: it is an entry in the shared `acpAgents` setting (`packages/wire/src/acpAgents.ts`), `{ id, label, command, args, keys?, modes? }`, e.g. `{ "id": "goose", "label": "Goose", "command": "goose", "args": ["acp"] }`. `keys` maps an environment variable to a shared provider key; `modes` maps Patch's permission modes to the agent's own session modes. Gemini CLI is built in. Its models appear as `acp/<id>/<model>` on every host that has the command (spec/02 § ACP agents).

## Adding one

1. `packages/wire/src/providers.ts` — add an entry to `PROVIDERS`: `id` (persisted, never rename), `label`, `modelPrefix` (`deepseek/`), `sessionIdPrefix` (`deepseek-`), `permissionModes`, `backendId`, `accountsKey` (`null` for a provider with no accounts, like `local`), `aliases`, `supportsEffort`, `loginRequiredCode`, `capabilities` (resume, editAtMessage, rewind, branchAtTurn, disableNativeTools, interrupt, steer: what the provider does natively; a feature whose capability is not declared is absent for its chats, read with `modelHasCapability(model, cap)`). `HarnessId`, model routing, session-id routing and the permission-mode table all derive from it.
2. `packages/host/src/harnesses.ts` — add its `HARNESS_TRAITS` entry. The `Record<HarnessId, …>` type fails the build until you do. Traits cover: credential `backendId`, permission-mode resolution, status generation, rate-limit sweep ownership, retry safety.
3. Write the backend (like `codexBackend.ts`): runs a turn, emits Patch events, mints `<sessionIdPrefix>…` session ids, supports reseed from Patch's own history log (provider switching).
4. If it needs a key, add it to `packages/wire/src/provider-keys.ts`.
5. Tests: the registry tests in `wire/test/providers.test.ts` and `host/test/harnesses.test.ts` cover every entry automatically.

Surfaces, the server, the CLI and the host's account RPC read the same entry (`backendIdForModel`, `accountsKeyForBackend`, `modelSupportsEffort`, `providerByName`, `BACKEND_IDS`); none of them hard-code `claude` or `codex`. What stays provider-specific is the sign-in flow UI and the Claude session mechanics in chatRunner.

## Proposed suite

Cost note: any paid API needs Tom's sign-off and a spend cap before first use.

| Provider                               | Prefix        | Route                                           | Notes                                                                         |
| -------------------------------------- | ------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Gemini                                 | `acp/gemini/` | Gemini CLI over ACP (built in)                  | Key already stored (`gemini`); free tier is limited; paid use needs approval. |
| DeepSeek                               | `deepseek/`   | OpenAI-compatible API through a generic harness | Very cheap per token; key needed.                                             |
| Local (Ollama / llama.cpp / LM Studio) | `local/`      | OpenAI-compatible endpoint on the host          | Free, private; capability depends on model; endpoint URL is host config.      |
| OpenRouter                             | `openrouter/` | OpenAI-compatible API                           | One key reaches many models; good catch-all.                                  |
| Groq                                   | `groq/`       | OpenAI-compatible API                           | Key already stored; fast open models.                                         |
| Mistral                                | `mistral/`    | OpenAI-compatible API or Vibe CLI               | Optional.                                                                     |
| xAI Grok                               | `xai/`        | OpenAI-compatible API                           | Optional.                                                                     |

Status: the generic engine (`openaiCompatBackend.ts`) is wired to chats for `local/` only (`localModels.ts`; endpoint is the shared setting `localModelBaseUrl`). The paid providers each still need a registry entry, a key and a config block.

Recommended order: (1) a generic **OpenAI-compatible harness** (base URL + key + model list, tool-calling loop) — one backend that makes DeepSeek, Local, OpenRouter, Groq, Mistral and xAI each a registry entry plus a config block; (2) Gemini via its CLI as a separate harness, mirroring Codex; (3) local first for zero-cost testing.

## Status

Built: the generic OpenAI-compatible engine (`packages/host/src/openaiCompatBackend.ts`) — streaming, tool loop (Bash/Read/Write), permission modes, saved sessions. Not yet reachable from a chat: it has no registry entries, no host routing, no key/endpoint config, no history reader, no MCP tools, and Gemini's CLI harness is not started.
