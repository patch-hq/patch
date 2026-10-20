// The final write-up as the Summary tab edits it: the whole body is one
// contenteditable, so it is drawn as HTML and read back from the DOM.

import type { MeetingNameFix, MeetingWriteup } from '@patch/wire';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An item's text with each name the clean-up pass fixed underlined, the original in the tooltip. */
export function itemHtml(text: string, fixes: MeetingNameFix[]): string {
  if (fixes.length === 0) return escapeHtml(text);
  const byTo = new Map<string, string>();
  for (const f of fixes) if (!byTo.has(f.to)) byTo.set(f.to, f.from);
  const terms = [...byTo.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w])(${terms.map(escapeRe).join('|')})(?![\\w])`, 'g');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index));
    out += `<span class="fixed" title="was: ${escapeHtml(byTo.get(m[1]!)!)}">${escapeHtml(m[1]!)}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Headings and bullets, without the title. Each bullet remembers its original text so edits can be told from untouched lines. */
export function writeupBodyHtml(w: MeetingWriteup, fixes: MeetingNameFix[]): string {
  return w.sections
    .map(
      (s) =>
        `<h2>${escapeHtml(s.heading)}</h2><ul>${s.items
          .map(
            (i) =>
              `<li${i.mine ? ' class="mine"' : ''} data-orig="${escapeHtml(i.text)}" data-mine="${i.mine ? '1' : '0'}">${itemHtml(i.text, fixes)}</li>`,
          )
          .join('')}</ul>`,
    )
    .join('');
}

/**
 * Reads the edited body back. A bullet whose text differs from what was drawn
 * (or that is new) is Tom's wording, so it becomes `mine`; empty ones are dropped.
 */
export function writeupFromBody(title: string, root: ParentNode): MeetingWriteup {
  const sections: MeetingWriteup['sections'] = [];
  let current: MeetingWriteup['sections'][number] | null = null;
  const open = (heading: string): MeetingWriteup['sections'][number] => {
    const s = { heading, items: [] };
    sections.push(s);
    return s;
  };
  for (const el of Array.from(root.children)) {
    if (el.tagName === 'H2') {
      current = open((el.textContent ?? '').trim());
    } else if (el.tagName === 'UL' || el.tagName === 'OL') {
      for (const li of Array.from(el.querySelectorAll('li'))) {
        const text = (li.textContent ?? '').trim();
        if (text === '') continue;
        const untouched = li.getAttribute('data-orig') === text;
        const mine = !untouched || li.getAttribute('data-mine') === '1';
        (current ??= open('')).items.push(mine ? { text, mine: true } : { text });
      }
    } else if ((el.textContent ?? '').trim() !== '') {
      (current ??= open('')).items.push({ text: (el.textContent ?? '').trim(), mine: true });
    }
  }
  return {
    title: title.trim(),
    sections: sections.filter((s) => s.heading !== '' || s.items.length > 0),
  };
}

/** The write-up as plain text for pasting into an email or message. */
export function writeupText(w: MeetingWriteup, meta: string): string {
  return [
    w.title,
    meta,
    ...w.sections.flatMap((s) => ['', s.heading, ...s.items.map((i) => `- ${i.text}`)]),
  ].join('\n');
}
