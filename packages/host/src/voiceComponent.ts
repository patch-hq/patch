// The voice component: onnxruntime, sherpa-onnx and the VAD / Smart Turn models.
//
// ~120 MB the host does not need to chat, so the artifact no longer carries it.
// It is an optional component (components.ts) fetched on first use into
// `<patchHome>/components/voice/`, laid out exactly as the artifact used to be:
//
//   native/onnxruntime-node/      the onnxruntime addon, imported by path
//   node_modules/sherpa-onnx-node + sherpa-onnx-<os>-<arch>
//   silero_vad.onnx, smart_turn.onnx
//
// NO FALLBACK: an installed host without the component says so, by name, to
// whoever asked for voice. Nothing substitutes a mock or skips detection. A
// source checkout is a different program (it has the workspace dependencies
// and names its models through env), and answers for itself.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VOICE_COMPONENT_ID = 'voice';
/** The file whose presence marks the component installed. */
export const VOICE_SENTINEL = 'silero_vad.onnx';

export class VoiceComponentMissingError extends Error {
  readonly code = 'voice_component_missing' as const;
  constructor(detail?: string) {
    super(
      `The voice component is not installed on this host${detail ? ` (${detail})` : ''}. ` +
        'Install it in Settings → Hosts → Components.',
    );
    this.name = 'VoiceComponentMissingError';
  }
}

export function voiceComponentDir(patchHome: string): string {
  return join(patchHome, 'components', VOICE_COMPONENT_ID);
}

/**
 * Installed = the install verdict says so AND the payload is on disk. Read from
 * disk every time, so installing or removing takes effect without a restart.
 */
export function voiceComponentInstalled(dir: string): boolean {
  const record = join(dir, 'install-state.json');
  if (!existsSync(record) || !existsSync(join(dir, VOICE_SENTINEL))) return false;
  try {
    return (JSON.parse(readFileSync(record, 'utf8')) as { state?: unknown }).state === 'installed';
  } catch {
    return false;
  }
}

export interface VoiceLocations {
  /** Directory holding `onnxruntime-node/`; undefined ⇒ resolve the workspace dependency by name. */
  nativeDir: string | undefined;
  /** Entry file of sherpa-onnx-node; undefined ⇒ resolve it by name. */
  sherpaEntry: string | undefined;
  /** Models from the component; undefined in a source checkout, which names them via env. */
  vadModel: string | undefined;
  turnModel: string | undefined;
}

/**
 * Where voice's native pieces are. `artifact` is whether this process runs from
 * a built artifact (installPaths.bundledBuildInfo). From one, the component is
 * the only source and its absence throws `VoiceComponentMissingError`.
 */
export function voiceLocations(dir: string, artifact: boolean): VoiceLocations {
  if (!artifact) {
    return {
      nativeDir: undefined,
      sherpaEntry: undefined,
      vadModel: undefined,
      turnModel: undefined,
    };
  }
  if (!voiceComponentInstalled(dir)) throw new VoiceComponentMissingError();
  const nativeDir = join(dir, 'native');
  const sherpaEntry = join(dir, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js');
  const need = [
    join(nativeDir, 'onnxruntime-node', 'package.json'),
    sherpaEntry,
    join(dir, 'smart_turn.onnx'),
  ];
  const missing = need.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    throw new VoiceComponentMissingError(`incomplete: ${missing.join(', ')} not found`);
  }
  return {
    nativeDir,
    sherpaEntry,
    vadModel: join(dir, VOICE_SENTINEL),
    turnModel: join(dir, 'smart_turn.onnx'),
  };
}

/** Import onnxruntime-node from the component's `native/` dir, or by name from a checkout. */
export function ortModuleSpecifier(nativeDir: string | undefined): string {
  return nativeDir
    ? pathToFileURL(join(nativeDir, 'onnxruntime-node', 'dist', 'index.js')).href
    : 'onnxruntime-node';
}
