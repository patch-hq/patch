// LinkPreviewToggle — the small Summarise button next to a message link. A
// click asks the server to fetch the linked page and summarise it with the
// account's link-summary prompt (Settings → Agent), shown inline under the
// link, so knowing what a link says doesn't require leaving the chat
// (spec/14 § Message links).
//
// Only rendered for http(s) links — a relative in-app anchor or a mailto:
// link has nothing for the server to fetch.

import type { JSX } from 'react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, ExternalLink } from 'lucide-react';
import { api } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';

export function LinkPreviewToggle({ url }: { url: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <span className="link-preview-wrap">
      <button
        type="button"
        className="link-preview-toggle"
        aria-expanded={open}
        aria-label={open ? 'Hide link summary' : 'Summarise link'}
        data-testid="link-summary-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <Sparkles size={14} aria-hidden />
      </button>
      {/*
        The desktop shell's link policy (packages/desktop/src/link-policy.ts)
        routes a plain click on a message link into Patch's own in-app browser
        panel, not the OS browser — a `target="_blank"` open is what that
        policy sends to shell.openExternal instead (routeWindowOpen). This
        button exists so getting a link into the real desktop browser doesn't
        require knowing the ctrl/cmd-click escape hatch; on the plain web
        surface it's just an ordinary new-tab open.
      */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="link-preview-external"
        aria-label="Open in browser"
        data-testid="link-preview-external"
      >
        <ExternalLink size={14} aria-hidden />
      </a>
      {open ? <LinkSummaryCard url={url} /> : null}
    </span>
  );
}

function LinkSummaryCard({ url }: { url: string }): JSX.Element {
  // The prompt is part of the key: editing it in Settings makes the next open
  // summarise afresh instead of replaying a summary the old prompt wrote.
  const prompt = usePreferencesStore((s) => s.preferences.linkSummaryPrompt);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['link-summary', url, prompt],
    queryFn: () => api.linkSummary(url),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <span className="link-preview-card" data-testid="link-summary-card">
      {isLoading ? <span className="link-preview-status">Summarising…</span> : null}
      {isError ? (
        <span className="link-preview-status link-preview-error" data-testid="link-summary-error">
          {error instanceof Error ? error.message : 'Summary failed'}
        </span>
      ) : null}
      {data ? (
        <span className="link-summary-text" data-testid="link-summary-text">
          {data.summary}
        </span>
      ) : null}
      <span className="link-preview-host">{new URL(url).host}</span>
    </span>
  );
}
