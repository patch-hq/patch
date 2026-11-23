// Claude on Amazon Bedrock accounts on this host (spec/10 § Backend
// credentials, § Spending caps; spec/02 § Bedrock accounts).
//
// A Bedrock account is an AWS profile on this host. Patch holds no AWS secret:
// it reads the profile NAMES (and each one's region) from the host's AWS config
// so a surface can offer them, asks the AWS CLI whether a profile's credentials
// are current, and reports what each run on the account cost. Nothing here ever
// reads, logs or sends a credential value.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  bedrockCapResetsAt,
  bedrockMonth,
  bedrockSpentThisMonth,
  type AwsProfileInfo,
  type ClaudeBedrock,
  type WireEvent,
} from '@patch/wire';
import type { ClaudeStoredAccount } from '@patch/auth';
import { BEDROCK_STRIPPED_ENV, type BedrockRun, type SdkBackend } from './sdkBackend.js';

/** The exact copy a surface shows for a Bedrock account whose profile is signed out (spec/10). */
export const AWS_SIGN_IN_EXPIRED = 'AWS sign-in expired';

/** How often held Bedrock accounts' profiles are checked. */
export const BEDROCK_SIGN_IN_CHECK_MS = 10 * 60_000;

const CHECK_TIMEOUT_MS = 30_000;

/** The AWS config and shared-credentials files, honouring the AWS CLI's own overrides. */
export function awsConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { config: string; credentials: string } {
  const set = (name: string): string | undefined => {
    const v = env[name];
    return v !== undefined && v !== '' ? v : undefined;
  };
  return {
    config: set('AWS_CONFIG_FILE') ?? join(home, '.aws', 'config'),
    credentials: set('AWS_SHARED_CREDENTIALS_FILE') ?? join(home, '.aws', 'credentials'),
  };
}

/** One INI file's sections, each with its `region` where it sets one. Missing file: none. */
function readIniSections(path: string): Array<{ section: string; region?: string }> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
  const out: Array<{ section: string; region?: string }> = [];
  let current: { section: string; region?: string } | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      current = { section: header[1]!.replace(/\s+/g, ' ') };
      out.push(current);
      continue;
    }
    // Only a top-level key: an indented line belongs to a nested block (`s3 =`).
    if (current === undefined || /^\s/.test(rawLine)) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1]!.toLowerCase() === 'region' && kv[2]!.trim() !== '') {
      current.region = kv[2]!.trim();
    }
  }
  return out;
}

/**
 * The AWS profiles this host has: `[default]` and `[profile x]` in the config,
 * `[x]` in the shared credentials, in the order first seen. Names and regions
 * only — no other key is read. The config's region wins over one set beside a
 * profile's credentials.
 */
export function readAwsProfiles(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): AwsProfileInfo[] {
  const paths = awsConfigPaths(env, home);
  const byName = new Map<string, AwsProfileInfo>();
  const add = (name: string, region: string | undefined, regionWins: boolean): void => {
    if (name === '') return;
    const known = byName.get(name);
    if (known === undefined) {
      byName.set(name, region !== undefined ? { name, region } : { name });
    } else if (region !== undefined && (regionWins || known.region === undefined)) {
      known.region = region;
    }
  };
  for (const { section, region } of readIniSections(paths.config)) {
    if (section === 'default') add('default', region, true);
    else if (section.startsWith('profile '))
      add(section.slice('profile '.length).trim(), region, true);
    // `[sso-session x]`, `[services x]` and the like are not profiles.
  }
  for (const { section, region } of readIniSections(paths.credentials)) {
    add(section, region, false);
  }
  return [...byName.values()];
}

/** The answer to `patch.aws_profile_check.request`, minus the routing fields. */
export interface AwsProfileCheck {
  exists: boolean;
  /** `null`: could not ask (no AWS CLI, or it did not answer). */
  signedIn: boolean | null;
  error?: string;
}

/** Runs a command and returns its output, rejecting with the process error on failure. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env: options.env, timeout: options.timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // stdout is never attached: on success or failure it may hold credentials.
          reject(Object.assign(err, { stderr: String(stderr) }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** The environment the check runs with: nothing of the host's own AWS credentials. */
function checkEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of BEDROCK_STRIPPED_ENV) delete out[name];
  delete out['AWS_PROFILE'];
  delete out['AWS_DEFAULT_PROFILE'];
  return out;
}

/** The first line of what the AWS CLI said, cut short; never stdout. */
function cliError(stderr: string | undefined, fallbackWords: string): string {
  const line = (stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return (line ?? fallbackWords).slice(0, 300);
}

/**
 * Does the profile exist here, and are its credentials current? Asks the AWS
 * CLI for them (`aws configure export-credentials`), which reaches no model and
 * costs nothing. The credentials it prints are parsed for their expiry and
 * dropped; nothing else of stdout is kept.
 */
export async function checkAwsProfile(
  awsProfile: string,
  deps: {
    profiles: () => AwsProfileInfo[];
    exec?: ExecFileFn;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  },
): Promise<AwsProfileCheck> {
  if (!deps.profiles().some((p) => p.name === awsProfile)) {
    return {
      exists: false,
      signedIn: null,
      error: `AWS profile "${awsProfile}" is not in this host's AWS config`,
    };
  }
  const exec = deps.exec ?? defaultExec;
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'aws',
      ['configure', 'export-credentials', '--profile', awsProfile, '--format', 'process'],
      { env: checkEnv(deps.env ?? process.env), timeout: CHECK_TIMEOUT_MS },
    ));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      return { exists: true, signedIn: null, error: 'The AWS CLI is not installed on this host' };
    }
    if (e.killed === true) {
      return { exists: true, signedIn: null, error: 'The AWS CLI did not answer in time' };
    }
    return { exists: true, signedIn: false, error: cliError(e.stderr, AWS_SIGN_IN_EXPIRED) };
  }
  let expiration: unknown;
  try {
    expiration = (JSON.parse(stdout) as { Expiration?: unknown }).Expiration;
  } catch {
    return {
      exists: true,
      signedIn: null,
      error: 'The AWS CLI answered with something that is not JSON',
    };
  } finally {
    stdout = '';
  }
  if (typeof expiration === 'string') {
    const at = Date.parse(expiration);
    if (Number.isFinite(at) && at <= (deps.now ?? Date.now)()) {
      return { exists: true, signedIn: false, error: AWS_SIGN_IN_EXPIRED };
    }
  }
  return { exists: true, signedIn: true };
}

/** The refusal a Bedrock account at its monthly cap is recorded with (spec/10 § Spending caps). */
export const BEDROCK_CAP_REACHED = 'Monthly spending cap reached';

/** What a chat is told when a turn would start on a Bedrock account at its cap. */
export function bedrockCapRefusal(label: string, now: number): string {
  const until = new Date(bedrockCapResetsAt(now)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${label}: ${BEDROCK_CAP_REACHED}. It is limited until ${until}.`;
}

/**
 * Spend this host has reported for an account in the month `now` falls in and
 * the server has not yet acknowledged: the `host.account_spend` frames still
 * in the outbox. The outbox is on disk, so a restart while offline keeps them,
 * and an acknowledgement — which the server sends only after it has added the
 * spend and pushed the snapshot carrying it — drops them.
 */
export function pendingBedrockSpendUsd(
  owed: readonly { event: WireEvent }[],
  accountId: string,
  now: number,
): number {
  const month = bedrockMonth(now);
  let total = 0;
  for (const { event } of owed) {
    if (event.type !== 'host.account_spend' || event.accountId !== accountId) continue;
    if (bedrockMonth(event.at) === month) total += event.costUsd;
  }
  return total;
}

/**
 * Has this month's spend reached the cap, counting spend the server has not
 * acknowledged yet? The server's figure alone would let turns run past the
 * cap for as long as the link is down.
 */
export function bedrockCappedWith(
  bedrock: Pick<ClaudeBedrock, 'spentUsd' | 'spentMonth' | 'monthlyCapUsd'>,
  pendingUsd: number,
  now: number,
): boolean {
  return bedrockSpentThisMonth(bedrock, now) + pendingUsd >= bedrock.monthlyCapUsd;
}

/**
 * The held Claude accounts as keys: each account's id, credential and, for a
 * Bedrock account, the host and profile it runs as. Nothing else — a label,
 * the `auto` flag, a region, a prefix, a cap or the month's spend changing is
 * not new keys, so it must not drop what is known about every other account's
 * credit (`syncBedrockCaps` handles a cap reached or lifted).
 */
export function claudeAccountsIdentity(
  accounts: readonly Pick<ClaudeStoredAccount, 'id' | 'credential' | 'bedrock'>[],
): string {
  return JSON.stringify(
    accounts.map((a) => ({
      id: a.id,
      credential: a.credential ?? null,
      bedrock:
        a.bedrock === undefined
          ? null
          : { hostId: a.bedrock.hostId, awsProfile: a.bedrock.awsProfile },
    })),
  );
}

/** The run a stored Bedrock account makes. */
export function bedrockRunOf(account: ClaudeStoredAccount): BedrockRun | undefined {
  const b = account.bedrock;
  if (b === undefined) return undefined;
  return {
    accountId: account.id,
    awsProfile: b.awsProfile,
    awsRegion: b.awsRegion,
    regionPrefix: b.regionPrefix,
  };
}

/**
 * Whether each held Bedrock account's profile is signed in, as last checked.
 * Checked on a timer, and whenever the held accounts change; a change is
 * reported so the host's account report says so.
 */
export class BedrockSignIn {
  private readonly state = new Map<string, AwsProfileCheck & { awsProfile: string }>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      accounts: () => ClaudeStoredAccount[];
      check: (awsProfile: string) => Promise<AwsProfileCheck>;
      onChange: () => void;
      logger?: { warn: (obj: object, msg: string) => void };
    },
  ) {}

  /** The last check of one account, if it has had one. */
  get(accountId: string): (AwsProfileCheck & { awsProfile: string }) | undefined {
    return this.state.get(accountId);
  }

  /** A known signed-out profile: the account cannot run. Not checked yet is not signed out. */
  signedOut(accountId: string): boolean {
    const s = this.state.get(accountId);
    return s !== undefined && (s.exists === false || s.signedIn === false);
  }

  /** What `host.account` says of the account when its profile cannot run. */
  error(accountId: string): string | undefined {
    const s = this.state.get(accountId);
    if (s === undefined) return undefined;
    if (!s.exists) return s.error;
    return s.signedIn === false ? AWS_SIGN_IN_EXPIRED : undefined;
  }

  /** Check every held Bedrock account now. Concurrent calls share one pass. */
  checkAll(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const held = this.deps.accounts().filter((a) => a.bedrock !== undefined);
    let changed = false;
    for (const id of [...this.state.keys()]) {
      if (!held.some((a) => a.id === id)) {
        this.state.delete(id);
        changed = true;
      }
    }
    for (const account of held) {
      const awsProfile = account.bedrock!.awsProfile;
      const result = await this.deps.check(awsProfile);
      if (result.signedIn === false || !result.exists) {
        this.deps.logger?.warn(
          { accountId: account.id, awsProfile, error: result.error },
          'Bedrock account: its AWS profile cannot run',
        );
      }
      const before = this.state.get(account.id);
      const next = { ...result, awsProfile };
      if (JSON.stringify(before) !== JSON.stringify(next)) changed = true;
      this.state.set(account.id, next);
    }
    if (changed) this.deps.onChange();
  }

  start(intervalMs: number = BEDROCK_SIGN_IN_CHECK_MS): void {
    this.stop();
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Every run on a Bedrock account reports what it cost (spec/10 § Spending
 * caps): turns and one-shot calls alike go through the backend, so this is the
 * one place that sees them all.
 */
export function withBedrockSpend(
  backend: SdkBackend,
  report: (accountId: string, costUsd: number) => void,
): SdkBackend {
  return {
    run(opts) {
      const bedrock = opts.bedrock;
      if (bedrock === undefined) return backend.run(opts);
      const own = opts.onResultCost;
      return backend.run({
        ...opts,
        onResultCost: (costUsd) => {
          own?.(costUsd);
          report(bedrock.accountId, costUsd);
        },
      });
    },
  };
}
