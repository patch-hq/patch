// Vocabulary for meeting transcription, built per meeting with nothing for the
// user to maintain: participant names from speaker detection, terms carried over
// from earlier meetings in the same folder, terms the clean-up pass has
// corrected, and the optional glossary. It goes to the speech-to-text engine as
// its initial prompt, which biases it towards spelling these the right way.

/** Whisper reads about 224 tokens of prompt; stay well inside that. */
export const VOCAB_MAX_CHARS = 600;
/** Terms kept per source when a finished meeting is mined for the next one. */
const EARLIER_TERM_LIMIT = 40;

export interface MeetingVocab {
  /** Terms the clean-up pass changed, newest last. */
  learned: string[];
  /** Terms carried in from earlier meetings in the same folder. */
  earlier: string[];
}

const normal = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const stripPunct = (w: string): string => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

/** A proper noun, acronym or code: the shapes a speech model mis-spells. */
function isTermLike(w: string): boolean {
  return /^[A-Z]/.test(w) || /\d/.test(w);
}

/** Case-insensitive de-duplication that keeps the first spelling and drops empties. */
export function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    const k = normal(t);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * The terms the clean-up pass introduced into a line: runs of words in `after`
 * that `before` did not contain, kept when they look like names or acronyms.
 * "the weka board" -> "the WECA board" gives ["WECA"]; "south glove" ->
 * "South Glos" gives ["South Glos"].
 */
export function learnedTerms(before: string, after: string): string[] {
  if (before === after) return [];
  const had = new Set(before.split(/\s+/).map((w) => normal(stripPunct(w))));
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0 && run.some(isTermLike)) out.push(run.join(' '));
    run = [];
  };
  for (const word of after.split(/\s+/)) {
    const w = stripPunct(word);
    // Exact-case match too: "weca" -> "WECA" is a correction though both normalise equal.
    const unchanged = w === '' || (had.has(normal(w)) && before.includes(w));
    if (unchanged) {
      flush();
      continue;
    }
    run.push(w);
    if (/[.,;:!?]$/.test(word)) flush();
  }
  flush();
  return uniqueTerms(out);
}

/**
 * Terms worth carrying forward from a finished meeting's cleaned transcript:
 * acronyms and capitalised words that are not just a sentence's first word,
 * most frequent first.
 */
export function termsFromTranscript(lines: string[]): string[] {
  const counts = new Map<string, { term: string; n: number }>();
  const bump = (term: string): void => {
    const k = normal(term);
    if (k === '') return;
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { term, n: 1 });
  };
  for (const line of lines) {
    const words = line.split(/\s+/);
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) bump(run.join(' '));
      run = [];
    };
    words.forEach((word, i) => {
      const w = stripPunct(word);
      const acronym = /^[A-Z]{2,}[a-z]?$/.test(w) || /^[A-Za-z]*\d[A-Za-z0-9]*$/.test(w);
      const capital = /^[A-Z][a-z]+$/.test(w) && i > 0 && !/[.!?]$/.test(words[i - 1] ?? '');
      if (acronym || capital) run.push(w);
      else flush();
      if (/[.,;:!?]$/.test(word)) flush();
    });
    flush();
  }
  return [...counts.values()]
    .filter((c) => c.n >= 2 || /[A-Z]{2,}/.test(c.term))
    .sort((a, b) => b.n - a.n)
    .slice(0, EARLIER_TERM_LIMIT)
    .map((c) => c.term);
}

/** A glossary line is "Term" or "Term: heard as, heard as"; only the term goes in the prompt. */
export function glossaryTerm(entry: string): string {
  return (entry.split(':')[0] ?? '').trim();
}

/**
 * The initial prompt for one transcription call. Priority when it must be cut:
 * names, then terms the clean-up pass fixed, the glossary, and last what earlier
 * meetings used. Empty when there is nothing to say.
 */
export function vocabularyPrompt(input: {
  names: string[];
  vocab: MeetingVocab;
  glossary: string[];
  maxChars?: number;
}): string {
  const max = input.maxChars ?? VOCAB_MAX_CHARS;
  const names = uniqueTerms(input.names);
  const taken = new Set(names.map(normal));
  // Newest corrections first: they are what this meeting has been getting wrong.
  const rest = uniqueTerms([
    ...[...input.vocab.learned].reverse(),
    ...input.glossary.map(glossaryTerm),
    ...input.vocab.earlier,
  ]).filter((t) => !taken.has(normal(t)));

  const fit = (head: string, terms: string[], room: number): string[] => {
    const kept: string[] = [];
    let used = head.length;
    for (const t of terms) {
      const add = (kept.length === 0 ? 0 : 2) + t.length;
      if (used + add > room) break;
      kept.push(t);
      used += add;
    }
    return kept;
  };
  const nameHead = 'Participants: ';
  const keptNames = fit(nameHead, names, max - 1);
  const namePart = keptNames.length ? `${nameHead}${keptNames.join(', ')}.` : '';
  const termHead = 'Terms: ';
  const room = max - (namePart ? namePart.length + 1 : 0) - 1;
  const keptTerms = fit(termHead, rest, room);
  const termPart = keptTerms.length ? `${termHead}${keptTerms.join(', ')}.` : '';
  return [namePart, termPart].filter((p) => p !== '').join(' ');
}
