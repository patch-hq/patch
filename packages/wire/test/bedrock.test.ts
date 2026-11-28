import { describe, expect, it } from 'vitest';
import {
  bedrockAtCap,
  bedrockCapResetsAt,
  bedrockMonth,
  bedrockSpentThisMonth,
  ClaudeBedrock,
  DEFAULT_SHARED_SETTINGS,
  decode,
  decodeCompat,
  lockableAccounts,
  SharedClaudeAccount,
  SharedSecretsSummary,
  SharedSettings,
  SharedSettingsPatch,
} from '../src/index.js';

const bedrock: ClaudeBedrock = {
  hostId: 'host-a',
  awsProfile: 'work',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu',
  monthlyCapUsd: 100,
  spentUsd: 18.42,
  spentMonth: '2026-11',
};

const NOV_23 = Date.UTC(2026, 10, 23, 12);

describe('Claude on Amazon Bedrock accounts (spec/10 § Backend credentials)', () => {
  it('an account stored before auto and bedrock still decodes; both are optional', () => {
    const old = { id: 'c1', label: 'Claude', credential: { accessToken: 'sk-ant-oat-x' } };
    expect(SharedClaudeAccount.parse(old)).toEqual(old);
    const row = { id: 'c1', label: 'Claude', connected: true };
    expect(
      SharedSecretsSummary.parse({ claude: [row], codex: [], providerKeys: [] }).claude,
    ).toEqual([row]);
  });

  it('a Bedrock account has no credential and its bedrock fields', () => {
    const account = { id: 'b1', label: 'Work AWS', credential: null, auto: false, bedrock };
    expect(SharedClaudeAccount.parse(account)).toEqual(account);
    expect(() =>
      SharedClaudeAccount.parse({ ...account, bedrock: { ...bedrock, regionPrefix: 'mars' } }),
    ).toThrow();
    expect(() =>
      SharedClaudeAccount.parse({ ...account, bedrock: { ...bedrock, monthlyCapUsd: 0 } }),
    ).toThrow();
    expect(() =>
      SharedClaudeAccount.parse({ ...account, bedrock: { ...bedrock, spentMonth: '2026-1' } }),
    ).toThrow();
  });

  it('backgroundAccount reads as auto from settings that predate it', () => {
    const { backgroundAccount: _gone, ...older } = DEFAULT_SHARED_SETTINGS;
    expect(SharedSettings.parse(older).backgroundAccount).toBe('auto');
    expect(DEFAULT_SHARED_SETTINGS.backgroundAccount).toBe('auto');
    // A patch that does not name it does not set it.
    expect(SharedSettingsPatch.parse({ experimentalFeatures: true })).toEqual({
      experimentalFeatures: true,
    });
  });

  it('host.host carries awsProfiles, and a host without them still decodes', () => {
    const report = {
      type: 'host.host',
      hostId: 'host-a',
      hostName: 'Mac',
      platform: 'darwin',
      arch: 'arm64',
      hostVersion: '0.1.1',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      defaultModel: 'claude-opus-5',
      runsManager: false,
      backends: [],
      components: [],
      voiceCatalog: {},
      voiceKeys: { gemini: false, openai: false, groq: false },
    };
    const plain = decode(JSON.stringify(report));
    expect((plain as { awsProfiles?: unknown }).awsProfiles).toBeUndefined();
    const withProfiles = decode(
      JSON.stringify({
        ...report,
        awsProfiles: [{ name: 'work', region: 'eu-west-2' }, { name: 'default' }],
      }),
    );
    expect((withProfiles as { awsProfiles?: unknown }).awsProfiles).toEqual([
      { name: 'work', region: 'eu-west-2' },
      { name: 'default' },
    ]);
  });

  it('a profile check answer and a spend report decode', () => {
    expect(
      decodeCompat(
        JSON.stringify({
          type: 'patch.aws_profile_check.response',
          requestId: 'r1',
          hostId: 'host-a',
          exists: true,
          signedIn: false,
          error: 'Token has expired',
        }),
      ).event,
    ).toMatchObject({ exists: true, signedIn: false });
    expect(() =>
      decode(
        JSON.stringify({
          type: 'host.account_spend',
          hostId: 'host-a',
          accountId: 'b1',
          costUsd: -1,
          at: NOV_23,
        }),
      ),
    ).toThrow();
  });
});

describe('lockableAccounts with a host', () => {
  const secrets = {
    claude: [
      { id: 'c1', label: 'Claude', connected: true },
      { id: 'b1', label: 'Work AWS', connected: true, auto: false, bedrock },
    ],
  };

  it('offers a Bedrock account only for a chat on its host', () => {
    expect(lockableAccounts(secrets, 'claude-sonnet-5', 'host-a').map((a) => a.id)).toEqual([
      'c1',
      'b1',
    ]);
    expect(lockableAccounts(secrets, 'claude-sonnet-5', 'host-b').map((a) => a.id)).toEqual(['c1']);
    expect(lockableAccounts(secrets, 'claude-sonnet-5').map((a) => a.id)).toEqual(['c1']);
  });
});

describe('Bedrock spend month and cap (spec/10 § Spending caps)', () => {
  it('counts a month in UTC and resets on the first of the next', () => {
    expect(bedrockMonth(NOV_23)).toBe('2026-11');
    expect(bedrockMonth(Date.UTC(2026, 11, 31, 23, 59))).toBe('2026-12');
    expect(bedrockCapResetsAt(NOV_23)).toBe(Date.UTC(2026, 11, 1));
    expect(bedrockCapResetsAt(Date.UTC(2026, 11, 5))).toBe(Date.UTC(2027, 0, 1));
  });

  it('reads another month’s spend as 0 and is at the cap from the cap up', () => {
    expect(bedrockSpentThisMonth(bedrock, NOV_23)).toBe(18.42);
    expect(bedrockSpentThisMonth(bedrock, Date.UTC(2026, 11, 1))).toBe(0);
    expect(bedrockAtCap(bedrock, NOV_23)).toBe(false);
    expect(bedrockAtCap({ ...bedrock, spentUsd: 100 }, NOV_23)).toBe(true);
    expect(bedrockAtCap({ ...bedrock, spentUsd: 100 }, Date.UTC(2026, 11, 1))).toBe(false);
  });
});
