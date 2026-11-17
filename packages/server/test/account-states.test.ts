// One state per account, held by the server (spec/10 § Account states).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeTokenValidation } from '@patch/auth';
import type { HostAccountEvent, SettingsChangedEvent, WireEvent } from '@patch/wire';
import { SharedSettingsService } from '../src/shared-settings.js';

const TOKEN = 'sk-ant-oat01-fake-token-aaaaaaaaaaaa';
const validateClaude = async (): Promise<ClaudeTokenValidation> => ({
  kind: 'valid',
  organizationId: 'org-a',
});

describe('account states on the server', () => {
  let dir: string;
  let broadcasts: SettingsChangedEvent[];
  let clock: number;
  const make = () =>
    new SharedSettingsService({
      dataDir: dir,
      sendToHost: () => {},
      onlineHostIds: () => [],
      broadcast: (e) => broadcasts.push(e),
      validateClaude,
      now: () => clock,
    });
  let service: SharedSettingsService;

  const report = (hostId: string, id: string, extra: object): WireEvent =>
    ({
      type: 'host.account',
      hostId,
      backendId: 'claude-code',
      connected: true,
      accounts: [{ id, label: 'Claude', connected: true, ...extra }],
    }) as HostAccountEvent;

  const stateOf = (id: string) =>
    service.changedEvent().secrets.claude.find((a) => a.id === id)?.state;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-account-states-'));
    broadcasts = [];
    clock = 1_000_000;
    service = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sends every account with one state, ready until something is reported', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    expect(stateOf(id)).toEqual({ state: 'ready' });
  });

  it('is signed out once the login is forgotten, with nothing reported by any host', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    service.disconnect('claude-code', id);
    expect(stateOf(id)).toEqual({ state: 'signed_out' });
  });

  it('turns a host-reported refusal into limited-until and tells surfaces once', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    broadcasts.length = 0;
    const refusal = { kind: 'limit', until: clock + 60_000, message: 'limit', at: clock };
    service.handleHostEvent(report('d1', id, { refusal }));
    expect(stateOf(id)).toEqual({ state: 'limited', until: clock + 60_000 });
    expect(broadcasts).toHaveLength(1);
    // The same fact again changes nothing, so nothing is sent.
    service.handleHostEvent(report('d1', id, { refusal }));
    expect(broadcasts).toHaveLength(1);
  });

  it('shows the same state whichever host reported it', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    service.handleHostEvent(
      report('d1', id, {
        usage: { session: { status: 'rejected', resetsAt: clock + 5 }, at: clock },
      }),
    );
    // A second host that has not seen the refusal does not make the account ready.
    service.handleHostEvent(report('d2', id, {}));
    expect(stateOf(id)).toEqual({ state: 'limited', until: clock + 5 });
  });

  it('is out on billing, and a host that is offline does not make it look signed out', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    service.handleHostEvent(
      report('d1', id, {
        refusal: { kind: 'out', message: 'credit balance is too low', at: clock },
      }),
    );
    service.hostOffline('d1');
    expect(stateOf(id)).toEqual({ state: 'out', message: 'credit balance is too low' });
  });

  it('is signed out when a host reports the provider refused the login, until it is signed in again', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    service.handleHostEvent(report('d1', id, { needsSignIn: true }));
    expect(stateOf(id)).toEqual({ state: 'signed_out' });
    clock += 10;
    await service.connectClaude(id, TOKEN);
    expect(stateOf(id)).toEqual({ state: 'ready' });
  });

  it('keeps a known limit across a server restart', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    service.handleHostEvent(
      report('d1', id, {
        refusal: { kind: 'limit', until: clock + 60_000, message: 'l', at: clock },
      }),
    );
    const restarted = make();
    expect(restarted.changedEvent().secrets.claude[0]?.state).toEqual({
      state: 'limited',
      until: clock + 60_000,
    });
  });

  it('survives an unreadable state file: loud, not fatal, and the account is simply ready', async () => {
    const { id } = await service.addClaude(TOKEN, 'One');
    writeFileSync(join(dir, 'account-states.json'), '{ not json');
    const restarted = make();
    expect(restarted.changedEvent().secrets.claude.find((a) => a.id === id)?.state).toEqual({
      state: 'ready',
    });
  });

  it('is broken, in the provider words, when a renewal fails', async () => {
    const refreshClaude = async () => {
      throw new Error('Anthropic refused the refresh (HTTP 400)');
    };
    service = new SharedSettingsService({
      dataDir: dir,
      sendToHost: () => {},
      onlineHostIds: () => [],
      broadcast: (e) => broadcasts.push(e),
      validateClaude,
      refreshClaude,
    });
    const { id } = await service.addClaude(TOKEN, 'One');
    // Give it a credential that is due for renewal.
    (
      service as unknown as { secrets: { claude: { credential: object }[] } }
    ).secrets.claude[0]!.credential = { accessToken: TOKEN, refreshToken: 'r', expiresAt: 1 };
    await service.refreshCredentials();
    expect(stateOf(id)).toEqual({
      state: 'broken',
      message: 'Anthropic refused the refresh (HTTP 400)',
    });
  });
});
