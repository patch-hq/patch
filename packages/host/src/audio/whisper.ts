// Speech-to-text backend (group 13).
//
// Pluggable per `WHISPER_BACKEND` env var:
//   - 'parakeet': NVIDIA Parakeet TDT v3 on this machine's CPU via sherpa-onnx
//              (parakeet.ts) — no network, no quota, no per-minute cost. Also
//              chosen by installing the Parakeet component.
//   - 'local': spawn faster-whisper as a long-running Python sidecar
//              (`uv run` → WS in/transcript out).
//   - 'mock' : test-stack stub that echoes a synthetic transcript per
//              utterance — keeps docker-compose.test.yml viable without
//              shipping API keys.
//
// NO FALLBACK: a backend named without what it needs ABORTS the host at
// startup (validateWhisperCredentials below, wired from index.ts), per the
// deployment contract (spec/11-deployment.md § Env, group H1).

import type { Logger } from 'pino';
import type { ChildProcess } from 'node:child_process';
import { existsSync as existsSyncFs } from 'node:fs';
import { PersistentWsClient } from './persistent-ws.js';
import { pcmFromWav } from './smartTurn.js';
import { ParakeetWhisperBackend } from './parakeet.js';

/** Subset of the host's audio config the credential check needs. */
export interface WhisperCredentialConfig {
  whisperBackend: WhisperBackendKind;
  elevenlabsApiKey?: string | undefined;
  whisperLocalSidecarUrl?: string | undefined;
  whisperModelPath?: string | undefined;
}

/**
 * Eager startup validation of the selected whisper backend's credentials
 * (spec/11-deployment.md § Env, group H1). Throws — aborting host boot —
 * when the backend is selected but its required credential/endpoint is absent.
 * The `mock` backend needs nothing. NO SILENT FALLBACK.
 */
export function validateWhisperCredentials(config: WhisperCredentialConfig): void {
  switch (config.whisperBackend) {
    // 'off' is NOT a degraded fallback — it is the absence of an optional
    // component. A host carrying only an OS has no voice weights and no
    // STT credential (the artifact deliberately ships neither), and spec/11
    // requires the host to install and run there. Voice stays unconfigured
    // until it is installed as an optional component, at which point a backend
    // is chosen explicitly and the checks below apply in full. Choosing a
    // backend and omitting its credential still aborts — that is the case the
    // NO SILENT FALLBACK rule is about.
    case 'off':
      return;
    case 'elevenlabs':
      if (!config.elevenlabsApiKey || config.elevenlabsApiKey.length === 0) {
        throw new Error(
          'WHISPER_BACKEND=elevenlabs but ELEVEN_LABS_API_KEY is missing. ' +
            'Set ELEVEN_LABS_API_KEY, or switch WHISPER_BACKEND. ' +
            'Refusing to start in a degraded mode (NO SILENT FALLBACK).',
        );
      }
      return;
    case 'local': {
      const hasUrl = !!config.whisperLocalSidecarUrl && config.whisperLocalSidecarUrl.length > 0;
      const hasModel = !!config.whisperModelPath && config.whisperModelPath.length > 0;
      // Either connect to an external sidecar (URL) OR spawn one (model path).
      if (!hasUrl && !hasModel) {
        throw new Error(
          'WHISPER_BACKEND=local but neither WHISPER_LOCAL_SIDECAR_URL nor WHISPER_MODEL_PATH is set. ' +
            'Set WHISPER_MODEL_PATH to the faster-whisper medium.en dir (the host will spawn the ' +
            'sidecar), or WHISPER_LOCAL_SIDECAR_URL to an external sidecar. ' +
            'Refusing to start in a degraded mode (NO SILENT FALLBACK).',
        );
      }
      if (!hasUrl && hasModel && !existsSyncFs(config.whisperModelPath!)) {
        throw new Error(
          `WHISPER_MODEL_PATH points at a path that does not exist on disk: ${config.whisperModelPath}. ` +
            'A missing faster-whisper model must abort at startup (NO SILENT FALLBACK).',
        );
      }
      return;
    }
    case 'mock':
      return;
  }
}

/**
 * Why a transcription is being asked for. A `final` is the user's actual words
 * and losing one loses the turn; a `partial` only paints the live overlay and
 * is expendable. The distinction exists because a shared provider quota can be
 * exhausted, and when it is, the expendable one must be what gives way.
 */
export interface TranscribeOptions {
  priority?: 'final' | 'partial';
  /** Words the speech is likely to contain (names, acronyms): the engine's initial prompt. */
  prompt?: string;
}

/** Options for a whole-clip transcription. */
export interface ClipOptions {
  /** Words the speech is likely to contain (names, acronyms): the engine's initial prompt. */
  prompt?: string;
}

/**
 * Thrown when a `partial` is skipped to keep provider quota in reserve for the
 * finals. Not a failure — the caller stops asking for partials this utterance
 * and says nothing about it.
 */
export class PartialBudgetExhaustedError extends Error {
  override readonly name = 'PartialBudgetExhaustedError';
}

/** A live transcription of one utterance, fed PCM as it is spoken. */
export interface LiveTranscriptStream {
  push(pcm: Int16Array): void;
  close(): void;
  /** Audio seconds sent, which is what the provider bills. */
  readonly audioSeconds: number;
}

export interface WhisperBackend {
  /**
   * Streaming live words for an utterance (ElevenLabs Scribe). When present the
   * voice session uses it instead of re-reading the growing prefix, which on a
   * paid provider would bill that prefix again every second.
   */
  openLiveStream?(
    onText: (text: string) => void,
    onError: (message: string) => void,
  ): LiveTranscriptStream;
  /**
   * Whether interim transcripts of an utterance still in progress are worth
   * attempting on this backend: re-reading the growing prefix is cheap enough
   * on Parakeet; a slower model on this host's CPU leaves it off. The
   * partial-side hallucination filter drops the stock phrases a model answers
   * a near-silent prefix with (`partial-filter.ts`).
   */
  readonly supportsLivePartials: boolean;
  /**
   * New audio (16 kHz samples) between two live passes, when the backend can
   * afford to look more often than the session's default second. Unmetered
   * on-host backends set it; a rationed one leaves it out.
   */
  readonly livePartialStepSamples?: number;
  /**
   * The paid model this backend bills for (spec/07 § Call cost). Absent on a
   * backend that costs nothing per request (local, mock).
   */
  readonly costModel?: string;
  /**
   * Switch the speech-to-text model (Settings → Prompts → Meetings). Empty
   * restores the model this host was configured with. Backends with one fixed
   * model omit it.
   */
  useModel?(model: string): void;
  /**
   * Synchronous-style: takes a complete utterance buffer (PCM16 mono
   * 16kHz) and returns the final transcript.
   */
  transcribe(pcm: Int16Array, opts?: TranscribeOptions): Promise<string>;
  /**
   * Transcribe a complete, already-encoded audio clip (spec/07 § End-to-end
   * voice transport — the mobile voice-note upload path). Unlike `transcribe`,
   * which takes raw PCM16 from the streaming audio WSS, this takes a compressed
   * container (m4a/wav) uploaded as one file to `POST /api/voice/note`.
   *
   * Parakeet decodes a compressed clip with ffmpeg first. The `local` faster-whisper sidecar
   * speaks PCM only and CANNOT decode m4a — it throws `UnsupportedClipFormatError`
   * rather than fake a transcript (NO FALLBACK); documented in spec/07.
   */
  transcribeClip(audio: Buffer, format: 'm4a' | 'wav', opts?: ClipOptions): Promise<string>;
  close(): Promise<void>;
}

/**
 * Thrown by a backend whose transcription engine cannot decode the uploaded
 * clip's container (spec/07 — the local faster-whisper sidecar is PCM-only and
 * can't accept m4a). Surfaced to the caller as a typed `unsupported_format`
 * error, never silently swallowed.
 */
export class UnsupportedClipFormatError extends Error {
  override readonly name = 'UnsupportedClipFormatError';
  constructor(message: string) {
    super(message);
  }
}

export type WhisperBackendKind = 'off' | 'elevenlabs' | 'local' | 'parakeet' | 'mock';

export interface CreateWhisperOptions {
  /** `elevenlabs` is built by index.ts (elevenlabs-stt.ts imports this file). */
  backend: Exclude<WhisperBackendKind, 'elevenlabs'>;
  logger: Logger;
  /** With `off`: why there is no speech-to-text, said whenever one is asked for. */
  offReason?: string;
  /**
   * faster-whisper sidecar URL (e.g. ws://localhost:5018). If omitted on the
   * `local` backend, the host spawns `patch_whisper_sidecar` itself and
   * connects on the default loopback port.
   */
  localSidecarUrl?: string;
  /** Path to the faster-whisper model dir (medium.en) — spawned-sidecar mode. */
  localModelPath?: string;
  /** Working directory for the spawned `uv run` (the whisper-sidecar pkg). */
  localSidecarCwd?: string;
  /** PARAKEET_MODEL_DIR (backend === 'parakeet'). */
  parakeetModelDir?: string;
}

/** Default loopback port the spawned faster-whisper sidecar listens on. */
const DEFAULT_WHISPER_PORT = 5018;

export function createWhisper(opts: CreateWhisperOptions): WhisperBackend {
  switch (opts.backend) {
    case 'off':
      return new UnconfiguredWhisperBackend(opts.offReason);
    case 'local':
      return new LocalWhisperBackend(opts);
    case 'parakeet':
      return new ParakeetWhisperBackend({ logger: opts.logger, modelDir: opts.parakeetModelDir });
    case 'mock':
      return new MockWhisperBackend();
  }
}

/**
 * Voice is not installed on this host. Booting is fine — voice is an
 * optional component — but ACTUALLY ASKING for a transcript must fail loudly
 * and say how to fix it, never return a plausible empty string. That is the
 * difference between an unconfigured feature and a silent fallback.
 */
class UnconfiguredWhisperBackend implements WhisperBackend {
  /** Nothing is configured, so there is nothing to ask for a partial either. */
  readonly supportsLivePartials = false;
  constructor(private readonly reason?: string) {}
  private refuse(): never {
    throw new Error(
      (this.reason ??
        'Speech-to-text is not configured on this host. Voice is an optional component: ' +
          'install Parakeet from Settings → Hosts.') +
        ' Refusing to return a fabricated transcript.',
    );
  }
  async transcribe(): Promise<string> {
    this.refuse();
  }
  async transcribeClip(): Promise<string> {
    this.refuse();
  }
  async close(): Promise<void> {}
}

class MockWhisperBackend implements WhisperBackend {
  /**
   * The mock returns a synthetic string keyed on the clip's duration, so a
   * partial would just paint a changing `[mock-transcript 1500ms]` over the
   * test stack's composer. Off.
   */
  readonly supportsLivePartials = false;
  async transcribe(pcm: Int16Array): Promise<string> {
    // Deterministic: encode the duration so tests can match on it.
    const ms = Math.round((pcm.length / 16000) * 1000);
    return `[mock-transcript ${ms}ms]`;
  }
  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    // Deterministic: encode the byte length + format so the test stack
    // (docker-compose.test.yml) can exercise the upload path without a real key.
    return `[mock-clip ${format} ${audio.byteLength}b]`;
  }
  async close(): Promise<void> {}
}

/**
 * faster-whisper Python sidecar. The sidecar is launched once at host
 * start by `kokoro.ts` / external supervisor (not this module's job). We
 * connect to its WS, send PCM, await JSON `{text}` response.
 *
 * For the v1 cut we lean on a simple request/response over WS — proper
 * partial streaming is a tightening pass once the sidecar is bedded in.
 */
export class LocalWhisperBackend implements WhisperBackend {
  /**
   * The sidecar answers one request at a time and runs the model on this
   * host, so re-transcribing the growing prefix costs more as the utterance
   * lengthens. The session keeps ONE partial pass in flight and spaces them by
   * a second of new audio, so the final queues behind at most one pass. That
   * bound is what makes the live text affordable here; without it dictation on
   * a Mac host showed nothing at all while the user spoke (spec/07 § Live
   * transcript).
   */
  readonly supportsLivePartials = true;
  private readonly opts: CreateWhisperOptions;
  private readonly port = DEFAULT_WHISPER_PORT;
  private readonly spawnsOwn: boolean;
  private client?: PersistentWsClient;
  private proc?: ChildProcess;
  /** Model dir chosen in Settings; empty is `opts.localModelPath`. */
  private modelPath = '';
  useModel(model: string): void {
    if (model === this.modelPath) return;
    this.modelPath = model;
    // The sidecar loads its model once, at spawn: drop it so the next request starts one on the new model.
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
    this.proc = undefined;
  }
  constructor(opts: CreateWhisperOptions) {
    this.opts = opts;
    this.spawnsOwn = !opts.localSidecarUrl || opts.localSidecarUrl.length === 0;
  }
  private resolvedUrl(): string {
    return this.opts.localSidecarUrl && this.opts.localSidecarUrl.length > 0
      ? this.opts.localSidecarUrl
      : `ws://127.0.0.1:${this.port}`;
  }
  private async ensureProcess(): Promise<void> {
    if (!this.spawnsOwn) {
      if (this.modelPath !== '')
        throw new Error(
          'A transcription model is set in Settings, but this host uses an external whisper sidecar that cannot switch models',
        );
      return;
    }
    if (this.proc && !this.proc.killed) return;
    const modelPath = this.modelPath !== '' ? this.modelPath : this.opts.localModelPath;
    if (!modelPath) {
      throw new Error(
        'WHISPER_BACKEND=local with no URL requires WHISPER_MODEL_PATH to spawn the sidecar (NO FALLBACKS).',
      );
    }
    if (this.modelPath !== '' && !existsSyncFs(modelPath)) {
      throw new Error(`Transcription model directory does not exist: ${modelPath}`);
    }
    const { spawn } = await import('node:child_process');
    // `--no-sync`: use the image-baked venv as-is (see kokoro.ts) — plain
    // `uv run` re-syncs to the CUDA-torch lockfile and bloats the disk.
    const proc = spawn('uv', ['run', '--no-sync', 'python', '-m', 'patch_whisper_sidecar'], {
      env: {
        ...process.env,
        WHISPER_MODEL_PATH: modelPath,
        WHISPER_SIDECAR_HOST: '127.0.0.1',
        WHISPER_SIDECAR_PORT: String(this.port),
      },
      ...(this.opts.localSidecarCwd !== undefined ? { cwd: this.opts.localSidecarCwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('exit', (code) => {
      this.opts.logger.warn(
        { code },
        'faster-whisper sidecar exited; will respawn on next request',
      );
      this.proc = undefined;
    });
    proc.on('error', (err) => {
      this.opts.logger.error({ err: err.message }, 'faster-whisper sidecar spawn error');
    });
    this.proc = proc;
  }
  private getClient(): PersistentWsClient {
    if (this.client) return this.client;
    this.client = new PersistentWsClient({ url: this.resolvedUrl(), logger: this.opts.logger });
    return this.client;
  }
  async transcribe(pcm: Int16Array, opts?: TranscribeOptions): Promise<string> {
    await this.ensureProcess();
    const client = this.getClient();
    // Persistent WS protocol: text envelope `{requestId,samples}` then a
    // binary PCM frame; sidecar replies with a JSON `{requestId,text}`.
    const requestId = `w-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = JSON.stringify({
      requestId,
      samples: pcm.length,
      ...(opts?.prompt ? { prompt: opts.prompt } : {}),
    });
    const binary = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const result = await client.request({
      payload,
      binaryPayload: binary,
      handlers: {
        onJson(msg: unknown) {
          const m = msg as { text?: unknown; requestId?: unknown };
          if (typeof m.text !== 'string') {
            throw new Error('faster-whisper sidecar: missing .text');
          }
          return { done: true, value: m.text };
        },
      },
    });
    return (result as string).trim();
  }
  /**
   * Transcribes a 16 kHz mono PCM16 WAV and labels each stretch with the
   * distinct voice that spoke it. `session` keys the sidecar's per-meeting
   * voice memory, so numbers stay stable across clips. The sidecar answers with
   * an error when DIARISE_MODEL_PATH is missing; nothing falls back to one voice.
   */
  async transcribeVoices(
    session: string,
    wav: Buffer,
    prompt?: string,
  ): Promise<{ text: string; voice: number }[]> {
    await this.ensureProcess();
    const pcm = pcmFromWav(wav);
    const requestId = `w-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = JSON.stringify({
      requestId,
      samples: pcm.length,
      diarise: session,
      ...(prompt ? { prompt } : {}),
    });
    const result = await this.getClient().request({
      payload,
      binaryPayload: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      handlers: {
        onJson(msg: unknown) {
          const m = msg as { segments?: unknown };
          if (!Array.isArray(m.segments)) {
            throw new Error('faster-whisper sidecar: missing .segments');
          }
          return {
            done: true,
            value: (m.segments as { text: string; voice: number }[]).map((g) => ({
              text: g.text,
              voice: g.voice,
            })),
          };
        },
      },
    });
    return result as { text: string; voice: number }[];
  }
  /**
   * Saves the owner's voice print from a 16 kHz mono WAV of them speaking
   * (5s+). Afterwards `transcribeVoices` reports their stretches as voice 0.
   */
  async enrolVoice(wav: Buffer): Promise<void> {
    await this.ensureProcess();
    const pcm = pcmFromWav(wav);
    const requestId = `w-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = JSON.stringify({ requestId, samples: pcm.length, enrol: true });
    await this.getClient().request({
      payload,
      binaryPayload: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      handlers: {
        onJson(msg: unknown) {
          if ((msg as { enrolled?: unknown }).enrolled !== true) {
            throw new Error('faster-whisper sidecar: enrolment not confirmed');
          }
          return { done: true, value: true };
        },
      },
    });
  }
  /**
   * A WAV clip (PCM16 mono 16 kHz, what meeting capture sends) is unwrapped to
   * its samples and goes down the same path as streamed audio.
   *
   * DOCUMENTED LIMITATION (spec/07 § End-to-end voice transport): the
   * faster-whisper sidecar takes raw PCM16 only and the host bundles no
   * AAC/m4a decoder, so an m4a upload is refused with a typed error rather
   * than faked or dropped. The mobile voice-note upload path therefore
   * needs Parakeet, which decodes it with ffmpeg. NO FALLBACK.
   */
  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav', opts?: ClipOptions): Promise<string> {
    if (format === 'wav') {
      return this.transcribe(pcmFromWav(audio), opts?.prompt ? { prompt: opts.prompt } : undefined);
    }
    throw new UnsupportedClipFormatError(
      `WHISPER_BACKEND=local (faster-whisper) cannot transcribe an uploaded ${format} clip: ` +
        'the sidecar accepts PCM16 samples only and the host bundles no AAC/m4a decoder. ' +
        'Use Parakeet (WHISPER_BACKEND=parakeet) for the mobile voice-note upload path.',
    );
  }
  async close(): Promise<void> {
    if (this.client) await this.client.close();
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
  }
}

// --- WAV encoder -----------------------------------------------------------

export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLen = pcm.length * 2;
  // Header is fixed 44 bytes; build it then concat with a zero-copy
  // Buffer view over the PCM bytes (LE host + LE wire — see server.ts).
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels = mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([header, body], 44 + dataLen);
}
