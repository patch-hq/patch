// True while a finger is down on a sideways-scrolling block (a wide table). The
// chat screen's swipe-to-next-chat claims horizontal drags in the capture phase,
// which would otherwise steal them from that block, so it checks this first.

let active = false;

export function setHorizontalScrollTouch(value: boolean): void {
  active = value;
}

export function horizontalScrollTouchActive(): boolean {
  return active;
}
