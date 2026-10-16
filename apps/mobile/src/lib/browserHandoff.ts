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
