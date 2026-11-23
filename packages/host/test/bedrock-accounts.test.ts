// Claude on Amazon Bedrock accounts on a host (spec/10 § Backend credentials,
// § Choosing an account, § Spending caps). A FAKE AWS throughout: profiles are
// read from temp files named by AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE,
// and the AWS CLI is a stubbed child process. Nothing reaches AWS or Anthropic,
// and the real ~/.aws is never read.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeStoredAccount } from '@patch/auth';
import {
  BEDROCK_CAP_REACHED,
  BedrockSignIn,
  checkAwsProfile,
  claudeAccountsIdentity,
  readAwsProfiles,
  type ExecFileFn,
} from '../src/bedrockAccounts.js';
import { AccountRotation, type FailoverAccount } from '../src/accountFailover.js';
import { runClaudeOneShot, type ClaudeOneShotDeps } from '../src/claudeOneShot.js';
import { bedrockAtCap, bedrockCapResetsAt } from '@patch/wire';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-aws-'));
  env = {
    AWS_CONFIG_FILE: join(dir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readAwsProfiles', () => {
  it('names default, [profile x] and credentials sections with their region, nothing else', () => {
    writeFileSync(
      env.AWS_CONFIG_FILE!,
      [
        '# a comment',
        '[default]',
        'region = us-east-1',
        '',
        '[profile work]',
        'sso_session = corp',
        'region=eu-west-2',
        's3 =',
        '  region = ignored-nested',
        '',
        '[sso-session corp]',
        'sso_region = eu-west-1',
        '',
        '[profile  spaced]',
        'output = json',
      ].join('\n'),
    );
    writeFileSync(
      env.AWS_SHARED_CREDENTIALS_FILE!,
      [
        '[default]',
        'aws_access_key_id = AKIAFAKE',
        'aws_secret_access_key = fake',
        'region = ap-south-1',
        '[keys-only]',
        'aws_access_key_id = AKIAFAKE2',
        'region = ap-southeast-2',
      ].join('\n'),
    );
    const profiles = readAwsProfiles(env, dir);
    expect(profiles).toEqual([
      { name: 'default', region: 'us-east-1' },
      { name: 'work', region: 'eu-west-2' },
      { name: 'spaced' },
      { name: 'keys-only', region: 'ap-southeast-2' },
    ]);
    // Names and regions only: no key from either file is reported.
    expect(JSON.stringify(profiles)).not.toMatch(/AKIA|fake|corp/);
  });

  it('reads none when the files are missing, and uses ~/.aws without the overrides', () => {
    expect(readAwsProfiles(env, dir)).toEqual([]);
    // No override: the home passed in is the one read.
    expect(readAwsProfiles({}, dir)).toEqual([]);
  });
});

describe('checkAwsProfile (a stubbed AWS CLI)', () => {
  const profiles = () => [{ name: 'work', region: 'eu-west-2' }];
  const now = () => Date.UTC(2026, 10, 23, 12);

  it('a current profile is signed in; the CLI is asked for that profile with no host credentials', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const exec: ExecFileFn = async (_file, args, options) => {
      calls.push({ args, env: options.env });
      return {
        stdout: JSON.stringify({
          Version: 1,
          AccessKeyId: 'AKIAFAKE',
          SecretAccessKey: 'fake-secret',
          SessionToken: 'fake-session',
          Expiration: '2026-11-23T13:00:00Z',
        }),
        stderr: '',
      };
    };
    const result = await checkAwsProfile('work', {
      profiles,
      exec,
      now,
      env: { AWS_ACCESS_KEY_ID: 'AKIAHOST', AWS_PROFILE: 'other', PATH: '/bin' },
    });
    expect(result).toEqual({ exists: true, signedIn: true });
    expect(JSON.stringify(result)).not.toMatch(/AKIA|fake/);
    expect(calls[0]!.args).toEqual([
      'configure',
      'export-credentials',
      '--profile',
      'work',
      '--format',
      'process',
    ]);
    expect(calls[0]!.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(calls[0]!.env['AWS_PROFILE']).toBeUndefined();
    expect(calls[0]!.env['PATH']).toBe('/bin');
  });

  it('credentials past their expiry are signed out', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: JSON.stringify({ Version: 1, Expiration: '2026-11-23T11:00:00Z' }),
      stderr: '',
    });
    expect(await checkAwsProfile('work', { profiles, exec, now })).toEqual({
      exists: true,
      signedIn: false,
      error: 'AWS sign-in expired',
    });
  });

  it('an expired SSO login (the CLI refuses) is signed out, in the CLI’s words', async () => {
    const exec: ExecFileFn = async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 255,
        stderr: '\nError when retrieving token from sso: Token has expired and refresh failed\n',
      });
    };
    expect(await checkAwsProfile('work', { profiles, exec, now })).toEqual({
      exists: true,
      signedIn: false,
      error: 'Error when retrieving token from sso: Token has expired and refresh failed',
    });
  });

  it('no AWS CLI cannot check: signedIn null', async () => {
    const exec: ExecFileFn = async () => {
      throw Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
    };
    const result = await checkAwsProfile('work', { profiles, exec, now });
    expect(result.exists).toBe(true);
    expect(result.signedIn).toBeNull();
    expect(result.error).toMatch(/AWS CLI/);
  });

  it('a profile the host does not have is not asked about', async () => {
    let asked = false;
    const exec: ExecFileFn = async () => {
      asked = true;
      return { stdout: '{}', stderr: '' };
    };
    const result = await checkAwsProfile('missing', { profiles, exec, now });
    expect(result).toMatchObject({ exists: false, signedIn: null });
    expect(result.error).toMatch(/"missing"/);
    expect(asked).toBe(false);
  });
});

const bedrockFields = {
  hostId: 'host-a',
  awsProfile: 'work',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu' as const,
  monthlyCapUsd: 100,
  spentUsd: 10,
  spentMonth: '2026-11',
};

describe('BedrockSignIn', () => {
  it('checks held Bedrock accounts and reports AWS sign-in expired', async () => {
    let signedIn = true;
    let changes = 0;
    const accounts: ClaudeStoredAccount[] = [
      { id: 'c1', label: 'Claude', credential: { accessToken: 'tok' } },
      { id: 'b1', label: 'Work AWS', credential: null, auto: false, bedrock: bedrockFields },
    ];
    const checked: string[] = [];
    const monitor = new BedrockSignIn({
      accounts: () => accounts,
      check: async (profile) => {
        checked.push(profile);
        return signedIn
          ? { exists: true, signedIn: true }
          : { exists: true, signedIn: false, error: 'Token has expired' };
      },
      onChange: () => changes++,
    });
    expect(monitor.signedOut('b1')).toBe(false); // not checked yet is not signed out
    await monitor.checkAll();
    expect(checked).toEqual(['work']);
    expect(monitor.error('b1')).toBeUndefined();
    signedIn = false;
    await monitor.checkAll();
    expect(monitor.signedOut('b1')).toBe(true);
    expect(monitor.error('b1')).toBe('AWS sign-in expired');
    expect(changes).toBe(2);
    await monitor.checkAll();
    expect(changes).toBe(2); // no change, no report
  });
});

describe('AccountRotation.order and auto', () => {
  const accounts: FailoverAccount[] = [
    { id: 'a', connected: true },
    { id: 'off', connected: true, auto: false },
    { id: 'b', connected: true, auto: true },
  ];

  it('leaves an account with auto off out of every strategy', () => {
    const rotation = new AccountRotation(() => 0);
    for (const strategy of ['priority', 'round-robin', 'soonest-reset', 'least-used'] as const) {
      expect(rotation.order(accounts, { strategy }).map((a) => a.id)).toEqual(['a', 'b']);
    }
  });

  it('a chat locked to it runs on it', () => {
    const rotation = new AccountRotation(() => 0);
    expect(rotation.usableAccount(accounts, { preferred: 'off' })).toBe('off');
  });

  it('a spent lock set aside moves only to accounts in the order', () => {
    const rotation = new AccountRotation(() => 0);
    rotation.markExhausted('a', 'spent');
    expect(
      rotation.order(accounts, { preferred: 'a', resumeOnAnyAccount: true }).map((x) => x.id),
    ).toEqual(['a', 'b']);
    // Nothing else in the order: no failover onto it.
    rotation.markExhausted('b', 'spent');
    expect(rotation.usableAccount(accounts, {})).toBeUndefined();
  });
});

describe('Bedrock cap', () => {
  it('at the cap the account is limited until the first of next month, UTC', () => {
    const now = Date.UTC(2026, 10, 23, 12);
    const capped = { ...bedrockFields, spentUsd: 100 };
    expect(bedrockAtCap(capped, now)).toBe(true);
    let clock = now;
    const rotation = new AccountRotation(() => clock);
    rotation.markExhausted('b1', BEDROCK_CAP_REACHED, bedrockCapResetsAt(now), undefined, 'limit');
    const accounts: FailoverAccount[] = [
      { id: 'b1', connected: true },
      { id: 'c1', connected: true },
    ];
    expect(rotation.usableAccount(accounts)).toBe('c1');
    expect(rotation.exhaustedUntil('b1')).toBe(Date.UTC(2026, 11, 1));
    clock = Date.UTC(2026, 11, 1);
    expect(rotation.usableAccount(accounts)).toBe('b1');
  });

  it('spend alone is not new keys; the profile or cap is', () => {
    const a = [{ id: 'b1', bedrock: bedrockFields }];
    expect(
      claudeAccountsIdentity([{ id: 'b1', bedrock: { ...bedrockFields, spentUsd: 42 } }]),
    ).toBe(claudeAccountsIdentity(a));
    expect(
      claudeAccountsIdentity([{ id: 'b1', bedrock: { ...bedrockFields, awsProfile: 'other' } }]),
    ).not.toBe(claudeAccountsIdentity(a));
  });
});

describe('one-shot calls and backgroundAccount', () => {
  const stored: ClaudeStoredAccount[] = [
    { id: 'c1', label: 'Claude', credential: { accessToken: 'tok-c1' } },
    { id: 'b1', label: 'Work AWS', credential: null, auto: false, bedrock: bedrockFields },
    { id: 'c2', label: 'Spare', credential: { accessToken: 'tok-c2' }, auto: false },
  ];
  const silent = { info: () => {}, warn: () => {} };
  const deps = (rotation = new AccountRotation(() => 0)): ClaudeOneShotDeps => ({
    accounts: () => stored,
    rotation,
    route: (preferred) => ({
      accounts: stored.map((a) => ({
        id: a.id,
        connected: true,
        ...(a.auto !== undefined ? { auto: a.auto } : {}),
      })),
      route: {
        strategy: 'priority',
        ...(preferred !== undefined ? { preferred } : {}),
        resumeOnAnyAccount: true,
      },
    }),
    resolveOAuth: async (id) => {
      const a = stored.find((x) => x.id === id);
      return a?.credential
        ? { ok: true, accessToken: a.credential.accessToken }
        : { ok: false, reason: 'no credential' };
    },
    probeBlocked: () => false,
    onMarked: () => {},
    logger: silent,
  });
  const seen = async (only?: string, d = deps()) => {
    const calls: Array<{ token: string; profile?: string }> = [];
    const out = await runClaudeOneShot(
      d,
      'title gen',
      async (token, bedrock) => {
        calls.push({ token, ...(bedrock ? { profile: bedrock.awsProfile } : {}) });
        return 'ok';
      },
      only,
    );
    return { out, calls };
  };

  it('auto: the normal order, never an account with auto off', async () => {
    expect((await seen()).calls).toEqual([{ token: 'tok-c1' }]);
    const rotation = new AccountRotation(() => 0);
    rotation.markExhausted('c1', 'spent');
    const spent = await seen(undefined, deps(rotation));
    expect(spent.out).toBeNull();
    expect(spent.calls).toEqual([]);
  });

  it('a named Bedrock account runs there, on its profile, with no token', async () => {
    expect((await seen('b1')).calls).toEqual([{ token: '', profile: 'work' }]);
  });

  it('a named account runs there alone, even spent, rather than anywhere else', async () => {
    expect((await seen('c2')).calls).toEqual([{ token: 'tok-c2' }]);
    const rotation = new AccountRotation(() => 0);
    rotation.markExhausted('b1', BEDROCK_CAP_REACHED, Date.UTC(2026, 11, 1));
    const capped = await seen('b1', deps(rotation));
    expect(capped.out).toBeNull();
    expect(capped.calls).toEqual([]);
  });

  it('a named account this host does not hold runs nowhere', async () => {
    const r = await seen('elsewhere');
    expect(r.out).toBeNull();
    expect(r.calls).toEqual([]);
  });
});
