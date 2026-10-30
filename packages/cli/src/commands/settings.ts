// `patch settings`, `patch accounts`, `patch keys` — the shared settings
// (spec/01 § Settings, spec/17 § Commands).
//
// These change what every host runs on, so they go to the SERVER wherever the
// CLI runs — never a machine's own socket. With no server reachable they fail,
// naming it, rather than changing one machine behind the others' backs.

import { Command } from 'commander';
import {
  accountsKeyForBackend,
  providerByName,
  providerDescriptor,
  PROVIDERS,
  type ProviderBackendId,
} from '@patch/wire';
import type { CommonOpts } from './_common.js';
import { emitJson, emitText, getTransport, run } from './_common.js';
import { resolveHost } from './hosts.js';

interface SharedState {
  version: number;
  settings: Record<string, unknown> & {
    accountStrategy: { claude: string; codex: string };
  };
  secrets: {
    claude: Array<{ id: string; label: string; connected: boolean; email?: string }>;
    codex: Array<{ id: string; label: string; kind: string; connected: boolean; email?: string }>;
    providerKeys: Array<{ id: string; set: boolean; last4?: string }>;
  };
  hosts: Array<{ hostId: string; appliedVersion?: number; error?: string }>;
  problem?: string;
}

const server = (opts: CommonOpts) => getTransport({ ...opts, remote: true });

/** `permission-mode` → `permissionModeDefault`, and the few other CLI names. */
const SETTING_KEYS: Record<string, string> = {
  'permission-mode': 'permissionModeDefault',
  'default-model': 'defaultModel',
  'question-expiry': 'questionExpiry',
  'question-expiry-seconds': 'questionExpirySeconds',
  'auto-resume': 'autoResumeRateLimit',
  'auto-update': 'autoUpdateHosts',
  'chat-name-interval': 'chatNameInterval',
  'title-generation': 'titleGenerationEnabled',
  'status-generation': 'statusGenerationEnabled',
  'sync-position': 'syncPosition',
  'kokoro-voice': 'kokoroVoice',
  'tts-backend': 'ttsBackend',
  'elevenlabs-voice': 'elevenLabsVoice',
  'dictation-pause': 'dictationPauseSeconds',
  'turn-detection': 'dictationTurnDetection',
  memory: 'harnessMemoryEnabled',
};

/** A value as typed: JSON where it parses (true, 60, "x"), else the text itself. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function backendOf(name: string): ProviderBackendId {
  try {
    return providerDescriptor(providerByName(name)).backendId as ProviderBackendId;
  } catch {
    throw new Error(`no backend "${name}" (${PROVIDERS.map((p) => p.id).join(' or ')})`);
  }
}

/** The shared accounts in order, as `patch accounts` shows and `--json` returns them. */
interface AccountsView {
  strategy: { claude: string; codex: string };
  claude: Array<{ id: string; label: string; connected: boolean; email?: string }>;
  codex: Array<{ id: string; label: string; connected: boolean; email?: string }>;
}

const viewOf = (state: SharedState): AccountsView => ({
  strategy: state.settings.accountStrategy,
  claude: state.secrets.claude,
  codex: state.secrets.codex,
});

/**
 * List / reorder / set strategy for the shared accounts. On a machine with a
 * running host this goes over the host's own socket — the host relays it to the
 * server on its existing link, so no separate login is needed. Anywhere else it
 * is REST with the paired credential. One path is chosen up front, never both.
 */
const accountsApi = (opts: CommonOpts) => {
  const t = getTransport(opts);
  const uds = t.kind === 'uds';
  return {
    list: async (): Promise<AccountsView> =>
      uds
        ? t.get<AccountsView>('/accounts')
        : viewOf(await t.get<SharedState>('/api/settings/shared')),
    order: async (id: ProviderBackendId, accountIds: string[]): Promise<AccountsView> =>
      uds
        ? t.put<AccountsView>(`/accounts/${id}/order`, { accountIds })
        : viewOf(await t.put<SharedState>(`/api/accounts/${id}/order`, { accountIds })),
    strategy: async (id: ProviderBackendId, strategy: string): Promise<AccountsView> =>
      uds
        ? t.put<AccountsView>(`/accounts/${id}/strategy`, { strategy })
        : viewOf(await t.put<SharedState>(`/api/accounts/${id}/strategy`, { strategy })),
  };
};

function printAccounts(view: AccountsView, backend: ProviderBackendId): void {
  const key = accountsKeyForBackend(backend);
  const list = view[key];
  const strategy = view.strategy[key];
  emitText(`${providerDescriptor(providerByName(backend)).label} — strategy: ${strategy}`);
  if (list.length === 0) emitText('  (no accounts)');
  list.forEach((a, i) =>
    emitText(
      `  ${i + 1}. ${a.label}${a.email ? ` <${a.email}>` : ''}${a.connected ? '' : '  [not connected]'}  ${a.id}`,
    ),
  );
}

export function registerSettingsCommands(program: Command): void {
  const settings = program
    .command('settings')
    .description('The shared settings every host runs on');

  settings
    .command('show', { isDefault: true })
    .description('Every shared setting, and which version each host runs')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).get<SharedState>('/api/settings/shared');
        if (opts.json) {
          emitJson(state);
          return;
        }
        if (state.problem) emitText(`problem: ${state.problem}`);
        emitText(`version ${state.version}`);
        for (const [k, v] of Object.entries(state.settings))
          emitText(`  ${k}: ${JSON.stringify(v)}`);
        for (const h of state.hosts) {
          emitText(
            `host ${h.hostId}: ${h.error ? `could not apply — ${h.error}` : h.appliedVersion === state.version ? 'up to date' : `on ${h.appliedVersion ?? 'none'}`}`,
          );
        }
      });
    });

  settings
    .command('set <key> <value>')
    .description(`Change one shared setting (e.g. ${Object.keys(SETTING_KEYS).join(', ')})`)
    .option('--json', 'JSON output')
    .action(async (key: string, value: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const field = SETTING_KEYS[key] ?? key;
        const res = await server(opts).patch<unknown>('/api/settings', {
          [field]: parseValue(value),
        });
        if (opts.json) emitJson(res);
        else emitText(`${field}: ${value}`);
      });
    });

  const accounts = program
    .command('accounts')
    .description('The Claude and ChatGPT accounts every host draws from');

  accounts
    .command('list [backend]', { isDefault: true })
    .description('The shared accounts, in order, with the strategy')
    .option('--json', 'JSON output')
    .action(async (backend: string | undefined, opts: CommonOpts) => {
      await run(opts, async () => {
        const view = await accountsApi(opts).list();
        if (opts.json) {
          emitJson(view);
          return;
        }
        if (backend !== undefined) printAccounts(view, backendOf(backend));
        else {
          for (const p of PROVIDERS) printAccounts(view, p.backendId);
        }
      });
    });

  accounts
    .command('add <backend>')
    .description('Add a Claude account from a token, or a ChatGPT API key')
    .option('--token <t>', 'a `claude setup-token` token (claude)')
    .option('--api-key <k>', 'an OpenAI API key (codex)')
    .option('--label <l>', 'a name for it')
    .option('--json', 'JSON output')
    .action(
      async (
        backend: string,
        opts: CommonOpts & { token?: string; apiKey?: string; label?: string },
      ) => {
        await run(opts, async () => {
          const id = backendOf(backend);
          const body = {
            ...(opts.token ? { token: opts.token } : {}),
            ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
            ...(opts.label ? { label: opts.label } : {}),
          };
          const state = await server(opts).post<SharedState>(`/api/accounts/${id}`, body);
          if (opts.json) emitJson(state);
          else printAccounts(viewOf(state), id);
        });
      },
    );

  accounts
    .command('connect <backend> <accountId>')
    .description("Replace an account's token")
    .requiredOption('--token <t>', 'the new token')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountId: string, opts: CommonOpts & { token: string }) => {
      await run(opts, async () => {
        emitJson(
          await server(opts).patch<unknown>(
            `/api/accounts/${backendOf(backend)}/${encodeURIComponent(accountId)}`,
            { token: opts.token },
          ),
        );
      });
    });

  accounts
    .command('disconnect <backend> <accountId>')
    .description('Take an account out of every host’s sequence (it stays listed)')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        emitJson(
          await server(opts).post<unknown>(
            `/api/accounts/${backendOf(backend)}/${encodeURIComponent(accountId)}/disconnect`,
          ),
        );
      });
    });

  accounts
    .command('remove <backend> <accountId>')
    .description('Remove an account from every host')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        emitJson(
          await server(opts).delete<unknown>(
            `/api/accounts/${backendOf(backend)}/${encodeURIComponent(accountId)}`,
          ),
        );
      });
    });

  accounts
    .command('order <backend> <accountIds...>')
    .description('Set the order: every account, each once, first to last')
    .option('--json', 'JSON output')
    .action(async (backend: string, accountIds: string[], opts: CommonOpts) => {
      await run(opts, async () => {
        const id = backendOf(backend);
        const view = await accountsApi(opts).order(id, accountIds);
        if (opts.json) emitJson(view);
        else printAccounts(view, id);
      });
    });

  accounts
    .command('strategy <backend> <strategy>')
    .description('How a turn picks its account: priority, round-robin, soonest-reset, least-used')
    .option('--json', 'JSON output')
    .action(async (backend: string, strategy: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const id = backendOf(backend);
        const view = await accountsApi(opts).strategy(id, strategy);
        if (opts.json) emitJson(view);
        else printAccounts(view, id);
      });
    });

  accounts
    .command('adopt <backend>')
    .description("Store a machine's own login as a shared account")
    .option('--host <h>', 'machine name or hostId prefix (default: the only machine online)')
    .option('--json', 'JSON output')
    .action(async (backend: string, opts: CommonOpts & { host?: string }) => {
      await run(opts, async () => {
        const hostId = await onlineHost(opts);
        const id = backendOf(backend);
        const state = await server(opts).post<SharedState>(`/api/accounts/${id}/adopt`, {
          hostId,
        });
        if (opts.json) emitJson(state);
        else printAccounts(viewOf(state), id);
      });
    });

  const keys = program.command('keys').description('Provider keys shared by every host');

  keys
    .command('list', { isDefault: true })
    .description('Each key: set or not, and its last four characters')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).get<SharedState>('/api/settings/shared');
        if (opts.json) {
          emitJson(state.secrets.providerKeys);
          return;
        }
        for (const k of state.secrets.providerKeys) {
          emitText(`${k.id}: ${k.set ? `set · ends ${k.last4 ?? '????'}` : 'not set'}`);
        }
      });
    });

  keys
    .command('set <keyId> [value]')
    .description(
      "Set a key for every host; with --host and no value, adopt that machine's environment key",
    )
    .option('--host <h>', 'machine name or hostId prefix to adopt from')
    .option('--json', 'JSON output')
    .action(
      async (keyId: string, value: string | undefined, opts: CommonOpts & { host?: string }) => {
        await run(opts, async () => {
          const t = server(opts);
          const path = `/api/providers/keys/${encodeURIComponent(keyId)}`;
          const res =
            value !== undefined
              ? await t.put<unknown>(path, { value })
              : await t.post<unknown>(`${path}/adopt`, { hostId: await onlineHost(opts) });
          if (opts.json) emitJson(res);
          else emitText(`${keyId}: set`);
        });
      },
    );

  keys
    .command('revoke <keyId>')
    .description('Delete a key from every host')
    .option('--json', 'JSON output')
    .action(async (keyId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const res = await server(opts).delete<unknown>(
          `/api/providers/keys/${encodeURIComponent(keyId)}`,
        );
        if (opts.json) emitJson(res);
        else emitText(`${keyId}: revoked`);
      });
    });
}

/** `--host`, or the only machine that is online when none is named. */
async function onlineHost(opts: CommonOpts & { host?: string }): Promise<string> {
  if (opts.host !== undefined) return resolveHost(opts);
  const { hosts } = await server(opts).get<{
    hosts: Array<{ hostId: string; online: boolean }>;
  }>('/api/hosts');
  const online = hosts.filter((h) => h.online);
  if (online.length !== 1) {
    throw new Error(
      `${online.length === 0 ? 'no machine is online' : 'more than one machine is online'} — name one with --host`,
    );
  }
  return (online[0] as { hostId: string }).hostId;
}
