// Link summaries on the phone (spec/14 § Message links): the http(s) test and
// the per-url session cache.

import { api, type LinkSummaryData } from '../api/rest';

export function isHttpLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// A summary is kept for the session so reopening a link does not pay for a
// second model call. The prompt is part of the key: editing it in Settings
// makes the next open summarise afresh. A failure is dropped so reopening
// retries rather than showing the same error forever.
const cache = new Map<string, Promise<LinkSummaryData>>();

export function getLinkSummary(url: string, prompt: string): Promise<LinkSummaryData> {
  const key = `${prompt}\n${url}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = api.linkSummary(url);
  cache.set(key, p);
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  return p;
}

export function __resetLinkPreviewCache(): void {
  cache.clear();
}
