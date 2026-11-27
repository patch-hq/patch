// Each surface's last speech-engine report (spec/05 § Speech engines): what it
// can run for a direct call, so Settings can show every linked device's engines,
// an offline one's included. Persisted to `<dataDir>/speech-engines.json` (atomic
// write). It is re-derivable — every surface reports again when it connects — so
// a corrupt file is logged loudly and read as empty, never thrown.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { SpeechEngineReport } from '@patch/wire/direct-call';

const StoredReports = z.record(
  z.string().min(1),
  SpeechEngineReport.extend({ reportedAt: z.number() }),
);
export type StoredSpeechEngines = z.infer<typeof StoredReports>[string];

export class SpeechEngineStore {
  private readonly path: string | null;
  private reports: Record<string, StoredSpeechEngines>;

  constructor(
    private readonly opts: {
      dataDir?: string;
      logger?: Pick<Logger, 'warn'>;
      nowMs?: () => number;
    },
  ) {
    this.path = opts.dataDir ? join(opts.dataDir, 'speech-engines.json') : null;
    this.reports = this.load();
  }

  private load(): Record<string, StoredSpeechEngines> {
    if (!this.path || !existsSync(this.path)) return {};
    try {
      return StoredReports.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (err) {
      this.opts.logger?.warn(
        { path: this.path, err: (err as Error).message },
        'speech-engines: unreadable file; starting empty',
      );
      return {};
    }
  }

  get(surfaceId: string): StoredSpeechEngines | undefined {
    return this.reports[surfaceId];
  }

  set(surfaceId: string, report: SpeechEngineReport): void {
    this.reports = {
      ...this.reports,
      [surfaceId]: {
        stt: report.stt,
        tts: report.tts,
        reportedAt: (this.opts.nowMs ?? Date.now)(),
      },
    };
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.reports, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
