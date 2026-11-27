// A one-line summary for a user-role turn Patch itself sent (a self-wake, a
// watch update, the todo list advancing, finished chats reaching the Manager, a
// job fire, a message
// from another agent). The row is collapsed system furniture; this is its label,
// so the transcript reads "Woke itself — check the deploy" instead of a bare
// "Automated message". The full text stays one click away in the disclosure.

const MAX_DETAIL = 80;

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 1).trimEnd()}…` : t;
}

function labelled(label: string, detail: string): string {
  const d = clip(detail);
  return d === '' ? label : `${label} — ${d}`;
}

/** After a `[tag]` prefix: whatever follows on that line, else the next line. */
function afterTag(content: string, tag: string): string {
  const rest = content.slice(tag.length);
  return firstLine(rest);
}

export function systemMessageSummary(content: string, kind: 'machine' | 'job'): string {
  const text = content.trimStart();
  if (text.startsWith('[wake]')) return labelled('Woke itself', afterTag(text, '[wake]'));
  if (text.startsWith('[watch]')) return labelled('Watch update', afterTag(text, '[watch]'));
  if (text.startsWith('[todo]')) return labelled('Next todo', afterTag(text, '[todo]'));
  const pad = /^\[Pad\][^\n]*/.exec(text)?.[0];
  if (pad) return pad;
  // Finished chats reaching the Manager (spec/06 § Finished chats): the line
  // after the notes says it all — "2 chats finished in the last 30 min."
  const finished = /^[^\n]+ finished(?: in the last [^\n.]+)?\.$/.exec(text.trim())?.[0];
  if (finished) return finished;
  return labelled(kind === 'job' ? 'Job fired' : 'Automated message', firstLine(text));
}
