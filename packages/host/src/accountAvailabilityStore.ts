import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PersistedAccountExhaustion {
  accountId: string;
  until?: number;
  reason: string;
  at: number;
}

export function readAccountExhaustion(path: string): PersistedAccountExhaustion[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is PersistedAccountExhaustion => {
      if (entry === null || typeof entry !== 'object') return false;
      const value = entry as Record<string, unknown>;
      return (
        typeof value.accountId === 'string' &&
        typeof value.reason === 'string' &&
        typeof value.at === 'number' &&
        (value.until === undefined || typeof value.until === 'number')
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function writeAccountExhaustion(
  path: string,
  entries: readonly PersistedAccountExhaustion[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
