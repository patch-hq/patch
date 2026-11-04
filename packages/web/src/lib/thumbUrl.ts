// Display-size URL for a served image (`?w=` on the blob / attachment /
// artifact routes). The chat draws pictures at most a screen wide, so the
// thumbnail asks for that width in device pixels, rounded UP to a bucket so
// the same picture is one cache entry across small viewport changes. The
// lightbox keeps the original URL.

const BUCKETS = [320, 480, 720, 960, 1440, 2048];

/** Pixel width to request for a picture shown at most `cssWidth` CSS px wide. */
export function thumbWidth(cssWidth: number, dpr: number): number {
  const need = Math.ceil(cssWidth * Math.max(1, dpr));
  return BUCKETS.find((b) => b >= need) ?? BUCKETS[BUCKETS.length - 1]!;
}

/**
 * `url` as a display-size copy. Only server-relative `/api/` URLs are served
 * resized; a `data:` or `blob:` URL (a live result, an unsent local file) is
 * already in memory and is returned unchanged.
 */
export function thumbUrl(url: string): string {
  if (!url.startsWith('/api/')) return url;
  const cssWidth = Math.min(window.innerWidth, 800);
  const w = thumbWidth(cssWidth, window.devicePixelRatio || 1);
  return `${url}${url.includes('?') ? '&' : '?'}w=${w}`;
}
