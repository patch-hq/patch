// Quotes in a composer draft (spec/15 § Composer — quotes). Phone twin of packages/web/src/lib/composerQuotes.ts.
// stored as `> `-prefixed lines at the head of the draft text, so the draft
// that syncs to the server and is sent to the agent is unchanged; the composer
// just lifts the leading quote blocks out and draws each as a card above the
// input, leaving the textarea holding only what the user types.

export interface SplitDraft {
  /** Each leading quote block, with the `> ` markers removed. */
  quotes: string[];
  /** Everything after the leading quotes: the textarea's content. */
  body: string;
}

const QUOTE_LINE = /^>/;

export function splitQuotes(draft: string): SplitDraft {
  const lines = draft.split('\n');
  const quotes: string[] = [];
  let i = 0;
  while (i < lines.length && QUOTE_LINE.test(lines[i] as string)) {
    const block: string[] = [];
    while (i < lines.length && QUOTE_LINE.test(lines[i] as string)) {
      block.push((lines[i] as string).replace(/^> ?/, ''));
      i++;
    }
    quotes.push(block.join('\n'));
    // Exactly one blank line separates a quote from what follows; any more
    // belongs to the body so a join/split round trip is exact.
    if (i < lines.length && lines[i] === '') i++;
  }
  return { quotes, body: lines.slice(i).join('\n') };
}

export function joinQuotes(quotes: string[], body: string): string {
  if (quotes.length === 0) return body;
  const blocks = quotes.map((q) =>
    q
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  );
  return `${blocks.join('\n\n')}\n\n${body}`;
}
