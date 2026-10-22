// Who was lit up as the active speaker on the call, over time. The desktop shell
// reports each change; a system-audio clip asks who held the floor for most of
// the stretch it covers, and is stamped with that name.

export class SpeakerLog {
  private changes: { at: number; speaking: string[] }[] = [];

  /** Record who is lit up from `at` on. */
  record(speaking: readonly string[], at: number): void {
    this.changes.push({ at, speaking: [...speaking] });
    // A clip never looks back further than a few minutes.
    const cutoff = at - 10 * 60_000;
    while (this.changes.length > 1 && (this.changes[1] as { at: number }).at < cutoff) {
      this.changes.shift();
    }
  }

  /**
   * The name lit up for the longest part of [from, to], or undefined when nobody
   * was (or nothing was ever reported). Time with several lit is shared equally.
   */
  dominant(from: number, to: number): string | undefined {
    const time = new Map<string, number>();
    for (let i = 0; i < this.changes.length; i++) {
      const c = this.changes[i] as { at: number; speaking: string[] };
      const next = this.changes[i + 1]?.at ?? to;
      const lo = Math.max(c.at, from);
      const hi = Math.min(next, to);
      if (hi <= lo || c.speaking.length === 0) continue;
      for (const name of c.speaking) {
        time.set(name, (time.get(name) ?? 0) + (hi - lo) / c.speaking.length);
      }
    }
    let best: string | undefined;
    let bestTime = 0;
    for (const [name, t] of time) {
      if (t > bestTime) {
        best = name;
        bestTime = t;
      }
    }
    return best;
  }

  clear(): void {
    this.changes = [];
  }
}
