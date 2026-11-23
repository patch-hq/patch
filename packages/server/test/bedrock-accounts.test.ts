// Claude on Amazon Bedrock accounts (spec/10 § Backend credentials, § Signing
// in, § Spending caps) and the Auto flag and titles/status account that came
// with them (§ Choosing an account). The server stores the account, asks its
// host to check the profile, sends it to that host only, and keeps its spend.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { EMPTY_SHARED_SECRETS, type AwsProfileInfo, type WireEvent } from '@patch/wire';
import { SharedSettingsService, type BedrockAccountInput } from '../src/shared-settings.js';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const NOV_23 = Date.UTC(2026, 10, 23, 12);
const DEC_2 = Date.UTC(2026, 11, 2, 9);

const WORK: BedrockAccountInput = {
  label: 'Work AWS',
  hostId: 'mac',
  awsProfile: 'work',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu',
  monthlyCapUsd: 100,
};

type ProfileAnswer = { exists: boolean; signedIn: boolean | null; error?: string } | 'silent';

const hostInfo = (hostId: string, awsProfiles?: AwsProfileInfo[]): WireEvent =>
  ({
    type: 'host.host',
    hostId,
    hostName: hostId,
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
    voiceKeys: { gemini: false, openai: false },
    ...(awsProfiles ? { awsProfiles } : {}),
  }) as WireEvent;

describe('Bedrock accounts in the shared settings', () => {
  let dir: string;
  let sent: Array<{ hostId: string; event: WireEvent }>;
  let online: string[];
  let answer: ProfileAnswer;
  let now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-bedrock-'));
    sent = [];
    online = ['mac', 'box'];
    answer = { exists: true, signedIn: true };
    now = NOV_23;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (): SharedSettingsService => {
    const svc: SharedSettingsService = new SharedSettingsService({
      dataDir: dir,
      now: () => now,
      profileCheckTimeoutMs: 50,
      hostName: (id) => (id === 'mac' ? 'Mac mini' : id),
      sendToHost: (hostId, event) => {
        sent.push({ hostId, event });
        if (event.type === 'settings.adopt.request' && event.kind === 'import') {
          queueMicrotask(() =>
            svc.handleHostEvent({
              type: 'settings.adopt.response',
              requestId: event.requestId,
              hostId,
              ok: true,
              result: { kind: 'import', import: { settings: {}, secrets: EMPTY_SHARED_SECRETS } },
            }),
          );
        }
        if (event.type === 'patch.aws_profile_check.request' && answer !== 'silent') {
          const a = answer;
          queueMicrotask(() =>
            svc.handleHostEvent({
              type: 'patch.aws_profile_check.response',
              requestId: event.requestId,
              hostId,
              ...a,
            }),
          );
        }
      },
      onlineHostIds: () => online,
      broadcast: () => undefined,
      validateClaude: async () => ({ kind: 'ok', organizationId: 'org-1' }),
    });
    return svc;
  };

  /** Both hosts online, imported, and the Mac reporting its AWS profiles. */
  const ready = async (): Promise<SharedSettingsService> => {
    const svc = make();
    svc.hostOnline('mac');
    svc.hostOnline('box');
    await new Promise((r) => setTimeout(r, 10));
    svc.handleHostEvent(hostInfo('mac', [{ name: 'work', region: 'eu-west-2' }]));
    return svc;
  };

  const snapshotTo = (hostId: string) =>
    sent
      .filter((s) => s.hostId === hostId)
      .map((s) => s.event)
      .filter(
        (e): e is Extract<WireEvent, { type: 'settings.snapshot' }> =>
          e.type === 'settings.snapshot',
      )
      .at(-1);

  const row = (svc: SharedSettingsService, id: string) =>
    svc.secretsSummary().claude.find((a) => a.id === id);

  const spend = (svc: SharedSettingsService, accountId: string, costUsd: number, at = now) =>
    svc.handleHostEvent({ type: 'host.account_spend', hostId: 'mac', accountId, costUsd, at });

  it('stores a Bedrock account checked by its host, off the order, with no credential', async () => {
    const svc = await ready();
    const account = await svc.addBedrock(WORK);
    const check = sent.find((s) => s.event.type === 'patch.aws_profile_check.request');
    expect(check).toMatchObject({ hostId: 'mac', event: { awsProfile: 'work', hostId: 'mac' } });
    expect(account).toMatchObject({ credential: null, auto: false });
    expect(row(svc, account.id)).toEqual({
      id: account.id,
      label: 'Work AWS',
      connected: true,
      state: { state: 'ready' },
      auto: false,
      bedrock: {
        hostId: 'mac',
        awsProfile: 'work',
        awsRegion: 'eu-west-2',
        regionPrefix: 'eu',
        monthlyCapUsd: 100,
        spentUsd: 0,
        spentMonth: '2026-11',
      },
    });
    // Kept across a restart.
    expect(
      make()
        .secretsSummary()
        .claude.map((a) => a.bedrock?.awsProfile),
    ).toEqual(['work']);
  });

  it('sends a Bedrock account only to its own host, and only once it can run one', async () => {
    const svc = make();
    svc.hostOnline('mac');
    svc.hostOnline('box');
    await new Promise((r) => setTimeout(r, 10));
    // The box can run Bedrock too, but the account is not on it.
    svc.handleHostEvent(hostInfo('box', []));
    svc.handleHostEvent(hostInfo('mac', [{ name: 'work' }]));
    await svc.addClaude('sk-ant-oat-token', 'Max');
    const account = await svc.addBedrock(WORK);
    expect(snapshotTo('mac')?.secrets.claude.map((a) => a.id)).toContain(account.id);
    expect(snapshotTo('box')?.secrets.claude.map((a) => a.label)).toEqual(['Max']);

    // The Mac reconnects as an older build that reports no profiles: it loses the account …
    svc.handleHostEvent(hostInfo('mac'));
    expect(snapshotTo('mac')?.secrets.claude.map((a) => a.label)).toEqual(['Max']);
    // … and gets it back, unprompted, once it reports them again.
    svc.handleHostEvent(hostInfo('mac', [{ name: 'work' }]));
    expect(snapshotTo('mac')?.secrets.claude.map((a) => a.id)).toContain(account.id);
  });

  it('stores nothing when the host is offline, cannot run Bedrock, does not answer, or lacks the profile', async () => {
    const svc = await ready();
    online = ['box'];
    await expect(svc.addBedrock(WORK)).rejects.toMatchObject({
      status: 409,
      code: 'host_offline',
      message: 'Mac mini is offline',
    });
    online = ['mac', 'box'];
    await expect(svc.addBedrock({ ...WORK, hostId: 'box' })).rejects.toMatchObject({
      code: 'bedrock_unsupported',
    });
    answer = 'silent';
    await expect(svc.addBedrock(WORK)).rejects.toMatchObject({ status: 504 });
    answer = { exists: false, signedIn: null };
    await expect(svc.addBedrock({ ...WORK, awsProfile: 'gone' })).rejects.toMatchObject({
      status: 400,
      code: 'profile_not_found',
      message: expect.stringContaining('gone'),
    });
    expect(svc.secretsSummary().claude).toEqual([]);
  });

  it('stores a signed-out profile as signed out; its host reporting it signed in clears that', async () => {
    const svc = await ready();
    answer = { exists: true, signedIn: false, error: 'Token has expired' };
    const account = await svc.addBedrock(WORK);
    expect(row(svc, account.id)).toMatchObject({
      connected: false,
      state: { state: 'signed_out' },
    });
    const report = (connected: boolean, hostId = 'mac') =>
      svc.handleHostEvent({
        type: 'host.account',
        hostId,
        backendId: 'claude-code',
        connected: true,
        accounts: [
          {
            id: account.id,
            label: 'Work AWS',
            connected,
            ...(connected ? {} : { error: 'AWS sign-in expired' }),
          },
        ],
      } as WireEvent);
    // Another host has no say over it.
    report(true, 'box');
    expect(row(svc, account.id)?.state).toEqual({ state: 'signed_out' });
    report(true);
    expect(row(svc, account.id)).toMatchObject({ connected: true, state: { state: 'ready' } });
    report(false);
    expect(row(svc, account.id)).toMatchObject({
      connected: false,
      state: { state: 'signed_out' },
    });
  });

  it('refuses the same host and profile twice, naming the row', async () => {
    const svc = await ready();
    await svc.addBedrock(WORK);
    const checks = () =>
      sent.filter((s) => s.event.type === 'patch.aws_profile_check.request').length;
    const before = checks();
    await expect(svc.addBedrock({ ...WORK, label: 'Again' })).rejects.toMatchObject({
      status: 409,
      code: 'duplicate_account',
      message: expect.stringContaining('Work AWS'),
    });
    // Refused before the host was asked.
    expect(checks()).toBe(before);
  });

  it('adds up spend, starts a new month at nothing, and limits the account at its cap', async () => {
    const svc = await ready();
    const { id } = await svc.addBedrock(WORK);
    spend(svc, id, 18.42);
    spend(svc, id, 1.58);
    expect(row(svc, id)?.bedrock).toMatchObject({ spentUsd: 20, spentMonth: '2026-11' });
    // Pushed to the host, which checks the cap before a turn.
    expect(snapshotTo('mac')?.secrets.claude.find((a) => a.id === id)?.bedrock?.spentUsd).toBe(20);
    // Kept across a restart.
    expect(make().secretsSummary().claude[0]?.bedrock?.spentUsd).toBe(20);

    spend(svc, id, 80);
    expect(row(svc, id)?.state).toEqual({ state: 'limited', until: Date.UTC(2026, 11, 1) });
    expect(svc.accountState(id)).toEqual({ state: 'limited', until: Date.UTC(2026, 11, 1) });

    // Raising the cap above the spend makes it ready at once.
    await svc.editClaude(id, { monthlyCapUsd: 150 });
    expect(row(svc, id)?.state).toEqual({ state: 'ready' });
    await svc.editClaude(id, { monthlyCapUsd: 100 });
    expect(row(svc, id)?.state.state).toBe('limited');

    // A new month: the cap has reset before any spend arrives …
    now = DEC_2;
    expect(row(svc, id)?.state).toEqual({ state: 'ready' });
    // … and the first spend of it starts from nothing.
    spend(svc, id, 2.5);
    expect(row(svc, id)?.bedrock).toMatchObject({ spentUsd: 2.5, spentMonth: '2026-12' });
    // A late report for the closed month is not counted against the new one.
    spend(svc, id, 9, NOV_23);
    expect(row(svc, id)?.bedrock).toMatchObject({ spentUsd: 2.5, spentMonth: '2026-12' });
  });

  it('ignores spend from another host or for an account that is not Bedrock', async () => {
    const svc = await ready();
    const { id } = await svc.addBedrock(WORK);
    const max = await svc.addClaude('sk-ant-oat-token', 'Max');
    svc.handleHostEvent({
      type: 'host.account_spend',
      hostId: 'box',
      accountId: id,
      costUsd: 5,
      at: now,
    });
    spend(svc, max.id, 5);
    expect(row(svc, id)?.bedrock?.spentUsd).toBe(0);
    expect(row(svc, max.id)).not.toHaveProperty('bedrock');
  });

  it('edits a Bedrock row, re-checking a new profile; refuses Bedrock fields on another account', async () => {
    const svc = await ready();
    const { id } = await svc.addBedrock(WORK);
    await svc.addBedrock({ ...WORK, label: 'Personal AWS', awsProfile: 'personal' });
    const checks = () =>
      sent.filter((s) => s.event.type === 'patch.aws_profile_check.request').length;
    const before = checks();
    await svc.editClaude(id, { awsRegion: 'us-east-1', regionPrefix: 'us' });
    expect(checks()).toBe(before);
    expect(row(svc, id)?.bedrock).toMatchObject({ awsRegion: 'us-east-1', regionPrefix: 'us' });
    await expect(svc.editClaude(id, { awsProfile: 'personal' })).rejects.toMatchObject({
      code: 'duplicate_account',
      message: expect.stringContaining('Personal AWS'),
    });
    answer = { exists: true, signedIn: false };
    await svc.editClaude(id, { awsProfile: 'other' });
    expect(checks()).toBe(before + 1);
    expect(row(svc, id)).toMatchObject({
      bedrock: { awsProfile: 'other' },
      state: { state: 'signed_out' },
    });
    const max = await svc.addClaude('sk-ant-oat-token', 'Max');
    await expect(svc.editClaude(max.id, { monthlyCapUsd: 5 })).rejects.toMatchObject({
      status: 400,
    });
    // Patch holds no AWS sign-in to forget or replace.
    expect(() => svc.disconnect('claude-code', id)).toThrow(/no sign-in/);
    await expect(svc.connectClaude(id, 'sk-ant-oat-x')).rejects.toMatchObject({ status: 400 });
  });

  it('auto: absent reads as on; unticking moves an account after the others, ticking puts it last in the order', async () => {
    const svc = await ready();
    const a = await svc.addClaude('sk-ant-oat-a', 'A');
    const bedrock = await svc.addBedrock(WORK);
    const labels = () => svc.secretsSummary().claude.map((x) => `${x.label}:${x.auto ?? 'on'}`);
    expect(labels()).toEqual(['A:on', 'Work AWS:false']);
    await svc.editClaude(bedrock.id, { auto: true });
    expect(labels()).toEqual(['A:on', 'Work AWS:true']);
    await svc.editClaude(a.id, { auto: false });
    expect(labels()).toEqual(['Work AWS:true', 'A:false']);
    await svc.editClaude(a.id, { auto: true });
    expect(labels()).toEqual(['Work AWS:true', 'A:true']);
    // A Bedrock account sent with auto on joins the order.
    const second = await svc.addBedrock({ ...WORK, awsProfile: 'p2', label: 'P2', auto: true });
    expect(svc.secretsSummary().claude.find((x) => x.id === second.id)?.auto).toBe(true);
  });

  it('backgroundAccount takes auto or a Claude account, and goes back to auto when that account is removed', async () => {
    const svc = await ready();
    expect(svc.current().backgroundAccount).toBe('auto');
    expect(() => svc.update({ backgroundAccount: 'nope' })).toThrow(/No Claude account nope/);
    const { id } = await svc.addBedrock(WORK);
    svc.update({ backgroundAccount: id });
    expect(svc.current().backgroundAccount).toBe(id);
    expect(make().current().backgroundAccount).toBe(id);
    svc.remove('claude-code', id);
    expect(svc.current().backgroundAccount).toBe('auto');
  });
});

describe('Bedrock account routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-bedrock-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('POST /api/accounts/claude-code {bedrock} asks the host and stores; PATCH sets auto and the cap', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(47));
    const data = mkdtempSync(join(dir, 'data-'));
    const registry = Registry.load(data);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new InProcessHostLink();
    link.setHostId(null);
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink: link,
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    const auth = { authorization: `Bearer ${jwt}` };
    try {
      const original = link.sendTo.bind(link);
      link.sendTo = (hostId, surfaceId, event) => {
        original(hostId, surfaceId, event);
        if (event.type === 'settings.adopt.request') {
          queueMicrotask(() =>
            link.emit(
              {
                type: 'settings.adopt.response',
                requestId: event.requestId,
                hostId,
                ok: true,
                result: { kind: 'import', import: { settings: {}, secrets: EMPTY_SHARED_SECRETS } },
              },
              hostId,
            ),
          );
        }
        if (event.type === 'patch.aws_profile_check.request') {
          queueMicrotask(() =>
            link.emit(
              {
                type: 'patch.aws_profile_check.response',
                requestId: event.requestId,
                hostId,
                exists: event.awsProfile === 'work',
                signedIn: null,
              },
              hostId,
            ),
          );
        }
      };
      const body = (awsProfile: string) => ({
        bedrock: { ...WORK, hostId: 'd1', awsProfile },
      });
      const post = (payload: object) =>
        built.app.inject({
          method: 'POST',
          url: '/api/accounts/claude-code',
          headers: auth,
          payload,
        });

      // Offline: nothing stored.
      const offline = await post(body('work'));
      expect(offline.statusCode).toBe(409);
      expect(offline.json()).toMatchObject({ error: 'host_offline' });

      link.addOnlineHost('d1');
      await new Promise((r) => setTimeout(r, 20));
      link.emit(hostInfo('d1', [{ name: 'work', region: 'eu-west-2' }]), 'd1');

      const missing = await post(body('gone'));
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: 'profile_not_found' });

      const added = await post(body('work'));
      expect(added.statusCode).toBe(200);
      const stored = added.json().secrets.claude[0];
      expect(stored).toMatchObject({
        label: 'Work AWS',
        auto: false,
        bedrock: { hostId: 'd1', awsProfile: 'work', monthlyCapUsd: 100, spentUsd: 0 },
      });

      const dup = await post(body('work'));
      expect(dup.statusCode).toBe(409);
      expect(dup.json().message).toContain('Work AWS');

      const bad = await post({ bedrock: { ...WORK, hostId: 'd1', regionPrefix: 'mars' } });
      expect(bad.statusCode).toBe(400);

      const patched = await built.app.inject({
        method: 'PATCH',
        url: `/api/accounts/claude-code/${stored.id}`,
        headers: auth,
        payload: { auto: true, monthlyCapUsd: 250, label: 'AWS' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().secrets.claude[0]).toMatchObject({
        label: 'AWS',
        auto: true,
        bedrock: { monthlyCapUsd: 250 },
      });

      const background = await built.app.inject({
        method: 'PATCH',
        url: '/api/settings/shared',
        headers: auth,
        payload: { backgroundAccount: 'nobody' },
      });
      expect(background.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});
