// A windowed list: only the rows near the visible part of the nearest scrolling
// ancestor are in the DOM, so a 2,000-row list costs what a 20-row one does.
// Rows vary in height (a status or preview line adds one), so each row's real
// height is recorded once drawn and a row not yet seen is assumed to be the
// average of those that have. Host-agnostic: it finds its own scroller, which
// is the sidebar's list band in one place and the main window in another, and
// marks itself `data-scroll-host`.

import type { JSX, ReactNode } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const ESTIMATE_PX = 40;
/** Extra px drawn above and below the viewport. */
const OVERSCAN_PX = 400;

/** The list's scroller is whichever ancestor is marked `data-scroll-host`. */
function scrollParent(el: HTMLElement): HTMLElement {
  const host = el.closest<HTMLElement>('[data-scroll-host]');
  if (!host) throw new Error('WindowedRows needs a [data-scroll-host] ancestor');
  return host;
}

export function WindowedRows<T>({
  items,
  itemKey,
  renderItem,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [range, setRange] = useState({ top: 0, bottom: 1200 });
  const [, bump] = useState(0);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = scrollParent(root);
    const rootTop =
      root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = scroller.scrollTop - rootTop - OVERSCAN_PX;
    const bottom = scroller.scrollTop + scroller.clientHeight - rootTop + OVERSCAN_PX;
    setRange((r) => (r.top === top && r.bottom === bottom ? r : { top, bottom }));
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = scrollParent(root);
    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  // Record the real height of every row drawn; re-render once if any changed
  // so the spacers match.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let changed = false;
    for (const el of root.querySelectorAll<HTMLElement>('[data-wkey]')) {
      const key = el.dataset.wkey as string;
      const h = el.offsetHeight;
      if (h > 0 && heights.current.get(key) !== h) {
        heights.current.set(key, h);
        changed = true;
      }
    }
    if (changed) bump((n) => n + 1);
  });

  let sum = 0;
  let count = 0;
  for (const h of heights.current.values()) {
    sum += h;
    count += 1;
  }
  const avg = count > 0 ? sum / count : ESTIMATE_PX;
  const heightOf = (k: string): number => heights.current.get(k) ?? avg;

  let offset = 0;
  let first = -1;
  let last = -1;
  let before = 0;
  let after = 0;
  items.forEach((item, i) => {
    const h = heightOf(itemKey(item));
    if (offset + h < range.top) before += h;
    else if (offset > range.bottom) after += h;
    else {
      if (first === -1) first = i;
      last = i;
    }
    offset += h;
  });

  const visible = first === -1 ? [] : items.slice(first, last + 1);
  return (
    <div ref={rootRef} data-testid="windowed-rows">
      <div style={{ height: before }} aria-hidden />
      {visible.map((item) => {
        const k = itemKey(item);
        return (
          <div key={k} data-wkey={k}>
            {renderItem(item)}
          </div>
        );
      })}
      <div style={{ height: after }} aria-hidden />
    </div>
  );
}
