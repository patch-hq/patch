// Display-size copies of stored images (`?w=<px>` on the blob, attachment and
// artifact serve-backs). A chat shows a picture a few hundred pixels wide, so
// the browser should not download the multi-megabyte original for it; the
// lightbox asks for the URL without `?w=` and gets the original.
//
// Only still raster formats are resized. Anything else (gif would lose its
// animation, svg is already vector, video/pdf are not images) is served as it
// is — that is the type's behaviour, not an error path. A corrupt image makes
// sharp throw, and the route answers 500 rather than quietly sending the
// original.

import sharp from 'sharp';

export const MIN_THUMB_WIDTH = 16;
export const MAX_THUMB_WIDTH = 2048;

const RESIZABLE: Record<string, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type ThumbWidth = { ok: true; width: number | undefined } | { ok: false; message: string };

/** `?w=` → a pixel width; absent means "the original". */
export function parseThumbWidth(raw: unknown): ThumbWidth {
  if (raw === undefined) return { ok: true, width: undefined };
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) {
    return { ok: false, message: 'w must be a whole number of pixels' };
  }
  const width = Number(raw);
  if (width < MIN_THUMB_WIDTH || width > MAX_THUMB_WIDTH) {
    return { ok: false, message: `w must be ${MIN_THUMB_WIDTH}-${MAX_THUMB_WIDTH}` };
  }
  return { ok: true, width };
}

export function isResizable(mime: string): boolean {
  return mime.split(';')[0]!.trim().toLowerCase() in RESIZABLE;
}

/** The image scaled down to `width` px wide, same format; never enlarged. */
export async function resizeImage(bytes: Buffer, mime: string, width: number): Promise<Buffer> {
  const format = RESIZABLE[mime.split(';')[0]!.trim().toLowerCase()];
  if (!format) throw new Error(`not a resizable image type: ${mime}`);
  return sharp(bytes)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .toFormat(format)
    .toBuffer();
}
