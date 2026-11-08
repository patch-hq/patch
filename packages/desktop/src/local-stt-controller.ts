// The main-process side of "Parakeet on this computer" dictation: one dictation
// at a time, fed PCM by the renderer that started it, answering with live words
// and a final. The IPC wiring is in main.ts; this holds the state so it can be
// tested without Electron.

import {
  LocalDictation,
  type AccurateEngine,
  type LiveEngine,
  type LocalDictationEvent,
} from './local-stt';
import {
  downloadLocalSttModels,
  localSttMissingMessage,
  localSttStatus,
  type DownloadProgress,
  type LocalSttStatus,
} from './local-stt-models';

export interface LocalSttControllerDeps {
  modelsDir: string;
  /** The engines, built from the models folder. Called when a dictation starts. */
  engines: () => { live: LiveEngine; accurate: AccurateEngine };
  download?: typeof downloadLocalSttModels;
}

export class LocalSttController {
  private current: LocalDictation | null = null;
  private downloading: Promise<void> | null = null;

  constructor(private readonly deps: LocalSttControllerDeps) {}

  status(): LocalSttStatus {
    return localSttStatus(this.deps.modelsDir);
  }

  /** Download what is missing. A second call while one runs joins it. */
  download(onProgress: (p: DownloadProgress) => void): Promise<void> {
    this.downloading ??= (this.deps.download ?? downloadLocalSttModels)(
      this.deps.modelsDir,
      onProgress,
    ).finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }

  /** Begin a dictation; replaces one a reloaded renderer left running. */
  start(emit: (ev: LocalDictationEvent) => void): void {
    const status = this.status();
    if (!status.installed) throw new Error(localSttMissingMessage(status));
    this.current?.cancel();
    const { live, accurate } = this.deps.engines();
    this.current = new LocalDictation(live, accurate, emit);
  }

  push(pcm: Int16Array): void {
    this.current?.push(pcm);
  }

  async finish(): Promise<string> {
    const d = this.current;
    if (!d) throw new Error('no local dictation is running');
    try {
      return await d.finish();
    } finally {
      d.cancel();
      if (this.current === d) this.current = null;
    }
  }

  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }
}
