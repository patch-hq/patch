// Shared settings (spec/01 § Settings): the server is the source of truth, and
// every host runs from the snapshot it was last sent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  generateUserKeypair,
  mintSurfaceCredential,
  type ClaudeTokenValidation,
} from '@patch/auth';
import {
  DEFAULT_SHARED_SETTINGS,
  EMPTY_SHARED_SECRETS,
  SettingsChangedEvent,
  type WireEvent,
} from '@patch/wire';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '@patch/wire/jobs';
import { SettingsError, SharedSettingsService } from '../src/shared-settings.js';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const TOKEN_A = 'sk-ant-oat01-fake-token-aaaaaaaaaaaa';
const TOKEN_B = 'sk-ant-oat01-fake-token-bbbbbbbbbbbb';
const GROQ = 'gsk_fake_groq_key_for_tests_1234';

/** Every file under `dir`, recursively, as one string. */
function everythingOnDisk(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? everythingOnDisk(p) : readFileSync(p, 'utf8');
  }
  return out;
}

/** Validates any token, naming the organisation the test assigned it. */
const orgs: Record<string, string> = { [TOKEN_A]: 'org-a', [TOKEN_B]: 'org-b' };
const validateClaude = async (token: string): Promise<ClaudeTokenValidation> =>
  token === 'bad'
    ? { kind: 'rejected', message: 'Anthropic rejected this token (HTTP 401)' }
    : token === 'offline'
      ? { kind: 'unreachable', message: 'Could not reach Anthropic' }
      : { kind: 'valid', ...(orgs[token] ? { organizationId: orgs[token] } : {}) };

describe('SharedSettingsService', () => {
  let dir: string;
  let sent: Array<{ hostId: string; event: WireEvent }>;
  let broadcasts: SettingsChangedEvent[];
  let online: string[];
  const make = () =>
    new SharedSettingsService({
      dataDir: dir,
      sendToHost: (hostId, event) => {
        sent.push({ hostId, event });
        // An online host answers an import at once with nothing held.
        if (event.type === 'settings.adopt.request' && event.kind === 'import') {
          queueMicrotask(() =>
            service.handleHostEvent({
              type: 'settings.adopt.response',
              requestId: event.requestId,
              hostId,
              ok: true,
              result: { kind: 'import', import: { settings: {}, secrets: EMPTY_SHARED_SECRETS } },
            }),
          );
        }
      },
      onlineHostIds: () => online,
      broadcast: (e) => broadcasts.push(e),
      hostName: (id) => ({ d1: 'hetzner', d2: 'mac' })[id],
      validateClaude,
      validateOpenAIKey: async (k) =>
        k.startsWith('sk-')
          ? { ok: true }
          : { ok: false, message: 'OpenAI refused the key (HTTP 401)' },
      adoptTimeoutMs: 200,
    });
  let service: SharedSettingsService;

  const snapshots = (hostId?: string) =>
    sent.filter(
      (s): s is { hostId: string; event: Extract<WireEvent, { type: 'settings.snapshot' }> } =>
        s.event.type === 'settings.snapshot' && (hostId === undefined || s.hostId === hostId),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-shared-settings-'));
    sent = [];
    broadcasts = [];
    online = [];
    service = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts from the defaults and reads an old preferences file as a partial one', () => {
    expect(service.current()).toMatchObject({
      ...DEFAULT_SHARED_SETTINGS,
      agentIdentity: {
        ...DEFAULT_SHARED_SETTINGS.agentIdentity,
        name: expect.stringMatching(/^Patch agent [A-Za-z0-9_-]{8}$/),
      },
    });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sweepEnabled: false }));
    expect(make().current()).toMatchObject({
      ...DEFAULT_SHARED_SETTINGS,
      sweepEnabled: false,
      agentIdentity: { name: expect.stringMatching(/^Patch agent [A-Za-z0-9_-]{8}$/) },
    });
  });

  it('gives every deployment a stable public name from its generated identity key', () => {
    const first = service.current().agentIdentity.name;
    expect(make().current().agentIdentity.name).toBe(first);
    const otherDir = mkdtempSync(join(tmpdir(), 'patch-shared-settings-other-'));
    try {
      dir = otherDir;
      expect(make().current().agentIdentity.name).not.toBe(first);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('has the job autonomy prompt at its default, including for a settings file written before it existed', () => {
    expect(service.current().jobAutonomyPrompt).toBe(DEFAULT_JOB_AUTONOMY_PROMPT);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sweepEnabled: false }));
    expect(make().current().jobAutonomyPrompt).toBe(DEFAULT_JOB_AUTONOMY_PROMPT);
  });

  it('always sends claudeSettings to surfaces, including from a settings file written before it existed', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sweepEnabled: false }));
    const fresh = make();
    expect(fresh.changedEvent().settings.claudeSettings).toEqual(
      DEFAULT_SHARED_SETTINGS.claudeSettings,
    );
    expect(SettingsChangedEvent.safeParse(fresh.changedEvent()).success).toBe(true);
  });

  it('refuses to start on a settings file with a key that is present and wrong', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sweepEnabled: 'yes' }));
    expect(() => make()).toThrow(/not valid settings/);
  });

  it('imports a new host once, then sends it the snapshot', async () => {
    online = ['d1'];
    service.hostOnline('d1');
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]!.event).toMatchObject({ type: 'settings.adopt.request', kind: 'import' });
    expect(snapshots('d1')).toHaveLength(1);
    expect(snapshots('d1')[0]!.event.secrets).not.toHaveProperty('webBotAuthKey');
    // The next connect goes straight to the snapshot.
    sent = [];
    service.hostOnline('d1');
    expect(sent.map((s) => s.event.type)).toEqual(['settings.snapshot']);
  });

  it('takes host-held settings from the FIRST host imported only', () => {
    service.mergeImport('d1', {
      settings: { permissionModeDefault: 'plan', questionExpirySeconds: 60, defaultModel: 'x' },
      secrets: EMPTY_SHARED_SECRETS,
    });
    service.mergeImport('d2', {
      settings: { permissionModeDefault: 'default' },
      secrets: EMPTY_SHARED_SECRETS,
    });
    const s = service.current();
    expect(s.permissionModeDefault).toBe('plan');
    expect(s.questionExpirySeconds).toBe(60);
    // The server already held the default model; a host does not overwrite it.
    expect(s.defaultModel).toBe(DEFAULT_SHARED_SETTINGS.defaultModel);
  });

  it('stores a per-provider permission default and refuses one the provider cannot run', () => {
    expect(service.current().providerPermissionDefaults).toEqual({});
    service.update({ providerPermissionDefaults: { codex: 'bypassPermissions' } });
    expect(service.current().providerPermissionDefaults).toEqual({ codex: 'bypassPermissions' });
    expect(() => service.update({ providerPermissionDefaults: { codex: 'auto' } })).toThrow(
      /codex cannot run permission mode auto/,
    );
    expect(() => service.update({ providerPermissionDefaults: { nope: 'plan' } })).toThrow(
      /unknown provider/,
    );
  });

  it('merges two hosts’ accounts, dropping a second copy of the same Claude account', () => {
    service.mergeImport('d1', {
      settings: {},
      secrets: {
        claude: [
          {
            id: 'default',
            label: 'Default',
            credential: { accessToken: TOKEN_A, organizationId: 'org-a' },
          },
        ],
        codex: [],
        providerKeys: { groq: GROQ },
      },
    });
    service.mergeImport('d2', {
      settings: {},
      secrets: {
        claude: [
          // Same organisation under another label: the same pool of credit.
          {
            id: 'default',
            label: 'Default',
            credential: { accessToken: 'other', organizationId: 'org-a' },
          },
          {
            id: 'default2',
            label: 'Default',
            credential: { accessToken: TOKEN_B, organizationId: 'org-b' },
          },
          { id: 'gone', label: 'Old', credential: null },
        ],
        codex: [],
        providerKeys: { groq: 'gsk_should_not_replace_the_first_one' },
      },
    });
    const claude = service.secretsSummary().claude;
    expect(claude.map((a) => a.organizationId)).toEqual(['org-a', 'org-b']);
    // A label that would read twice is told apart by the host it came from.
    expect(claude.map((a) => a.label)).toEqual(['Default', 'Default (mac)']);
    expect(service.secretsSummary().providerKeys.find((k) => k.id === 'groq')?.last4).toBe('1234');
  });

  it('never writes a secret in plaintext, and reads it back with the key', async () => {
    await service.addClaude(TOKEN_A, 'Work');
    service.setProviderKey('groq', GROQ);
    const disk = everythingOnDisk(dir);
    expect(disk).not.toContain(TOKEN_A);
    expect(disk).not.toContain(GROQ);
    expect(disk).not.toContain(service.webBotAuthKey());
    expect(
      make()
        .secretsSummary()
        .claude.map((a) => a.label),
    ).toEqual(['Work']);
    expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
  });

  it('makes its own key on first start, readable only by the server, and keeps it', () => {
    const keyPath = join(dir, 'secrets.key');
    expect(Buffer.from(readFileSync(keyPath, 'utf8'), 'base64')).toHaveLength(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const first = readFileSync(keyPath, 'utf8');
    make();
    expect(readFileSync(keyPath, 'utf8')).toBe(first);
    expect(service.changedEvent().problem).toBeUndefined();
  });

  it('starts without the key that locks its secrets, says why, and sends hosts nothing', async () => {
    await service.addClaude(TOKEN_A);
    rmSync(join(dir, 'secrets.key'));
    service = make();
    expect(service.changedEvent().problem).toMatch(
      /secrets\.key is missing.*Put back the secrets\.key/,
    );
    expect(existsSync(join(dir, 'secrets.key'))).toBe(false);
    online = ['d1'];
    service.hostOnline('d1');
    service.update({ sweepEnabled: false });
    expect(sent).toEqual([]);
    await expect(service.addClaude(TOKEN_B)).rejects.toMatchObject({
      status: 503,
      code: 'secrets_unreadable',
    });
    expect(() => service.setProviderKey('groq', GROQ)).toThrow(/secrets\.key is missing/);
  });

  it('keeps the job default model apart from the new-chat default model', () => {
    expect(service.current().jobDefaultModel).toBe(DEFAULT_SHARED_SETTINGS.jobDefaultModel);
    service.update({ jobDefaultModel: 'claude-sonnet-5' });
    expect(service.current().jobDefaultModel).toBe('claude-sonnet-5');
    expect(service.current().defaultModel).toBe(DEFAULT_SHARED_SETTINGS.defaultModel);
    service.update({ defaultModel: 'claude-haiku-5' });
    expect(service.current().jobDefaultModel).toBe('claude-sonnet-5');
  });

  it('starts with the wrong key and says so', async () => {
    await service.addClaude(TOKEN_A);
    writeFileSync(join(dir, 'secrets.key'), randomBytes(32).toString('base64'));
    service = make();
    expect(service.changedEvent().problem).toMatch(
      /does not decrypt with this server's secrets\.key/,
    );
    writeFileSync(join(dir, 'secrets.key'), 'not a key');
    expect(make().changedEvent().problem).toMatch(/secrets\.key is not a key/);
  });

  it('bumps the version and pushes every change to imported hosts and every surface', () => {
    service.mergeImport('d1', { settings: {}, secrets: EMPTY_SHARED_SECRETS });
    online = ['d1', 'd2']; // d2 not imported yet — it must not be overwritten
    sent = [];
    const before = service.currentVersion();
    service.update({ chatNameInterval: 5 });
    expect(service.currentVersion()).toBe(before + 1);
    expect(snapshots().map((s) => s.hostId)).toEqual(['d1']);
    expect(snapshots('d1')[0]!.event.settings.chatNameInterval).toBe(5);
    expect(broadcasts.at(-1)!.settings.chatNameInterval).toBe(5);
  });

  it('never puts a secret value on the surface frame', async () => {
    await service.addClaude(TOKEN_A);
    service.setProviderKey('groq', GROQ);
    const surfaceText = JSON.stringify(broadcasts);
    expect(surfaceText).not.toContain(TOKEN_A);
    expect(surfaceText).not.toContain(GROQ);
  });

  it('validates a pasted Claude token and refuses a second copy of an account', async () => {
    await expect(service.addClaude('bad')).rejects.toMatchObject({ code: 'credential_rejected' });
    await expect(service.addClaude('offline')).rejects.toMatchObject({
      code: 'credential_unreachable',
    });
    await service.addClaude(TOKEN_A, 'Work');
    orgs['sk-ant-oat01-same-org'] = 'org-a';
    await expect(service.addClaude('sk-ant-oat01-same-org')).rejects.toMatchObject({
      code: 'duplicate_account',
    });
    expect(service.secretsSummary().claude).toHaveLength(1);
  });

  it('reorders only when the order names each account exactly once', async () => {
    await service.addClaude(TOKEN_A, 'A');
    await service.addClaude(TOKEN_B, 'B');
    const [a, b] = service.accountIds('claude-code');
    expect(() => service.order('claude-code', [a!])).toThrow(SettingsError);
    service.order('claude-code', [b!, a!]);
    expect(service.secretsSummary().claude.map((x) => x.label)).toEqual(['B', 'A']);
  });

  it('keeps a disconnected account as a row, and removes one on delete', async () => {
    const acct = await service.addClaude(TOKEN_A, 'A');
    service.disconnect('claude-code', acct.id);
    expect(service.secretsSummary().claude).toEqual([
      { id: acct.id, label: 'A', connected: false },
    ]);
    service.remove('claude-code', acct.id);
    expect(service.secretsSummary().claude).toEqual([]);
  });

  it('refuses a host refresh that could overwrite the server credential', async () => {
    const acct = await service.addClaude(TOKEN_A, 'A');
    service.mergeImport('d1', { settings: {}, secrets: EMPTY_SHARED_SECRETS });
    online = ['d1'];
    sent = [];
    service.handleHostEvent({
      type: 'settings.secret_update',
      hostId: 'd1',
      update: {
        backendId: 'claude-code',
        accountId: acct.id,
        credential: { accessToken: 'fresh', refreshToken: 'r' },
      },
    });
    expect(snapshots('d1')).toHaveLength(0);
    expect(service.secretsSummary().claude[0]?.connected).toBe(true);
  });

  it('records which version each host applied, and a refusal by name', () => {
    service.handleHostEvent({ type: 'settings.applied', hostId: 'd1', version: 4 });
    service.handleHostEvent({
      type: 'settings.applied',
      hostId: 'd2',
      version: 3,
      error: 'disk full',
    });
    expect(service.hostStates()).toEqual([
      { hostId: 'd1', appliedVersion: 4 },
      { hostId: 'd2', appliedVersion: 3, error: 'disk full' },
    ]);
  });

  it('drops the retired shared claudeSettings from an old settings file, and never sends it to hosts', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        sweepEnabled: false,
        claudeSettings: { shared: '{"model":"opus"}', darwin: '', linux: '' },
      }),
    );
    const reloaded = make();
    expect(reloaded.current()).not.toHaveProperty('claudeSettings');
    expect(reloaded.current().sweepEnabled).toBe(false);
    reloaded.update({ sweepEnabled: true });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty(
      'claudeSettings',
    );
    expect(() => reloaded.update({ claudeSettings: {} } as never)).toThrow();
  });

  it('adopts a provider key from a host’s environment', async () => {
    online = ['d1'];
    const svc = new SharedSettingsService({
      dataDir: dir,
      sendToHost: (hostId, event) => {
        if (event.type !== 'settings.adopt.request') return;
        queueMicrotask(() =>
          svc.handleHostEvent({
            type: 'settings.adopt.response',
            requestId: event.requestId,
            hostId,
            ok: true,
            result: { kind: 'provider-key', id: 'groq', value: GROQ },
          }),
        );
      },
      onlineHostIds: () => online,
      broadcast: () => undefined,
    });
    await svc.adoptInto('d1', 'provider-key', 'groq');
    expect(svc.secretsSummary().providerKeys.find((k) => k.id === 'groq')).toEqual({
      id: 'groq',
      set: true,
      last4: '1234',
    });
  });

  it('refuses to adopt from an offline host, and times out a silent one', async () => {
    await expect(service.adoptInto('d9', 'claude-login')).rejects.toMatchObject({
      code: 'host_offline',
    });
    online = ['d9'];
    const silent = new SharedSettingsService({
      dataDir: dir,
      sendToHost: () => undefined,
      onlineHostIds: () => online,
      broadcast: () => undefined,
      adoptTimeoutMs: 20,
    });
    await expect(silent.adoptInto('d9', 'claude-login')).rejects.toMatchObject({
      code: 'daemon_timeout',
    });
  });
});

describe('shared settings routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-settings-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(45));
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
    // No host attached at build: each test brings its host online itself.
    link.setHostId(null);
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink: link,
      validateClaudeToken: validateClaude,
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    return { built, link, auth: { authorization: `Bearer ${jwt}` }, data };
  }

  it('refuses an unauthenticated write', async () => {
    const { built } = await boot();
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/providers/keys/groq',
        payload: { value: GROQ },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('stores a provider key and answers with source and last four only', async () => {
    const { built, auth } = await boot();
    try {
      const res = await built.app.inject({
        method: 'PUT',
        url: '/api/providers/keys/groq',
        headers: auth,
        payload: { value: GROQ },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(GROQ);
      expect(res.json().secrets.providerKeys).toContainEqual({
        id: 'groq',
        set: true,
        last4: '1234',
      });
      const bad = await built.app.inject({
        method: 'PUT',
        url: '/api/providers/keys/groq',
        headers: auth,
        payload: { value: 'short' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('invalid_value');
      const unknown = await built.app.inject({
        method: 'PUT',
        url: '/api/providers/keys/anthropic',
        headers: auth,
        payload: { value: GROQ },
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('adds, reorders, disconnects and removes Claude accounts', async () => {
    const { built, auth } = await boot();
    try {
      const add = (token: string, label: string) =>
        built.app.inject({
          method: 'POST',
          url: '/api/accounts/claude-code',
          headers: auth,
          payload: { token, label },
        });
      expect((await add(TOKEN_A, 'A')).statusCode).toBe(200);
      const b = await add(TOKEN_B, 'B');
      const ids = (b.json().secrets.claude as { id: string }[]).map((a) => a.id);
      const rejected = await add('bad', 'C');
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toBe('credential_rejected');
      const order = await built.app.inject({
        method: 'PUT',
        url: '/api/accounts/claude-code/order',
        headers: auth,
        payload: { accountIds: [ids[1], ids[0]] },
      });
      expect((order.json().secrets.claude as { label: string }[]).map((a) => a.label)).toEqual([
        'B',
        'A',
      ]);
      const strategy = await built.app.inject({
        method: 'PUT',
        url: '/api/accounts/claude-code/strategy',
        headers: auth,
        payload: { strategy: 'round-robin' },
      });
      expect(strategy.json().settings.accountStrategy.claude).toBe('round-robin');
      const disc = await built.app.inject({
        method: 'POST',
        url: `/api/accounts/claude-code/${ids[0]}/disconnect`,
        headers: auth,
      });
      expect(
        disc.json().secrets.claude.find((a: { id: string }) => a.id === ids[0]).connected,
      ).toBe(false);
      const del = await built.app.inject({
        method: 'DELETE',
        url: `/api/accounts/claude-code/${ids[0]}`,
        headers: auth,
      });
      expect(del.json().secrets.claude).toHaveLength(1);
      const unknownBackend = await built.app.inject({
        method: 'GET',
        url: '/api/accounts/gemini',
        headers: auth,
      });
      expect(unknownBackend.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('PATCH /api/settings sets the job autonomy prompt and refuses empty', async () => {
    const { built, auth } = await boot();
    try {
      const res = await built.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: auth,
        payload: { jobAutonomyPrompt: 'House rule.' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().preferences.jobAutonomyPrompt).toBe('House rule.');
      const empty = await built.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: auth,
        payload: { jobAutonomyPrompt: '' },
      });
      expect(empty.statusCode).toBe(400);
      const after = await built.app.inject({ method: 'GET', url: '/api/settings', headers: auth });
      expect(after.json().preferences.jobAutonomyPrompt).toBe('House rule.');
    } finally {
      await built.app.close();
    }
  });

  it('PATCH /api/settings sets the goal judge prompt, model and refusal limit, and refuses bad values', async () => {
    const { built, auth } = await boot();
    try {
      const patch = (payload: object) =>
        built.app.inject({ method: 'PATCH', url: '/api/settings', headers: auth, payload });
      const res = await patch({
        goalEvalPrompt: 'Judge harshly.',
        goalModel: 'claude-sonnet-5',
        goalRefusalLimit: 5,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().preferences).toMatchObject({
        goalEvalPrompt: 'Judge harshly.',
        goalModel: 'claude-sonnet-5',
        goalRefusalLimit: 5,
      });
      expect((await patch({ goalEvalPrompt: '' })).statusCode).toBe(400);
      expect((await patch({ goalRefusalLimit: 0 })).statusCode).toBe(400);
      expect((await patch({ goalModel: '' })).statusCode).toBe(400);
      const after = await built.app.inject({ method: 'GET', url: '/api/settings', headers: auth });
      expect(after.json().preferences.goalRefusalLimit).toBe(5);
    } finally {
      await built.app.close();
    }
  });

  it('PATCH /api/settings writes a shared setting and sends it to an imported host', async () => {
    const { built, auth, link } = await boot();
    try {
      // The host answers its import with nothing held.
      const original = link.sendTo.bind(link);
      const seen: WireEvent[] = [];
      link.sendTo = (hostId, surfaceId, event) => {
        original(hostId, surfaceId, event);
        seen.push(event);
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
      };
      link.addOnlineHost('d1');
      await new Promise((r) => setTimeout(r, 20));
      const res = await built.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: auth,
        payload: { questionExpirySeconds: 120 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().preferences.questionExpirySeconds).toBe(120);
      const snap = seen.filter((e) => e.type === 'settings.snapshot').at(-1);
      expect(snap).toMatchObject({ settings: { questionExpirySeconds: 120 } });
      const bad = await built.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: auth,
        payload: { permissionModeDefault: 'yolo' },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});
