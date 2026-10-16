/** Absolute paths are cut earlier: only their tail identifies the project. */
const PATH_MAX_CHARS = 24;
/** Longest tooltip we draw; anything longer is cut so it always fits its box. */
export const TOOLTIP_MAX_CHARS = 60;

/**
 * Fit tooltip copy into the bubble. A long absolute path keeps its last two
 * segments (the part that identifies the project); any other long text is cut
 * with an ellipsis.
 */
export function fitTooltipText(text: string): string {
  const isPath = text.startsWith('/') && !/\s/.test(text);
  if (text.length <= (isPath ? PATH_MAX_CHARS : TOOLTIP_MAX_CHARS)) return text;
  if (isPath) {
    const tail = text.split('/').filter(Boolean).slice(-2).join('/');
    const short = `…/${tail}`;
    return short.length <= TOOLTIP_MAX_CHARS ? short : `…${short.slice(-(TOOLTIP_MAX_CHARS - 1))}`;
  }
  return `${text.slice(0, TOOLTIP_MAX_CHARS - 1)}…`;
}
