// Quotes in a composer draft (spec/14 § Composer — quotes). A quote is stored as
// `> `-prefixed lines in the draft text, so the draft that syncs to the server
// and is sent to the agent is plain markdown; the composer lifts the quote
// blocks out and draws each as a card inside the input, with the reply typed
// under it. A draft reads top to bottom as quote, reply, quote, reply, …, and
// the textarea holds only the last reply.

export type ThreadItem =
  /** A quoted passage, with the `> ` markers removed. */
  | { kind: 'quote'; text: string }
  /** What the user wrote in reply to the quote above it. Always followed by another quote. */
  | { kind: 'reply'; text: string };

export interface SplitDraft {
  /** Everything above the textarea; empty or ending in a quote. */
  thread: ThreadItem[];
  /** The textarea's content: the reply to the last quote. */
  body: string;
}

const isQuoteLine = (line: string | undefined): boolean =>
  line !== undefined && line.startsWith('>');

/** End (exclusive) of the quote run starting at `from`. */
function quoteRunEnd(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && isQuoteLine(lines[i])) i++;
  return i;
}

export function splitThread(draft: string): SplitDraft {
  const lines = draft.split('\n');
  const thread: ThreadItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isQuoteLine(lines[i])) {
      const end = quoteRunEnd(lines, i);
      // A quote opens the draft whether or not anything follows it; a later one
      // only counts once a blank line closes it, so a ">" the user is still
      // typing in the box is not snatched into a card.
      const closed = end < lines.length && lines[end] === '';
      if (thread.length > 0 && !closed) break;
      if (thread.length === 0 && end === lines.length) {
        thread.push({ kind: 'quote', text: quoteText(lines, i, end) });
        i = end;
        break;
      }
      thread.push({ kind: 'quote', text: quoteText(lines, i, end) });
      // Exactly one blank line separates a quote from what follows; any more
      // belongs to the reply so a join/split round trip is exact.
      i = closed ? end + 1 : end;
      continue;
    }
    // Reply text: runs up to the next closed quote that follows a blank line.
    let next = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (!isQuoteLine(lines[k]) || lines[k - 1] !== '') continue;
      const end = quoteRunEnd(lines, k);
      if (end < lines.length && lines[end] === '') {
        next = k;
        break;
      }
      k = end;
    }
    if (next === -1 || thread.length === 0) break;
    thread.push({ kind: 'reply', text: lines.slice(i, next - 1).join('\n') });
    i = next;
  }
  return { thread, body: lines.slice(i).join('\n') };
}

function quoteText(lines: string[], from: number, to: number): string {
  return lines
    .slice(from, to)
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n');
}

export function joinThread(thread: ThreadItem[], body: string): string {
  if (thread.length === 0) return body;
  const blocks = thread.map((item) =>
    item.kind === 'reply'
      ? item.text
      : item.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
  );
  return `${blocks.join('\n\n')}\n\n${body}`;
}
