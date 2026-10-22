// Pure geometry for the app tooltip (spec/14 § Copy — Tooltips): "stays clear
// of the window edge, flipping to the opposite side of its control rather than
// clipping". Kept apart from TooltipHost.tsx so the clamping/flip logic can be
// tested without a DOM.

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = 'above' | 'below';

export interface TooltipPosition {
  top: number;
  left: number;
  placement: Placement;
}

const GAP = 8;
const MARGIN = 8;

/**
 * Centres the tooltip under its trigger, flipping above when there isn't
 * room below, then clamps both axes into the viewport so it never runs off
 * the edge of the window.
 */
export function computeTooltipPosition(
  trigger: Rect,
  tooltip: Size,
  viewport: Size,
): TooltipPosition {
  const fitsBelow = trigger.bottom + GAP + tooltip.height <= viewport.height - MARGIN;
  const fitsAbove = trigger.top - GAP - tooltip.height >= MARGIN;
  const placement: Placement = fitsBelow || !fitsAbove ? 'below' : 'above';

  const rawTop = placement === 'below' ? trigger.bottom + GAP : trigger.top - GAP - tooltip.height;
  const maxTop = Math.max(MARGIN, viewport.height - MARGIN - tooltip.height);
  const top = Math.min(Math.max(rawTop, MARGIN), maxTop);

  const rawLeft = trigger.left + trigger.width / 2 - tooltip.width / 2;
  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - tooltip.width);
  const left = Math.min(Math.max(rawLeft, MARGIN), maxLeft);

  return { top, left, placement };
}

/**
 * The rect a tooltip should hang from. A block control has one rect. An inline
 * element that wraps has one per line and a bounding box covering all of them;
 * use the fragment under the pointer (nearest vertically, then horizontally),
 * or the first when there is no pointer (keyboard focus).
 */
export function pickLineRect(
  rects: Rect[],
  bounding: Rect,
  pointer: { x: number; y: number } | null,
): Rect {
  if (rects.length <= 1) return rects[0] ?? bounding;
  if (!pointer) return rects[0]!;
  const dist = (r: Rect): number => {
    const dy =
      pointer.y < r.top ? r.top - pointer.y : pointer.y > r.bottom ? pointer.y - r.bottom : 0;
    const dx =
      pointer.x < r.left ? r.left - pointer.x : pointer.x > r.right ? pointer.x - r.right : 0;
    return dy * 1000 + dx;
  };
  return rects.reduce((best, r) => (dist(r) < dist(best) ? r : best));
}
