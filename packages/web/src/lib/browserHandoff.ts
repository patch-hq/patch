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
  if ((e.ctrlKey || e.metaKey) && e.key.length === 1) return chord(e.key);
  return null;
}

export function textInput(text: string): BrowserHandoffInput | null {
  return text.length > 0 ? { kind: 'text', text } : null;
}

/** Does this chat's transcript show the agent using its browser? */
export function chatUsedBrowser(entries: ReadonlyArray<{ kind: string; tool?: string }>): boolean {
  return entries.some((e) => e.kind === 'tool_call' && (e.tool ?? '').includes('patch_browser_'));
}

/**
 * What a chat's browser bar says it is doing: "Browsing example.com", with the
 * running action after it ("Browsing example.com · Clicking"). No tabs is just
 * "Browser".
 */
export function browsingLabel(
  status:
    | { active: boolean; action?: string | undefined; tabs: ReadonlyArray<{ url: string }> }
    | undefined,
): string {
  if (!status || (status.tabs.length === 0 && !status.active)) return 'Browser';
  let host = '';
  for (const t of status.tabs) {
    try {
      host = new URL(t.url).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    if (host) break;
  }
  const base = host ? `Browsing ${host}` : 'Browsing';
  return status.active && status.action ? `${base} · ${status.action}` : base;
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
