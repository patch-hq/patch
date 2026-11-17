// The desktop app's master notifications switch (Settings → Notifications and
// the tray menu). Per device, remembered in a small file in userData. While it
// is off the main process raises no native toast at all; the in-app bell is
// the renderer's and is unaffected.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export class NotificationsMaster {
  private off: boolean;
  private readonly listeners = new Set<(off: boolean) => void>();

  /** NO FALLBACK: an unreadable file throws rather than quietly turning notifications back on. */
  constructor(private readonly file: string) {
    this.off = false;
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { off?: unknown }).off !== 'boolean'
      ) {
        throw new Error(`${file}: expected {"off": boolean}`);
      }
      this.off = (parsed as { off: boolean }).off;
    }
  }

  isOff(): boolean {
    return this.off;
  }

  set(off: boolean): void {
    if (off === this.off) return;
    writeFileSync(this.file, JSON.stringify({ off }));
    this.off = off;
    for (const l of this.listeners) l(off);
  }

  onChange(cb: (off: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
