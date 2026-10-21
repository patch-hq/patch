// Pure helpers for the agent-browser live view and hand-off bar (spec/15 §
// Browser hand-off). Mirrors packages/web/src/lib/browserHandoff.ts.

/** Map a point on the displayed picture to viewport pixels of the page it shows. */
export function toViewport(
  point: { x: number; y: number },
  shown: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const x = (point.x / shown.width) * viewport.width;
  const y = (point.y / shown.height) * viewport.height;
  return {
    x: Math.min(viewport.width - 1, Math.max(0, Math.round(x))),
    y: Math.min(viewport.height - 1, Math.max(0, Math.round(y))),
  };
}

/** Is there anything for Stop to stop: an action running or a tab open? */
export function canStopBrowser(
  status: { active: boolean; tabs: ReadonlyArray<unknown> } | undefined,
): boolean {
  return Boolean(status && (status.active || status.tabs.length > 0));
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
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The newest one-line summary of the agent's browser work, as its tool run shows it. */
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

/** Who has the tab: the agent, the user after Take over, or the agent waiting for the user. */
export type DriveState = 'agent' | 'user' | 'needs';

export function driveState(
  handoff: { tabId: string } | undefined,
  status: { tabs: ReadonlyArray<{ tabId: string; driver?: 'agent' | 'user' }> } | undefined,
  tabId: string | undefined,
): DriveState {
  if (handoff && (tabId === undefined || handoff.tabId === tabId)) return 'needs';
  return status?.tabs.find((t) => t.tabId === tabId)?.driver === 'user' ? 'user' : 'agent';
}

/** The tab a chat's views show: the one handed over, else the newest picture's, else the newest. */
export function viewedTab(
  handoff: { tabId: string } | undefined,
  frame: { tabId: string } | undefined,
  status: { tabs: ReadonlyArray<{ tabId: string }> } | undefined,
): string | undefined {
  return handoff?.tabId ?? frame?.tabId ?? status?.tabs[status.tabs.length - 1]?.tabId;
}
