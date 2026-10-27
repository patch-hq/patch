// Composer action row layout (spec/14 § Composer — action row). The row holds
// three parts: tools, the standing settings, and the end group (context ring,
// stop/send). When all three fit on one line they share it; when they do not,
// the row is STACKED — tools and the end group keep the first line and the
// settings take a full-width line of their own under them, wrapping further
// only if even that line is too narrow. Nothing is ever clipped to an
// ellipsis to make it fit.
//
// CSS alone can't express "move this group to its own line only when the
// whole row overflows" without also pushing stop/send off the first line, so
// the decision is measured: the natural width of every part, against the
// row's own width.

import { useLayoutEffect, useState, type RefObject } from 'react';

function naturalWidth(part: HTMLElement, gap: number): number {
  // A part that wraps (the settings) is as wide as its row when stacked, so
  // read the sum of its children instead of the part itself.
  const kids = [...part.children].filter((k) => (k as HTMLElement).offsetWidth > 0);
  if (kids.length === 0) return part.offsetWidth;
  const sum = kids.reduce((n, k) => n + (k as HTMLElement).offsetWidth, 0);
  return sum + gap * (kids.length - 1);
}

export function useStackedActions(rowRef: RefObject<HTMLElement | null>): boolean {
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(measure);
    function measure(): void {
      if (!row) return;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const parts = [...row.children].filter((p) => (p as HTMLElement).offsetWidth > 0);
      const need =
        parts.reduce((n, p) => n + naturalWidth(p as HTMLElement, gap), 0) +
        gap * Math.max(0, parts.length - 1);
      setStacked(need > row.clientWidth + 0.5);
      // A label changing (a new model, pending → confirmed) changes what fits.
      for (const p of parts) for (const k of p.children) observer.observe(k);
    }
    observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, [rowRef]);
  return stacked;
}
