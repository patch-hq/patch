// Pure helpers for the agent-browser live view and hand-off panel, shared by
// the component and its tests.

import type { BrowserHandoffInput } from '@patch/wire';

/**
 * Map a point on the displayed picture to viewport pixels of the page it shows.
 * The frame is drawn `object-fit: contain` at the top left of its box, so the
 * picture can be smaller than the box: scale by the picture, not the box.
 */
export function toViewport(
  point: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  const x = (point.clientX - rect.left) / scale;
  const y = (point.clientY - rect.top) / scale;
  return {
    x: Math.min(viewport.width - 1, Math.max(0, Math.round(x))),
    y: Math.min(viewport.height - 1, Math.max(0, Math.round(y))),
  };
}

const NAMED_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * A key press that must be sent as a key rather than as text, or null when the
 * character will arrive through the text input's own `input` event instead.
 */
export function keyForEvent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const chord = (name: string): string =>
    [
      e.ctrlKey && 'Control',
      e.metaKey && 'Meta',
      e.altKey && 'Alt',
      e.shiftKey && name.length > 1 && 'Shift',
    ]
      .filter((m): m is string => typeof m === 'string')
      .concat(name)
      .join('+');
  if (NAMED_KEYS.has(e.key)) return chord(e.key);
  // Ctrl/Cmd+V is left to the browser: it fires a paste event carrying the user's
  // clipboard, which the remote page's own (empty) clipboard could never supply.
  if ((e.ctrlKey || e.metaKey) && e.key.length === 1 && e.key.toLowerCase() !== 'v')
    return chord(e.key);
  return null;
}

export function textInput(text: string): BrowserHandoffInput | null {
  return text.length > 0 ? { kind: 'text', text } : null;
}

/** Is there anything for Stop to stop: an action running or a tab open? */
export function canStopBrowser(
  status: { active: boolean; tabs: ReadonlyArray<unknown> } | undefined,
): boolean {
  return Boolean(status && (status.active || status.tabs.length > 0));
}

/** The largest size with the page's shape that fits in `box`. */
export function fitSize(
  box: { width: number; height: number },
  page: { width: number; height: number },
): { width: number; height: number } {
  const scale = Math.min(box.width / page.width, box.height / page.height);
  if (!Number.isFinite(scale) || scale <= 0) return { width: 0, height: 0 };
  return { width: Math.floor(page.width * scale), height: Math.floor(page.height * scale) };
}

export interface PreviewPosition {
  x: number;
  y: number;
}

/** Keep a floating preview of `size` fully inside the window, `margin` from its edges. */
export function clampPreview(
  pos: PreviewPosition,
  size: { width: number; height: number },
  win: { width: number; height: number },
  margin = 8,
): PreviewPosition {
  const maxX = Math.max(margin, win.width - size.width - margin);
  const maxY = Math.max(margin, win.height - size.height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, Math.round(pos.x))),
    y: Math.min(maxY, Math.max(margin, Math.round(pos.y))),
  };
}

const PREVIEW_POSITION_KEY = 'patch.browserPreview.position';

export function loadPreviewPosition(): PreviewPosition | null {
  try {
    const raw = localStorage.getItem(PREVIEW_POSITION_KEY);
    if (!raw) return null;
    const p: unknown = JSON.parse(raw);
    if (
      typeof p === 'object' &&
      p !== null &&
      'x' in p &&
      'y' in p &&
      typeof p.x === 'number' &&
      typeof p.y === 'number'
    ) {
      return { x: p.x, y: p.y };
    }
    return null;
  } catch {
    return null;
  }
}

export function savePreviewPosition(pos: PreviewPosition): void {
  try {
    localStorage.setItem(PREVIEW_POSITION_KEY, JSON.stringify(pos));
  } catch {
    // Storage full or blocked: the preview still moves, it just forgets where.
  }
}

export const PREVIEW_MIN_WIDTH = 240;
export const PREVIEW_DEFAULT_WIDTH = 360;
const PREVIEW_WIDTH_KEY = 'patch.browserPreview.width';

/** A preview width kept between the smallest legible card and the window less its margins. */
export function clampPreviewWidth(width: number, windowWidth: number, margin = 12): number {
  const max = Math.max(PREVIEW_MIN_WIDTH, windowWidth - margin * 2);
  return Math.min(max, Math.max(PREVIEW_MIN_WIDTH, Math.round(width)));
}

export function loadPreviewWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function savePreviewWidth(width: number): void {
  try {
    localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
  } catch {
    // Storage full or blocked: the preview still resizes, it just forgets the size.
  }
}

/** The site of an address, as a person names it ("gwr.com"); '' when it has none. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** How long the browser has been in use: "0:42", "12:05", "1:02:33". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The newest one-line summary of the agent's browser work in this chat — the
 * same line its tool run shows in the transcript ("Comparing Saturday
 * trains") — without the ellipsis a live line ends in. Null until one exists.
 */
export function browsingSummary(
  entries: ReadonlyArray<{ kind: string; tool?: string; callId?: string }>,
  summaries: Readonly<Record<string, { callIds: string[]; summary: string | null }>> | undefined,
): string | null {
  if (!summaries) return null;
  const runs = Object.values(summaries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== 'tool_call' || !(e.tool ?? '').includes('patch_browser_') || !e.callId) continue;
    const run = runs.find((r) => r.callIds.includes(e.callId!));
    if (run?.summary) return run.summary.replace(/…$/, '').trim();
  }
  return null;
}

export type BrowserViewModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** The modifier keys held during an event, in the wire's names. */
export function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): BrowserViewModifier[] {
  const out: BrowserViewModifier[] = [];
  if (e.altKey) out.push('Alt');
  if (e.ctrlKey) out.push('Control');
  if (e.metaKey) out.push('Meta');
  if (e.shiftKey) out.push('Shift');
  return out;
}

/** A DOM pointer button as the wire names it. */
export function buttonOf(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}

/**
 * Who has the tab, as the view's chip says it: the agent driving, the user
 * driving after Take over, or the agent waiting for the user (a hand-off).
 */
export type DriveState = 'agent' | 'user' | 'needs';

export function driveState(
  handoff: { tabId: string } | undefined,
  status: { tabs: ReadonlyArray<{ tabId: string; driver?: 'agent' | 'user' }> } | undefined,
  tabId: string | undefined,
): DriveState {
  if (handoff && (tabId === undefined || handoff.tabId === tabId)) return 'needs';
  const tab = status?.tabs.find((t) => t.tabId === tabId);
  return tab?.driver === 'user' ? 'user' : 'agent';
}

/**
 * The tab a chat's views show: the one handed to the user, else the one the
 * newest picture is of, else the newest open tab.
 */
export function viewedTab(
  handoff: { tabId: string } | undefined,
  frame: { tabId: string } | undefined,
  status: { tabs: ReadonlyArray<{ tabId: string }> } | undefined,
): string | undefined {
  return handoff?.tabId ?? frame?.tabId ?? status?.tabs[status.tabs.length - 1]?.tabId;
}
