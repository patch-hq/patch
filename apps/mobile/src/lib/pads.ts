// Pads on the phone (spec/14 § Pads): list grouping, badges and the Pad-card
// route. A Pad card is a `chat.artifact` whose url is the Pad's own route
// (`/pads/<id>`); it opens the Pad screen, never the artifact viewer.

import type { PadView } from '../api/rest';

const PAD_URL = /^\/pads\/([^/?#]+)$/;

/** The Pad id a Pad card's url names, or null for an ordinary artifact. */
export function padIdFromArtifactUrl(url: string): string | null {
  const m = PAD_URL.exec(url);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export function padRoute(padId: string): string {
  return `/pads/${encodeURIComponent(padId)}`;
}

/** Working while a sent batch awaits the agent, else the pending count, else nothing. */
export function padBadge(pad: Pick<PadView, 'working' | 'pending'>): string | null {
  if (pad.working) return 'Working';
  if (pad.pending > 0) return `${pad.pending} ${pad.pending === 1 ? 'change' : 'changes'}`;
  return null;
}

/** Pads grouped by the app they design for (No app last), filtered by name, app or chat name. */
export function groupPads(
  pads: readonly PadView[],
  query: string,
  chatName: (chatId: string) => string,
): [string, PadView[]][] {
  const q = query.trim().toLowerCase();
  const out = new Map<string, PadView[]>();
  for (const p of pads) {
    const hay = `${p.name} ${p.app ?? ''} ${chatName(p.chatId)}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const key = p.app ?? 'No app';
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return [...out].sort(([a], [b]) => (a === 'No app' ? 1 : b === 'No app' ? -1 : 0));
}

/**
 * Open a published artifact the way web's openArtifact does: a Pad card opens
 * the Pad, anything else opens in the artifact viewer.
 */
export function openArtifactTarget(
  url: string,
  title: string,
  actions: {
    pushRoute: (route: string) => void;
    viewer: (absoluteUrl: string, title: string) => void;
  },
  absolute: (path: string) => string,
): void {
  const padId = padIdFromArtifactUrl(url);
  if (padId !== null) actions.pushRoute(padRoute(padId));
  else actions.viewer(absolute(url), title);
}
