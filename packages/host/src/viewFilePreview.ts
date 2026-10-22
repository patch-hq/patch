// view_file — the inline preview of a downloadable file (spec/14 § Tool calls).
//
// A `file` card used to be a name and a download arrow. The chat now shows what
// is inside as well, as a small HTML page published next to the file itself and
// mounted in the same sandboxed frame an `.html` view_file uses.
//
//   - .docx: converted with mammoth (images inlined as data URIs).
//   - .csv .tsv .txt .md .json: the first PREVIEW_TEXT_BYTES as escaped text.
//   - everything else (xlsx, pptx, odf, rtf, epub, zip, legacy .doc/.xls/.ppt):
//     no preview. That is a stated limit, not a failure: `previewable()` says
//     so up front and the card simply has no frame.
//
// NO FALLBACK: a previewable file whose conversion throws or whose page is too
// big raises; the caller reports it in the ack as `previewError`.

import { closeSync, openSync, readSync } from 'node:fs';
import mammoth from 'mammoth';

/** Same ceiling as an `.html` page: the preview is published as one. */
export const MAX_PREVIEW_HTML_BYTES = 2 * 1024 * 1024;
/** How much of a text file the preview shows. */
export const PREVIEW_TEXT_BYTES = 64 * 1024;

const TEXT_EXTS = new Set(['.csv', '.tsv', '.txt', '.md', '.json']);

export function previewable(ext: string): boolean {
  return ext === '.docx' || TEXT_EXTS.has(ext);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

const PAGE_STYLE =
  'body{margin:0;padding:12px 16px;font:14px/1.5 system-ui,sans-serif;color:#222;background:#fff}' +
  'pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace}' +
  'table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}img{max-width:100%}' +
  '.truncated{margin-top:8px;color:#888;font:12px system-ui,sans-serif}';

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

function readHead(absPath: string, bytes: number): { text: string; truncated: boolean } {
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(bytes + 1);
    const n = readSync(fd, buf, 0, bytes + 1, 0);
    const truncated = n > bytes;
    return { text: buf.subarray(0, Math.min(n, bytes)).toString('utf8'), truncated };
  } finally {
    closeSync(fd);
  }
}

/** The preview page for a previewable file. Throws if it cannot be built. */
export async function buildPreviewHtml(
  absPath: string,
  ext: string,
  name: string,
): Promise<string> {
  let html: string;
  if (ext === '.docx') {
    const result = await mammoth.convertToHtml({ path: absPath });
    html = page(name, result.value);
  } else if (TEXT_EXTS.has(ext)) {
    const { text, truncated } = readHead(absPath, PREVIEW_TEXT_BYTES);
    html = page(
      name,
      `<pre>${escapeHtml(text)}</pre>` +
        (truncated
          ? `<div class="truncated">Preview shows the first ${PREVIEW_TEXT_BYTES / 1024} KB.</div>`
          : ''),
    );
  } else {
    throw new Error(`no preview for ${ext}`);
  }
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_PREVIEW_HTML_BYTES) {
    throw new Error(`preview is ${bytes} bytes — the limit is ${MAX_PREVIEW_HTML_BYTES}`);
  }
  return html;
}
