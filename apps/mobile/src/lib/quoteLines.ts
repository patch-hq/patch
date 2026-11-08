// Splits system-message text into plain and quoted runs. A line starting with
// ">" is a quote line; consecutive quote lines form one run, marker removed —
// the same reading chat markdown gives them.

export interface QuoteRun {
  quote: boolean;
  text: string;
}

export function splitQuoteLines(text: string): QuoteRun[] {
  const runs: QuoteRun[] = [];
  for (const line of text.split('\n')) {
    const m = /^>\s?(.*)$/.exec(line);
    const quote = m !== null;
    const body = m ? m[1]! : line;
    const last = runs[runs.length - 1];
    if (last && last.quote === quote) last.text += `\n${body}`;
    else runs.push({ quote, text: body });
  }
  return runs;
}
