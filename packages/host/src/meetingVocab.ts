// Name fixes made by the meeting clean-up pass, shown so a mis-heard name can
// be seen being repaired. Nothing here is fed back into transcription: a prompt
// built from earlier text gets parroted back by Whisper over unclear audio.

const stripPunct = (w: string): string => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

/**
 * The spans a clean-up pass changed in one line, as {from, to}: words are aligned
 * (longest common run) and each stretch that differs becomes one fix. Very long
 * spans are a rewrite, not a name, and are skipped.
 */
export function nameFixes(before: string, after: string): { from: string; to: string }[] {
  if (before === after) return [];
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const same = (x: string, y: string): boolean => x === y;
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = same(a[i]!, b[j]!)
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { from: string; to: string }[] = [];
  let i = 0;
  let j = 0;
  let from: string[] = [];
  let to: string[] = [];
  const flush = (): void => {
    const f = stripPunct(from.join(' ')).trim();
    const t = stripPunct(to.join(' ')).trim();
    if (f !== '' && t !== '' && f !== t && from.length <= 4 && to.length <= 4)
      out.push({ from: f, to: t });
    from = [];
    to = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i]!, b[j]!)) {
      flush();
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      from.push(a[i++]!);
    } else {
      to.push(b[j++]!);
    }
  }
  flush();
  return out;
}
