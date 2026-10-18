import { test, expect } from '@playwright/test';

// Todoist: "blockquotes unreadable in dark mode (pale text on white box)".
const QUOTE = [
  'Intro line.',
  '',
  '> Quoted prompt text with `inline code` and **bold**.',
  '>',
  '> ```js',
  '> const a = 1;',
  '> ```',
  '>',
  '> - item one',
  '> - item two',
  '',
  'Outro.',
].join('\n');

type Rgb = [number, number, number];
function parse(v: string): [number, number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(v);
  if (!m) throw new Error(`unparseable colour: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}
function lum([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test('blockquote content is readable in dark mode on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  await page.evaluate((content) => {
    (
      window as unknown as { __store: { getState: () => { applyEvent: (e: unknown) => void } } }
    ).__store
      .getState()
      .applyEvent({
        type: 'chat.message',
        chatId: 'chat_bus',
        role: 'assistant',
        content,
        seq: 9200,
      });
  }, QUOTE);
  const bq = page.locator('.md blockquote').last();
  await expect(bq).toBeVisible();
  const rows = await bq.evaluate((root) => {
    const out: { tag: string; color: string; bg: string }[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const cs = getComputedStyle(el);
      // Nearest non-transparent background up the tree.
      let bg = 'rgba(0, 0, 0, 0)';
      for (let n: Element | null = el; n; n = n.parentElement) {
        const b = getComputedStyle(n).backgroundColor;
        if (!/, 0\)$/.test(b) && b !== 'transparent') {
          bg = b;
          break;
        }
      }
      out.push({ tag: el.tagName + '.' + el.className, color: cs.color, bg });
    }
    return out;
  });
  for (const r of rows) {
    const c = parse(r.color),
      b = parse(r.bg);
    const hi = Math.max(lum([c[0], c[1], c[2]]), lum([b[0], b[1], b[2]]));
    const lo = Math.min(lum([c[0], c[1], c[2]]), lum([b[0], b[1], b[2]]));
    expect.soft((hi + 0.05) / (lo + 0.05), `${r.tag} ${r.color} on ${r.bg}`).toBeGreaterThan(4.5);
  }
});
