// The voice component (voiceComponent.ts + components.ts): optional, fetched
// on first use, verified, and absent-by-default on an installed host.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ComponentManager, COMPONENT_SPECS } from '../src/components.js';
import {
  VoiceComponentMissingError,
  ortModuleSpecifier,
  voiceComponentInstalled,
  voiceLocations,
} from '../src/voiceComponent.js';

const logger = pino({ level: 'silent' });
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'voice-component-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** The component laid out as the build produces it. */
function layOut(dir: string, opts: { record?: boolean; omit?: string[] } = {}): void {
  const files: Record<string, string> = {
    'silero_vad.onnx': 'vad',
    'smart_turn.onnx': 'turn',
    'native/onnxruntime-node/package.json': '{}',
    'node_modules/sherpa-onnx-node/sherpa-onnx.js': '',
  };
  for (const [name, body] of Object.entries(files)) {
    if (opts.omit?.includes(name)) continue;
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (opts.record !== false) {
    writeFileSync(join(dir, 'install-state.json'), JSON.stringify({ state: 'installed' }));
  }
}

describe('voiceLocations', () => {
  it('an installed host without the component throws, naming it — no fallback', () => {
    const dir = join(tmp, 'components', 'voice');
    expect(() => voiceLocations(dir, true)).toThrow(VoiceComponentMissingError);
    expect(() => voiceLocations(dir, true)).toThrow(/voice component is not installed/);
  });

  it('payload with no verified install record does not count as installed', () => {
    const dir = join(tmp, 'voice');
    layOut(dir, { record: false });
    expect(voiceComponentInstalled(dir)).toBe(false);
    expect(() => voiceLocations(dir, true)).toThrow(VoiceComponentMissingError);
  });

  it('an incomplete component names what is missing', () => {
    const dir = join(tmp, 'voice');
    layOut(dir, { omit: ['smart_turn.onnx'] });
    expect(() => voiceLocations(dir, true)).toThrow(/smart_turn\.onnx/);
  });

  it('an installed component resolves every path from its own directory', () => {
    const dir = join(tmp, 'voice');
    layOut(dir);
    expect(voiceLocations(dir, true)).toEqual({
      nativeDir: join(dir, 'native'),
      sherpaEntry: join(dir, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'),
      vadModel: join(dir, 'silero_vad.onnx'),
      turnModel: join(dir, 'smart_turn.onnx'),
    });
  });

  it('a source checkout names nothing: it uses its workspace dependencies', () => {
    const loc = voiceLocations(join(tmp, 'none'), false);
    expect(loc.nativeDir).toBeUndefined();
    expect(ortModuleSpecifier(loc.nativeDir)).toBe('onnxruntime-node');
  });
});

describe('the host no longer ships voice', () => {
  const buildHost = readFileSync(
    join(__dirname, '..', '..', '..', 'scripts', 'build-host.mjs'),
    'utf8',
  );
  it('the host artifact is built without onnxruntime, sherpa or the models; voice is its own tarball', () => {
    const buildTarget = buildHost.slice(buildHost.indexOf('async function buildTarget'));
    const hostPart = buildTarget.slice(0, buildTarget.indexOf('buildVoice(t, ctx)'));
    expect(hostPart).not.toContain('copyNativeAddons');
    expect(hostPart).not.toContain('copySherpaOnnx');
    expect(hostPart).not.toContain('silero_vad.onnx');
    expect(buildHost).toContain('patch-voice-${info.version}-${t.target}');
  });
});

describe('ComponentManager: the voice component', () => {
  const spec = COMPONENT_SPECS.find((s) => s.id === 'voice');

  it('is offered, from the host release rather than huggingface', () => {
    expect(spec?.source).toBe('host-release');
  });

  /** A release server: manifest + a real signed tarball laid out like the build's. */
  function release(opts: { tamper?: 'digest' | 'signature' | 'no-voice' } = {}) {
    const name = 'patch-voice-1.0.0-linux-x64';
    const staging = join(tmp, 'staging');
    layOut(join(staging, name), { record: false });
    const tar = join(tmp, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', tar, '-C', staging, name]);
    const bytes = readFileSync(tar);
    const sha = createHash('sha256').update(bytes).digest();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const other = generateKeyPairSync('ed25519').privateKey;
    const sig = sign(null, sha, opts.tamper === 'signature' ? other : privateKey);
    const manifest = {
      version: '1.0.0',
      gitSha: 'abc',
      builtAt: 'now',
      signingPublicKey: raw.toString('base64url'),
      artifacts: [
        {
          target: 'linux-x64',
          file: 'patch-host-1.0.0-linux-x64.tar.gz',
          bytes: 1,
          sha256: 'x',
          sig: 'x',
          ...(opts.tamper === 'no-voice'
            ? {}
            : {
                voice: {
                  file: `${name}.tar.gz`,
                  bytes: bytes.length,
                  sha256: opts.tamper === 'digest' ? '0'.repeat(64) : sha.toString('hex'),
                  sig: sig.toString('base64url'),
                },
              }),
        },
      ],
    };
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/api/host/host-latest.json')) return new Response(JSON.stringify(manifest));
      if (url.endsWith(`/api/host/${name}.tar.gz`)) return new Response(bytes);
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl };
  }

  function manager(over: Partial<ConstructorParameters<typeof ComponentManager>[0]>) {
    const events: WireEvent[] = [];
    const m = new ComponentManager({
      root: join(tmp, 'components'),
      hostId: 'h',
      serverUrl: 'http://server',
      target: 'linux-x64',
      emit: (e) => events.push(e),
      logger,
      onSettled: () => {},
      ...over,
    });
    return { m, events };
  }
  const state = (m: ComponentManager) => m.describe().find((c) => c.id === 'voice');
  const wait = async (m: ComponentManager): Promise<void> => {
    for (let i = 0; i < 100 && state(m)?.state === 'downloading'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('downloads, verifies digest and signature, unpacks, and reads as installed', async () => {
    const { m } = manager({ fetchImpl: release().fetchImpl });
    expect(state(m)?.state).toBe('not-installed');
    m.install('voice');
    await wait(m);
    expect(state(m)?.state).toBe('installed');
    const dir = join(tmp, 'components', 'voice');
    expect(existsSync(join(dir, 'silero_vad.onnx'))).toBe(true);
    expect(voiceLocations(dir, true).vadModel).toBe(join(dir, 'silero_vad.onnx'));
  });

  it.each([
    ['digest', /digest mismatch/],
    ['signature', /signature does not verify/],
    ['no-voice', /no voice component for linux-x64/],
  ] as const)('refuses a %s failure and leaves nothing installed', async (tamper, message) => {
    const { m } = manager({ fetchImpl: release({ tamper }).fetchImpl });
    m.install('voice');
    await wait(m);
    const s = state(m);
    expect(s?.state).toBe('failed');
    expect(s?.error).toMatch(message);
    expect(voiceComponentInstalled(join(tmp, 'components', 'voice'))).toBe(false);
  });

  it('a host that is not running from a release says so instead of downloading', async () => {
    const { m } = manager({ target: undefined, fetchImpl: release().fetchImpl });
    m.install('voice');
    await wait(m);
    expect(state(m)?.error).toMatch(/not running from one/);
  });
});
