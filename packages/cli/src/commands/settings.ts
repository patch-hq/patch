// `patch settings`, `patch accounts`, `patch keys` — the shared settings
// (spec/01 § Settings, spec/17 § Commands).
//
// These change what every host runs on, so they go to the SERVER wherever the
// CLI runs — never a host's own socket. With no server reachable they fail,
// naming it, rather than changing one host behind the others' backs.

import { createInterface } from 'node:readline/promises';
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
    accountStrategy: { claude: string; codex: string; acp?: string };
  };
  secrets: {
    claude: Array<{ id: string; label: string; connected: boolean; email?: string }>;
    codex: Array<{ id: string; label: string; kind: string; connected: boolean; email?: string }>;
    providerKeys: Array<{ id: string; set: boolean; last4?: string }>;
    acp?: AcpAccountView[];
  };
  hosts: Array<{ hostId: string; appliedVersion?: number; error?: string }>;
  problem?: string;
}

/** One ACP agent's account, as the server summarises it: never the key. */
export interface AcpAccountView {
  id: string;
  agentId: string;
  label: string;
  last4?: string;
  state?: { state: string; message?: string; until?: number };
}

type ServerCalls = {
  post<T>(p: string, b?: unknown): Promise<T>;
  put<T>(p: string, b?: unknown): Promise<T>;
};

/**
 * Sign an ACP agent in with an API key (spec/10 § Signing in): a new account,
 * or with `accountId` a new key on that account. The server checks the key
 * before it stores anything and answers with the summary, never the key.
 */
export async function acpSignIn(
  t: ServerCalls,
  args: { agentId: string; apiKey: string; accountId?: string; label?: string },
): Promise<SharedState> {
  const agent = encodeURIComponent(args.agentId);
  if (args.accountId !== undefined) {
    return t.put<SharedState>(
      `/api/accounts/acp/${agent}/${encodeURIComponent(args.accountId)}/key`,
      { apiKey: args.apiKey },
    );
  }
  return t.post<SharedState>(`/api/accounts/acp/${agent}`, {
    apiKey: args.apiKey,
    ...(args.label ? { label: args.label } : {}),
  });
}

/** Each ACP account on one line: agent, label, last four, state. */
export function acpAccountLines(list: readonly AcpAccountView[] | undefined): string[] {
  if (!list || list.length === 0) return ['  (no accounts)'];
  return list.map(
    (a) =>
      `  ${a.agentId}: ${a.label}${a.last4 ? ` · ends ${a.last4}` : ''}${a.state ? `  [${a.state.state}${a.state.message ? `: ${a.state.message}` : ''}]` : ''}  ${a.id}`,
  );
}

/** A key from `--api-key`, else read from stdin so it stays out of the shell history. */
async function apiKeyFrom(flag: string | undefined): Promise<string> {
  if (flag !== undefined) return flag;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const key = (await rl.question('API key: ')).trim();
  rl.close();
  if (key === '') throw new Error('no API key given');
  return key;
}

interface ChatGPTSignInStarted {
  signInId: string;
  userCode: string;
  url: string;
  intervalSeconds: number;
}
type ChatGPTSignInStatus =
  | { status: 'pending' }
  | { status: 'complete'; state: SharedState }
  | { status: 'failed'; error: string };

/**
 * Sign in to ChatGPT with a device code: print the code and address, approve on
 * any device, and wait until the server has the login (spec/10 § Signing in).
 * This is how a headless host's owner signs in.
 */
export async function chatgptDeviceSignIn(
  t: { get<T>(p: string): Promise<T>; post<T>(p: string, b?: unknown): Promise<T> },
  args: { accountId?: string; label?: string },
  say: (line: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SharedState> {
  const started = await t.post<ChatGPTSignInStarted>('/api/accounts/codex/signin', {
    ...(args.accountId ? { accountId: args.accountId } : {}),
    ...(args.label ? { label: args.label } : {}),
  });
  say(`Open ${started.url} on any device and enter the code ${started.userCode}`);
  for (;;) {
    await sleep(Math.max(1, started.intervalSeconds) * 1000);
    const res = await t.get<ChatGPTSignInStatus>(
      `/api/accounts/codex/signin/${encodeURIComponent(started.signInId)}`,
    );
    if (res.status === 'complete') return res.state;
    if (res.status === 'failed') throw new Error(res.error);
  }
}

/** An ACP agent's sign-in on one host, as the server reports it. */
export interface AcpLoginView {
  loginId: string;
  hostId: string;
  agentId: string;
  status: 'starting' | 'waiting' | 'complete' | 'failed' | 'cancelled';
  url?: string;
  userCode?: string;
  loopback?: boolean;
  message?: string;
}

/**
 * Sign an ACP agent in on one host with its own sign-in (spec/10 § Signing in):
 * the host runs it, and the login stays in the agent's files there. Prints the
 * address to open and any code, takes the address the browser ended on when the
 * agent waits for a redirect on the host (`paste`), and waits for the end.
 */
export async function acpHostLogin(
  t: {
    get<T>(p: string): Promise<T>;
    post<T>(p: string, b?: unknown): Promise<T>;
  },
  args: { agentId: string; hostId: string; methodId: string },
  io: {
    say: (line: string) => void;
    /** Asked once the agent waits for a redirect; resolves to the pasted address, or never. */
    paste: () => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<AcpLoginView> {
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = `/api/accounts/acp/${encodeURIComponent(args.agentId)}/login`;
  let view = await t.post<AcpLoginView>(base, { hostId: args.hostId, methodId: args.methodId });
  const path = `${base}/${encodeURIComponent(view.loginId)}`;
  let shown = '';
  let asking = false;
  let lastMessage: string | undefined;
  for (;;) {
    if (view.status === 'complete' || view.status === 'failed' || view.status === 'cancelled')
      return view;
    const said = `${view.url ?? ''}|${view.userCode ?? ''}`;
    if (view.status === 'waiting' && said !== shown && (view.url || view.userCode)) {
      shown = said;
      if (view.url) io.say(`Open ${view.url}`);
      if (view.userCode) io.say(`and enter the code ${view.userCode}`);
    }
    if (view.message && view.message !== lastMessage) {
      lastMessage = view.message;
      io.say(view.message);
    }
    if (view.loopback && !asking) {
      asking = true;
      io.say(
        'When you have signed in, the browser may end on a page that will not load. Paste its address here:',
      );
      void io.paste().then(
        (url) => {
          if (url.trim())
            void t
              .post(`${path}/callback`, { url: url.trim() })
              .catch((e: Error) => io.say(e.message));
        },
        () => undefined,
      );
    }
    await sleep(1000);
    view = await t.get<AcpLoginView>(path);
  }
}

const server = (opts: CommonOpts) => getTransport({ ...opts, remote: true });

/** `permission-mode` → `permissionModeDefault`, and the few other CLI names. */
const SETTING_KEYS: Record<string, string> = {
  'permission-mode': 'permissionModeDefault',
  'default-model': 'defaultModel',
  'question-expiry': 'questionExpiry',
  'question-expiry-seconds': 'questionExpirySeconds',
  // Retired: kept so a script that sets it still works; the server reads it as
  // the limit behaviour it meant.
  'auto-resume': 'autoResumeRateLimit',
  'limit-behaviour': 'limitBehaviour',
  'auto-update': 'autoUpdateHosts',
  'title-generation': 'titleGenerationEnabled',
  'status-generation': 'statusGenerationEnabled',
  'sync-position': 'syncPosition',
  'kokoro-voice': 'kokoroVoice',
  'tts-backend': 'ttsBackend',
  'elevenlabs-voice': 'elevenLabsVoice',
  'elevenlabs-model': 'elevenLabsModel',
  'gemini-voice': 'geminiVoice',
  'openai-voice': 'openaiVoice',
  'dictation-pause': 'dictationPauseSeconds',
  'turn-detection': 'dictationTurnDetection',
  memory: 'harnessMemoryEnabled',
  'small-job-models': 'smallJobModels',
  'speech-backend': 'speechBackend',
  'voice-device-prompt': 'voiceDevicePrompt',
  'manager-voice-prompt': 'managerVoicePrompt',
  'voice-match-threshold': 'voiceMatchThreshold',
};

/** A value as typed: JSON where it parses (true, 60, "x"), else the text itself. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The small-job models as typed: a JSON array, or a comma-separated list (set model first). */
export function parseModelList(raw: string): string[] {
  const v = parseValue(raw);
  if (Array.isArray(v)) return v.map(String);
  return raw.split(',').map((m) => m.trim());
}

const BOOLEAN_WORDS: Record<string, boolean> = {
  true: true,
  false: false,
  on: true,
  off: false,
  yes: true,
  no: false,
};

/** For an on/off setting: true/false, on/off or yes/no (any case). Anything else is an error. */
export function parseBooleanValue(key: string, raw: string): boolean {
  const v = BOOLEAN_WORDS[raw.trim().toLowerCase()];
  if (v === undefined)
    throw new Error(`${key} is on/off — got "${raw}" (use on, off, yes, no, true or false)`);
  return v;
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
 * List / reorder / set strategy for the shared accounts. On a host with a
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
        // Only on/off settings take the words; a text setting may legitimately be "off".
        const current = await server(opts).get<SharedState>('/api/settings/shared');
        const next =
          typeof current.settings[field] === 'boolean'
            ? parseBooleanValue(key, value)
            : field === 'smallJobModels'
              ? parseModelList(value)
              : parseValue(value);
        const res = await server(opts).patch<unknown>('/api/settings', { [field]: next });
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
    .command('sign-in <backend>')
    .description(
      'Sign in to Claude (paste the code claude.ai shows) or ChatGPT (approve a device code on any device)',
    )
    .option('--account <id>', 'sign this account in again instead of adding one')
    .option('--label <l>', 'a name for it')
    .option('--json', 'JSON output')
    .action(async (backend: string, opts: CommonOpts & { account?: string; label?: string }) => {
      await run(opts, async () => {
        const id = backendOf(backend);
        const t = server(opts);
        const say = (line: string): void => {
          if (!opts.json) emitText(line);
        };
        let state: SharedState;
        if (id === 'codex') {
          state = await chatgptDeviceSignIn(
            t,
            {
              ...(opts.account ? { accountId: opts.account } : {}),
              ...(opts.label ? { label: opts.label } : {}),
            },
            say,
          );
        } else {
          const started = await t.post<{ signInId: string; url: string }>(
            '/api/accounts/claude-code/signin',
          );
          say(`Open ${started.url} in any browser, sign in, and paste the code it shows.`);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const code = (await rl.question('Code: ')).trim();
          rl.close();
          state = await t.post<SharedState>('/api/accounts/claude-code/signin/complete', {
            signInId: started.signInId,
            code,
            ...(opts.account ? { accountId: opts.account } : {}),
            ...(opts.label ? { label: opts.label } : {}),
          });
        }
        if (opts.json) emitJson(state);
        else printAccounts(viewOf(state), id);
      });
    });

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
    .description("Store a host's own login as a shared account")
    .option('--host <h>', 'host name or hostId prefix (default: the only host online)')
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

  // ACP agents' accounts (spec/10 § Signing in): an API key per account, held
  // by the server and sent to every host.
  const acp = accounts
    .command('acp')
    .description('ACP agents (Gemini CLI and others): their API-key accounts');

  acp
    .command('list', { isDefault: true })
    .description('Every ACP account: agent, label, last four characters and state')
    .option('--json', 'JSON output')
    .action(async (opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).get<SharedState>('/api/settings/shared');
        if (opts.json) emitJson(state.secrets.acp ?? []);
        else for (const line of acpAccountLines(state.secrets.acp)) emitText(line);
      });
    });

  acp
    .command('login <agentId>')
    .description(
      'Sign an agent in on one host with its own sign-in (no API key). The login stays on that host only',
    )
    .option('--host <h>', 'host name or hostId prefix (default: the only host online)')
    .option('--method <m>', "the agent's sign-in method (default: the first it offers)")
    .option('--json', 'JSON output')
    .action(async (agentId: string, opts: CommonOpts & { host?: string; method?: string }) => {
      await run(opts, async () => {
        const hostId = await onlineHost(opts);
        const t = server(opts);
        let methodId = opts.method;
        if (methodId === undefined) {
          const { backends } = await t.get<{
            backends: Array<{ id: string; loginMethods?: Array<{ id: string; name: string }> }>;
          }>(`/api/hosts/backends?hostId=${encodeURIComponent(hostId)}`);
          const methods = backends.find((b) => b.id === `acp:${agentId}`)?.loginMethods ?? [];
          if (methods.length === 0) {
            throw new Error(`${agentId} offers no sign-in on that host; add an API key instead`);
          }
          methodId = methods[0]!.id;
        }
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const view = await acpHostLogin(
            t,
            { agentId, hostId, methodId },
            { say: (line) => process.stderr.write(`${line}\n`), paste: () => rl.question('') },
          );
          if (opts.json) emitJson(view);
          else if (view.status === 'complete')
            emitText(
              `${agentId}: signed in on that host only (the login stays in its files there)`,
            );
          else throw new Error(view.message ?? `the sign-in ${view.status}`);
        } finally {
          rl.close();
        }
      });
    });

  acp
    .command('sign-in <agentId>')
    .description('Sign an ACP agent in with an API key (prompted for when --api-key is not given)')
    .option('--api-key <k>', 'the key; omit it to type it at a prompt')
    .option('--account <id>', 'give this account a new key instead of adding one')
    .option('--label <l>', 'a name for it')
    .option('--json', 'JSON output')
    .action(
      async (
        agentId: string,
        opts: CommonOpts & { apiKey?: string; account?: string; label?: string },
      ) => {
        await run(opts, async () => {
          const state = await acpSignIn(server(opts), {
            agentId,
            apiKey: await apiKeyFrom(opts.apiKey),
            ...(opts.account ? { accountId: opts.account } : {}),
            ...(opts.label ? { label: opts.label } : {}),
          });
          if (opts.json) emitJson(state.secrets.acp ?? []);
          else for (const line of acpAccountLines(state.secrets.acp)) emitText(line);
        });
      },
    );

  acp
    .command('order <agentId> <accountIds...>')
    .description("Set one agent's account order: every account, each once, first to last")
    .option('--json', 'JSON output')
    .action(async (agentId: string, accountIds: string[], opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).put<SharedState>(
          `/api/accounts/acp/${encodeURIComponent(agentId)}/order`,
          { accountIds },
        );
        if (opts.json) emitJson(state.secrets.acp ?? []);
        else for (const line of acpAccountLines(state.secrets.acp)) emitText(line);
      });
    });

  acp
    .command('strategy <strategy>')
    .description(
      "How a turn picks among each agent's accounts: priority, round-robin, soonest-reset, least-used",
    )
    .option('--json', 'JSON output')
    .action(async (strategy: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).put<SharedState>('/api/accounts/acp/strategy', {
          strategy,
        });
        if (opts.json) emitJson(state.settings.accountStrategy);
        else emitText(`ACP strategy: ${state.settings.accountStrategy.acp ?? 'priority'}`);
      });
    });

  acp
    .command('remove <agentId> <accountId>')
    .description('Remove an ACP account from every host')
    .option('--json', 'JSON output')
    .action(async (agentId: string, accountId: string, opts: CommonOpts) => {
      await run(opts, async () => {
        const state = await server(opts).delete<SharedState>(
          `/api/accounts/acp/${encodeURIComponent(agentId)}/${encodeURIComponent(accountId)}`,
        );
        if (opts.json) emitJson(state.secrets.acp ?? []);
        else for (const line of acpAccountLines(state.secrets.acp)) emitText(line);
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
      "Set a key for every host; with --host and no value, adopt that host's environment key",
    )
    .option('--host <h>', 'host name or hostId prefix to adopt from')
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

/** `--host`, or the only host that is online when none is named. */
async function onlineHost(opts: CommonOpts & { host?: string }): Promise<string> {
  if (opts.host !== undefined) return resolveHost(opts);
  const { hosts } = await server(opts).get<{
    hosts: Array<{ hostId: string; online: boolean }>;
  }>('/api/hosts');
  const online = hosts.filter((h) => h.online);
  if (online.length !== 1) {
    throw new Error(
      `${online.length === 0 ? 'no host is online' : 'more than one host is online'} — name one with --host`,
    );
  }
  return (online[0] as { hostId: string }).hostId;
}
