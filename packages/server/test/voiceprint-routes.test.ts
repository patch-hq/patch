// Voiceprints for enrolment (spec/16 § Who is speaking).
//
// The server's half is a gate and a relay: authenticate, find the Manager's
// home host, round-trip one `patch.voiceprint.request` to it, and turn the
// answer (or its silence) into an HTTP status. The host half is tested in
// packages/host/test/voiceprints.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Req = Extract<WireEvent, { type: 'patch.voiceprint.request' }>;
type Res = Extract<WireEvent, { type: 'patch.voiceprint.response' }>;

class FakeHost extends InProcessHostLink {
  readonly asked: Array<{ hostId: string; event: Req }> = [];
  constructor(private readonly respond: (e: Req) => Omit<Res, 'type' | 'requestId' | 'hostId'>) {
    super();
  }
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (event.type !== 'patch.voiceprint.request') return;
    this.asked.push({ hostId, event });
    this.emit(
      {
        type: 'patch.voiceprint.response',
        requestId: event.requestId,
        hostId,
        ...this.respond(event),
      },
      hostId,
    );
  }
}

const vp = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));

describe('voiceprint routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voiceprint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(link: InProcessHostLink) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(44));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const built = await buildAll({ logger: false, registry, hostLink: link });
    return { built, auth: { authorization: `Bearer ${jwt}` } };
  }

  it("asks the Manager's home host for a sample's voiceprint", async () => {
    const link = new FakeHost(() => ({ ok: true, voiceprint: vp, seconds: 6 }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/voiceprint',
        headers: auth,
        payload: { pcm: 'AAAA' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ voiceprint: vp, seconds: 6 });
      expect(link.asked).toHaveLength(1);
      expect(link.asked[0]).toMatchObject({ hostId: 'd1', event: { op: 'embed', pcm: 'AAAA' } });
    } finally {
      await built.app.close();
    }
  });

  it('lists the voices heard lately', async () => {
    const recent = [{ id: 'v1', at: 1, text: 'hello', seconds: 2, voiceprint: vp, score: 0.1 }];
    const link = new FakeHost(() => ({ ok: true, recent }));
    const { built, auth } = await boot(link);
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/voice/recent-voices',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ recent });
    } finally {
      await built.app.close();
    }
  });

  it("keeps the host's refusal: too short is a 400, no speaker model a 503", async () => {
    let code: 'too_short' | 'voice_component_missing' = 'too_short';
    const link = new FakeHost(() => ({ ok: false, error: { code, message: 'nope' } }));
    const { built, auth } = await boot(link);
    try {
      const short = await built.app.inject({
        method: 'POST',
        url: '/api/voice/voiceprint',
        headers: auth,
        payload: { pcm: 'AAAA' },
      });
      expect(short.statusCode).toBe(400);
      code = 'voice_component_missing';
      const missing = await built.app.inject({
        method: 'POST',
        url: '/api/voice/voiceprint',
        headers: auth,
        payload: { pcm: 'AAAA' },
      });
      expect(missing.statusCode).toBe(503);
      expect(missing.json()).toMatchObject({ error: 'voice_component_missing' });
    } finally {
      await built.app.close();
    }
  });

  it('refuses without a credential, and a body with no audio', async () => {
    const link = new FakeHost(() => ({ ok: true, voiceprint: vp }));
    const { built, auth } = await boot(link);
    try {
      const anon = await built.app.inject({ method: 'GET', url: '/api/voice/recent-voices' });
      expect(anon.statusCode).toBe(401);
      const empty = await built.app.inject({
        method: 'POST',
        url: '/api/voice/voiceprint',
        headers: auth,
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      expect(link.asked).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });
});
