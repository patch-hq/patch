// Page-side scripts for the agent browser (spec/02 § Browser). They run in the
// PAGE, not this (Node, no DOM lib) process — plain source strings handed to
// Playwright's addInitScript/evaluate, so this package needs no `dom` lib and
// no `any` escape hatch for page globals.

export const PATCH_WEBDRIVER_INIT_SCRIPT = `
Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => undefined,
  configurable: true,
});
`;

/**
 * Builds the snapshot script for ONE frame. `prefix` makes a frame's refs
 * unique across the page ('' for the top frame, 'f2' for the second frame, …).
 *
 * Refs are STABLE: an element that already carries a `data-patch-ref` keeps it
 * across reads, and a new one takes the next number from a per-document counter
 * that only goes up. A ref stops resolving only when its element leaves the
 * page. Open shadow roots are walked; Playwright's CSS locator pierces them, so
 * a ref found inside one clicks like any other.
 *
 * A password, or anything the user typed during a hand-off, is theirs: the agent
 * sees that it is filled, never what it holds (spec/02 § Browser — Hand-off).
 */
export function snapshotScript(prefix: string): string {
  return `(() => {
  const PREFIX = ${JSON.stringify(prefix)};
  const SELECTOR = 'a[href], button, input, select, textarea, summary, [role], [onclick], [contenteditable=""], [contenteditable="true"], h1, h2, h3, h4, h5, h6';
  const counterKey = '__patchRefCounter';
  let counter = window[counterKey] || 0;
  const nodes = [];
  const seen = new Set();
  const visit = (root) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
    for (const el of Array.from(root.querySelectorAll(SELECTOR))) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let ref = el.getAttribute('data-patch-ref');
      if (!ref || !ref.startsWith(PREFIX + 'e')) {
        ref = PREFIX + 'e' + (++counter);
        el.setAttribute('data-patch-ref', ref);
      }
      const tag = el.tagName.toLowerCase();
      const explicitRole = el.getAttribute('role');
      const role = explicitRole || (
        tag === 'a' ? 'link' :
        tag === 'button' ? 'button' :
        tag === 'summary' ? 'button' :
        tag === 'select' ? 'combobox' :
        tag === 'textarea' ? 'textbox' :
        tag === 'input' ? (el.type || 'textbox') :
        /^h[1-6]$/.test(tag) ? 'heading' : 'generic'
      );
      const secret = (v) => (v && (el.type === 'password' || el.hasAttribute('data-patch-user-typed'))) ? '[redacted]' : v;
      const name = el.getAttribute('aria-label') || el.placeholder ||
        (el.innerText ? el.innerText.trim().slice(0, 200) : '') || secret(el.value) || '';
      const node = { ref, role, name, tag };
      if (tag === 'a') node.href = el.href;
      if (tag === 'input') {
        node.type = el.type;
        node.value = secret(el.value);
        if (el.type === 'checkbox' || el.type === 'radio') node.checked = el.checked;
      } else if (tag === 'select') {
        node.value = el.value;
        node.options = Array.from(el.options).map((o) => o.value || o.text);
      } else if (tag === 'textarea') {
        node.value = secret(el.value);
      }
      if (el.disabled) node.disabled = true;
      nodes.push(node);
    }
  };
  visit(document);
  window[counterKey] = counter;
  return nodes;
})()`;
}

/**
 * Visible text of the page (or of one element), shadow DOM included. Hidden
 * elements are skipped; block boundaries become newlines. A password field's
 * value is never part of it.
 */
export function textScript(ref: string | undefined): string {
  return `(() => {
  const root = ${ref ? `document.querySelector('[data-patch-ref=' + JSON.stringify(${JSON.stringify(ref)}) + ']')` : 'document.body'};
  if (!root) return null;
  const BLOCK = /^(address|article|aside|blockquote|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tr|ul|br)$/;
  const SKIP = /^(script|style|noscript|template|head)$/;
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.nodeValue.replace(/\\s+/g, ' ')); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.test(tag)) return;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (tag === 'input' || tag === 'textarea') {
      if (node.type !== 'password' && node.value) out.push(node.value);
      return;
    }
    const block = BLOCK.test(tag);
    if (block) out.push('\\n');
    if (node.shadowRoot) for (const c of Array.from(node.shadowRoot.childNodes)) walk(c);
    else for (const c of Array.from(node.childNodes)) walk(c);
    if (block) out.push('\\n');
  };
  walk(root);
  return out.join('').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n[ \\t]+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`;
}

/** Tables, lists and the article body, as data rather than a wall of text. */
export const STRUCTURED_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const tables = Array.from(document.querySelectorAll('table')).filter(visible).map((t) => {
    const rows = Array.from(t.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName)).map((c) => clean(c.innerText)));
    const headRow = t.querySelector('thead tr') || (t.querySelector('tr th') ? t.querySelector('tr') : null);
    let headers = [];
    let body = rows;
    if (headRow) {
      headers = Array.from(headRow.children).map((c) => clean(c.innerText));
      body = rows.filter((r, i) => i !== Array.from(t.querySelectorAll('tr')).indexOf(headRow));
    }
    const cap = t.querySelector('caption');
    return { caption: cap ? clean(cap.innerText) : '', headers, rows: body.filter((r) => r.length > 0) };
  });
  const lists = Array.from(document.querySelectorAll('ul, ol, dl')).filter(visible)
    .filter((l) => !l.parentElement || !l.parentElement.closest('ul, ol, dl'))
    .map((l) => ({
      kind: l.tagName.toLowerCase(),
      items: Array.from(l.children).map((c) => clean(c.innerText)).filter(Boolean),
    })).filter((l) => l.items.length > 0);
  const candidates = Array.from(document.querySelectorAll('article, main, [role=main]')).filter(visible);
  let best = null;
  for (const c of candidates) if (!best || c.innerText.length > best.innerText.length) best = c;
  if (!best) {
    for (const c of Array.from(document.querySelectorAll('div, section'))) {
      if (!visible(c)) continue;
      const pText = Array.from(c.children).filter((x) => x.tagName === 'P').reduce((n, p) => n + p.innerText.length, 0);
      if (pText > 200 && (!best || pText > best.__pText)) { c.__pText = pText; best = c; }
    }
  }
  const links = Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 300)
    .map((a) => ({ text: clean(a.innerText), href: a.href })).filter((l) => l.text);
  return {
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible)
      .map((h) => ({ level: Number(h.tagName[1]), text: clean(h.innerText) })),
    article: best ? best.innerText.replace(/\\n{3,}/g, '\\n\\n').trim() : '',
    tables,
    lists,
    links,
  };
})()`;
