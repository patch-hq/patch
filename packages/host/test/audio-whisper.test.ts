// Speech-to-text backend pluggability (group 13).

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  createWhisper,
  LocalWhisperBackend,
  pcm16ToWav,
  validateWhisperCredentials,
  UnsupportedClipFormatError,
} from '../src/audio/whisper.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const logger = pino({ level: 'silent' });

describe('createWhisper', () => {
  test('mock backend echoes a deterministic transcript; close() is a no-op', async () => {
    const w = createWhisper({ backend: 'mock', logger });
    const out = await w.transcribe(new Int16Array(16000)); // 1 sec
    expect(out).toMatch(/\[mock-transcript 1000ms\]/);
    await expect(w.close()).resolves.toBeUndefined();
  });

  test('local backend refuses a Settings model it cannot load, loudly', async () => {
    const w = createWhisper({ backend: 'local', logger, localModelPath: '/tmp' });
    w.useModel?.('/no/such/whisper-model');
    await expect(w.transcribe(new Int16Array(160))).rejects.toThrow(/does not exist/);
  });

  test('local backend lazy-fails when neither sidecar URL nor model path is set', async () => {
    const w = createWhisper({ backend: 'local', logger });
    // With no URL the host would spawn the sidecar — but that needs a model
    // path. Absent both, transcribe() must fail loudly (NO FALLBACKS).
    await expect(w.transcribe(new Int16Array(160))).rejects.toThrow(/WHISPER_MODEL_PATH/);
  });
});

// spec/07 § End-to-end voice transport — the uploaded voice-note clip path.
describe('WhisperBackend.transcribeClip (voice-note upload)', () => {
  test('mock backend returns a deterministic per-clip transcript', async () => {
    const w = createWhisper({ backend: 'mock', logger });
    const out = await w.transcribeClip(Buffer.from('abcde'), 'm4a');
    expect(out).toBe('[mock-clip m4a 5b]');
  });

  test('local backend refuses an m4a clip with UnsupportedClipFormatError (DOCUMENTED LIMITATION)', async () => {
    const w = createWhisper({ backend: 'local', logger, localSidecarUrl: 'ws://127.0.0.1:5018' });
    await expect(w.transcribeClip(Buffer.from('x'), 'm4a')).rejects.toBeInstanceOf(
      UnsupportedClipFormatError,
    );
    await expect(w.transcribeClip(Buffer.from('x'), 'm4a')).rejects.toThrow(/PCM16 samples only/);
  });
});

// --- LocalWhisperBackend --------------------------------------------------
//
// Mirrors the RealKokoroBackend test approach in audio-kokoro.test.ts: an
// external `localSidecarUrl` (spawnsOwn=false) is driven with a fake WS
// server matching the faster-whisper wire protocol; the spawned-sidecar path
// (spawnsOwn=true) mocks `node:child_process.spawn` so the process-lifecycle
// logic can be exercised without a real `uv`/Python sidecar.

async function startWsServer(
  onConnection: (sock: WebSocket) => void,
  port = 0,
): Promise<{ port: number; close(): Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const actualPort = await new Promise<number>((resolve) => {
    wss.on('listening', () => resolve((wss.address() as AddressInfo).port));
  });
  wss.on('connection', onConnection);
  return {
    port: actualPort,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function parseJson(raw: Buffer | string): Record<string, unknown> {
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Record<
    string,
    unknown
  >;
}

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

describe('LocalWhisperBackend (external localSidecarUrl — operator-owned process)', () => {
  test('transcribe() round-trips {requestId,samples}+binary PCM -> {requestId,text}, then trims', async () => {
    let receivedSamples: unknown;
    let receivedBinaryLength = -1;
    const server = await startWsServer((sock) => {
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          receivedBinaryLength = raw.byteLength;
          return;
        }
        const msg = parseJson(raw);
        receivedSamples = msg.samples;
        sock.send(JSON.stringify({ requestId: msg.requestId, text: '  hello there  ' }));
      });
    });
    const w = createWhisper({
      backend: 'local',
      logger,
      localSidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const pcm = new Int16Array([1, -2, 3, -4]);
      const out = await w.transcribe(pcm);
      expect(out).toBe('hello there');
      expect(receivedSamples).toBe(4);
      expect(receivedBinaryLength).toBe(8);
    } finally {
      await w.close();
      await server.close();
    }
  });

  test('transcribeVoices() sends the diarise session with the WAV samples and returns voiced segments', async () => {
    let sent: Record<string, unknown> = {};
    let binaryLength = -1;
    const server = await startWsServer((sock) => {
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          binaryLength = raw.byteLength;
          return;
        }
        sent = parseJson(raw);
        sock.send(
          JSON.stringify({
            requestId: sent.requestId,
            text: 'a b',
            segments: [
              { start: 0, end: 1, text: 'a', voice: 1 },
              { start: 1, end: 2, text: 'b', voice: 2 },
            ],
          }),
        );
      });
    });
    const w = new LocalWhisperBackend({
      backend: 'local',
      logger,
      localSidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const wav = pcm16ToWav(new Int16Array([1, 2, 3, 4]), 16000);
      const out = await w.transcribeVoices('chat:1', wav);
      expect(out).toEqual([
        { text: 'a', voice: 1 },
        { text: 'b', voice: 2 },
      ]);
      expect(sent.diarise).toBe('chat:1');
      expect(sent.samples).toBe(4);
      expect(binaryLength).toBe(8);
    } finally {
      await w.close();
      await server.close();
    }
  });

  test('transcribeVoices() surfaces a sidecar error and a missing .segments', async () => {
    const server = await startWsServer((sock) => {
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        sock.send(JSON.stringify({ requestId: msg.requestId, text: 'x' }));
      });
    });
    const w = new LocalWhisperBackend({
      backend: 'local',
      logger,
      localSidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const wav = pcm16ToWav(new Int16Array([1, 2]), 16000);
      await expect(w.transcribeVoices('s', wav)).rejects.toThrow(/missing \.segments/);
      await expect(w.transcribeVoices('s', Buffer.from('nope'))).rejects.toThrow(/not a WAV/);
    } finally {
      await w.close();
      await server.close();
    }
  });

  test('transcribe() rejects when the sidecar response is missing .text', async () => {
    const server = await startWsServer((sock) => {
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        sock.send(JSON.stringify({ requestId: msg.requestId, notText: 'oops' }));
      });
    });
    const w = createWhisper({
      backend: 'local',
      logger,
      localSidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      await expect(w.transcribe(new Int16Array([1, 2]))).rejects.toThrow(/missing \.text/);
    } finally {
      await w.close();
      await server.close();
    }
  });

  test('resolvedUrl() uses the given localSidecarUrl verbatim; getClient() memoizes across calls', async () => {
    let connections = 0;
    const server = await startWsServer((sock) => {
      connections++;
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const msg = parseJson(raw);
        sock.send(JSON.stringify({ requestId: msg.requestId, text: 'ok' }));
      });
    });
    const w = createWhisper({
      backend: 'local',
      logger,
      localSidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      await w.transcribe(new Int16Array([1, 2]));
      await w.transcribe(new Int16Array([3, 4]));
      expect(connections).toBe(1);
    } finally {
      await w.close();
      await server.close();
    }
  });
});

describe('LocalWhisperBackend (spawned sidecar — host-owned process)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  test('a second transcribe() call reuses the already-spawned (not-yet-killed) process', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const server = await startWsServer(
      (sock) => {
        sock.on('message', (raw: Buffer, isBinary: boolean) => {
          if (isBinary) return;
          const msg = parseJson(raw);
          sock.send(JSON.stringify({ requestId: msg.requestId, text: 'ok' }));
        });
      },
      5018, // DEFAULT_WHISPER_PORT — resolvedUrl()'s no-localSidecarUrl branch.
    );
    const w = createWhisper({
      backend: 'local',
      logger,
      localModelPath: '/models/whisper',
      localSidecarCwd: '/opt/whisper-sidecar',
    });
    try {
      const out1 = await w.transcribe(new Int16Array([1, 2]));
      const out2 = await w.transcribe(new Int16Array([3, 4]));
      expect(out1).toBe('ok');
      expect(out2).toBe('ok');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        'uv',
        ['run', '--no-sync', 'python', '-m', 'patch_whisper_sidecar'],
        expect.objectContaining({
          env: expect.objectContaining({
            WHISPER_MODEL_PATH: '/models/whisper',
            WHISPER_SIDECAR_HOST: '127.0.0.1',
            WHISPER_SIDECAR_PORT: '5018',
          }),
          cwd: '/opt/whisper-sidecar',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } finally {
      await w.close();
      await server.close();
    }
  });

  test('proc "exit" clears the process (a later transcribe() call respawns)', async () => {
    const fakeProc1 = new FakeChildProcess();
    const fakeProc2 = new FakeChildProcess();
    vi.mocked(spawn)
      .mockReturnValueOnce(fakeProc1 as unknown as ChildProcess)
      .mockReturnValueOnce(fakeProc2 as unknown as ChildProcess);
    const log = fakeLogger();
    const w = new LocalWhisperBackend({ backend: 'local', logger: log, localModelPath: '/m' });
    try {
      // transcribe() will try to connect to the real default port with
      // nothing listening — fine, we only care about the spawn bookkeeping,
      // not the network round trip, in this test.
      void w.transcribe(new Int16Array([1])).catch(() => undefined);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      fakeProc1.emit('exit', 1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1 }),
        expect.stringMatching(/exited; will respawn/),
      );
      void w.transcribe(new Int16Array([1])).catch(() => undefined);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    } finally {
      await w.close();
    }
  });

  test('proc "error" is logged (spawn error)', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const log = fakeLogger();
    const w = new LocalWhisperBackend({ backend: 'local', logger: log, localModelPath: '/m' });
    try {
      void w.transcribe(new Int16Array([1])).catch(() => undefined);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      fakeProc.emit('error', new Error('spawn ENOENT'));
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'spawn ENOENT' }),
        expect.stringMatching(/spawn error/),
      );
    } finally {
      await w.close();
    }
  });

  test('close() kills a live spawned process, but skips an already-killed one', async () => {
    const fakeProc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc as unknown as ChildProcess);
    const w = new LocalWhisperBackend({ backend: 'local', logger, localModelPath: '/m' });
    void w.transcribe(new Int16Array([1])).catch(() => undefined);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await w.close();
    expect(fakeProc.killed).toBe(true);
    const killSpy = vi.spyOn(fakeProc, 'kill');
    await w.close(); // second close(): proc already killed, must not re-kill.
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('validateWhisperCredentials (group H1: eager startup abort)', () => {
  test('local backend with neither URL nor model path aborts at startup', () => {
    expect(() => validateWhisperCredentials({ whisperBackend: 'local' })).toThrowError(
      /WHISPER_BACKEND=local.*WHISPER_LOCAL_SIDECAR_URL.*WHISPER_MODEL_PATH/s,
    );
  });

  test('local backend with a sidecar URL passes', () => {
    expect(() =>
      validateWhisperCredentials({
        whisperBackend: 'local',
        whisperLocalSidecarUrl: 'ws://127.0.0.1:5018',
      }),
    ).not.toThrow();
  });

  test('local backend with a non-existent model path aborts (NO SILENT FALLBACK)', () => {
    expect(() =>
      validateWhisperCredentials({
        whisperBackend: 'local',
        whisperModelPath: '/no/such/whisper/model',
      }),
    ).toThrowError(/does not exist on disk/);
  });

  test('local backend with a real model dir (spawned sidecar) passes', () => {
    const model = join(__dirname, '..', '..', '..', 'models', 'whisper', 'medium.en');
    if (!existsSync(model)) return; // model only present in the build env
    expect(() =>
      validateWhisperCredentials({ whisperBackend: 'local', whisperModelPath: model }),
    ).not.toThrow();
  });

  test('mock backend needs no credential', () => {
    expect(() => validateWhisperCredentials({ whisperBackend: 'mock' })).not.toThrow();
  });
});

describe('pcm16ToWav', () => {
  test('emits a 44-byte RIFF header + correct data length', () => {
    const pcm = new Int16Array(160);
    const wav = pcm16ToWav(pcm, 16000);
    expect(wav.length).toBe(44 + 320);
    expect(wav.subarray(0, 4).toString('utf8')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('utf8')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt16LE(34)).toBe(16); // bps
  });
});

describe('transcription prompt (meeting vocabulary)', () => {
  test('local backend unwraps a wav clip and sends the prompt in the request envelope', async () => {
    const seen: Record<string, unknown>[] = [];
    let binary = 0;
    const server = await startWsServer((sock) => {
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          binary = raw.byteLength;
          return;
        }
        const msg = parseJson(raw);
        seen.push(msg);
        sock.send(JSON.stringify({ requestId: msg.requestId, text: 'ok' }));
      });
    });
    const w = createWhisper({
      backend: 'local',
      logger,
      localSidecarUrl: `ws://127.0.0.1:${server.port}`,
    });
    try {
      const wav = pcm16ToWav(new Int16Array([5, 6, 7]), 16000);
      expect(await w.transcribeClip(wav, 'wav', { prompt: 'Participants: Priya Shah.' })).toBe(
        'ok',
      );
      expect(seen[0]?.samples).toBe(3);
      expect(seen[0]?.prompt).toBe('Participants: Priya Shah.');
      expect(binary).toBe(6);
      await w.transcribeClip(wav, 'wav');
      expect(seen[1]).not.toHaveProperty('prompt');
    } finally {
      await w.close();
      await server.close();
    }
  });
});
