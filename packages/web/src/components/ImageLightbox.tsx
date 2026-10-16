import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Copy as CopyGlyph, Download as DownloadGlyph } from 'lucide-react';
import { CloseIcon } from './icons.js';
import { copyImageToClipboard } from '../lib/copyImage.js';
import { useUiStore } from '../stores/uiStore.js';

// Full-screen, zoomable image viewer rendered INSIDE the app (spec/14 §
// Composer — "in-app zoomable viewer, never navigate away"). Click/scroll to
// zoom, drag to pan when zoomed, Esc or a backdrop click to close.
//
// Portalled to <body>: `.chat-main` carries `contain: layout`, which makes it
// the containing block for `position: fixed` descendants, so an in-tree overlay
// is clipped to the chat panel instead of covering the window (Tom,
// `patch/todo.md` — "viewing the image should be full screen. currently its
// trapped in the window").
/** `image.<ext>` from a media type or data: URI; anything else is `image.png`. */
export function imageDownloadName(typeOrUrl: string): string {
  const m = /^(?:data:)?image\/([a-z0-9.+-]+)/i.exec(typeOrUrl);
  const sub = m?.[1]?.toLowerCase() ?? 'png';
  return `image.${sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub}`;
}

export function ImageLightbox({
  url,
  alt,
  downloadName,
  onClose,
}: {
  url: string;
  alt: string;
  /** File name offered by the download action; derived from the URL's type when omitted. */
  downloadName?: string | undefined;
  onClose(): void;
}): JSX.Element {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  function clampScale(s: number): number {
    return Math.min(8, Math.max(1, s));
  }
  function reset(): void {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  return createPortal(
    <div
      className="lightbox-backdrop"
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      onWheel={(e) => {
        e.preventDefault();
        setScale((s) => {
          const next = clampScale(s - e.deltaY * 0.002 * s);
          if (next === 1) setOffset({ x: 0, y: 0 });
          return next;
        });
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        data-testid="lightbox-close"
        aria-label="Close image viewer"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon size={22} />
      </button>
      <button
        type="button"
        className="lightbox-close lightbox-copy"
        data-testid="lightbox-copy"
        aria-label="Copy image"
        onClick={(e) => {
          e.stopPropagation();
          copyImageToClipboard(url).then(
            () => useUiStore.getState().pushNotice('Image copied'),
            (err: Error) => useUiStore.getState().pushError('copy failed', undefined, err.message),
          );
        }}
      >
        <CopyGlyph size={20} aria-hidden />
      </button>
      <a
        className="lightbox-close lightbox-download"
        data-testid="lightbox-download"
        aria-label="Download original image"
        href={url}
        download={downloadName ?? imageDownloadName(url)}
        onClick={(e) => e.stopPropagation()}
      >
        <DownloadGlyph size={20} aria-hidden />
      </a>
      <img
        className="lightbox-img"
        src={url}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'zoom-in',
        }}
        onClick={(e) => {
          e.stopPropagation();
          // Click toggles between fit and 2.5× zoom.
          if (scale > 1) reset();
          else setScale(2.5);
        }}
        onPointerDown={(e) => {
          if (scale <= 1) return;
          e.stopPropagation();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setOffset({
            x: drag.current.ox + (e.clientX - drag.current.x),
            y: drag.current.oy + (e.clientY - drag.current.y),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
    </div>,
    document.body,
  );
}
