// Composer action row layout (spec/14 § Composer — action row). The row is
// always ONE line: tools, the standing settings, and the end group (context
// ring, stop/send). Each setting is an icon and a short word; when the words
// don't all fit, the row goes COMPACT and the settings drop to their icons
// (the model keeps its short name, as it has no icon). The tooltip names
// each one either way.
//
// The words that may go are marked `data-collapsible`. In compact mode they
// are kept in the layout at zero width rather than removed, so their natural
// width is still readable (`scrollWidth`) and the row can tell when there is
// room to bring them back.

import { useLayoutEffect, useState, type RefObject } from 'react';

/** The gap a word adds beside its icon (`.setting-word` margin in index.css). */
const WORD_GAP = 5;

export function useCompactActions(rowRef: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(measure);
    function measure(): void {
      if (!row) return;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const parts = [...row.children].filter((p) => (p as HTMLElement).offsetWidth > 0);
      let need = gap * Math.max(0, parts.length - 1);
      for (const p of parts) need += (p as HTMLElement).scrollWidth;
      // Words hidden by compact mode, at the width they would take back.
      for (const w of row.querySelectorAll<HTMLElement>('[data-collapsible]')) {
        const hidden = w.scrollWidth - w.clientWidth;
        if (hidden > 0) need += hidden + WORD_GAP;
      }
      setCompact(need > row.clientWidth + 0.5);
      // A label changing (a new model, a different account) changes what fits.
      for (const p of parts) for (const k of p.children) observer.observe(k);
    }
    observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, [rowRef]);
  return compact;
}
