// Link previews on the phone (spec/14 § Message links): the http(s) test, the
// per-url session cache and the authenticated image request.

import { api, type LinkPreviewData } from '../api/rest';
import { apiUrl } from '../config';
import { loadCredential } from './credential';

export function isHttpLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// A page's metadata does not change under a live session, so each url is
// fetched once (web: staleTime Infinity). A failure is dropped so reopening
// retries rather than showing the same error forever.
const cache = new Map<string, Promise<LinkPreviewData>>();

export function getLinkPreview(url: string): Promise<LinkPreviewData> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = api.linkPreview(url);
  cache.set(url, p);
  p.catch(() => {
    if (cache.get(url) === p) cache.delete(url);
  });
  return p;
}

export function __resetLinkPreviewCache(): void {
  cache.clear();
}

/** The og:image goes through the server (it is third-party), so it needs the bearer. */
export function previewImageSource(imageUrl: string): {
  uri: string;
  headers: { authorization: string };
} {
  const cred = loadCredential();
  if (!cred) throw new Error('no credential: cannot load the preview image');
  return {
    uri: apiUrl(`/api/link-preview/image?url=${encodeURIComponent(imageUrl)}`),
    headers: { authorization: `Bearer ${cred}` },
  };
}
