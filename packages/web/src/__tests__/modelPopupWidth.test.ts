// The model list is an absolutely positioned box hanging off a narrow pill. Left
// to shrink-to-fit it took the pill's width and wrapped "GPT-5.6-Terra · ChatGPT"
// into a column, and its overflow put a horizontal scrollbar across the page.
// jsdom has no layout, so this locks the rules in the source of `index.css`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string): string => {
  const m = new RegExp(`(?:^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  );
  if (!m) throw new Error(`no ${selector} rule`);
  return m[1] as string;
};

describe('model popup sizing', () => {
  it('sizes to its names, capped to the viewport, and never scrolls sideways', () => {
    const r = rule('.model-popup');
    expect(r).toMatch(/width:\s*max-content/);
    expect(r).toMatch(/max-width:\s*min\(360px, calc\(100vw - 32px\)\)/);
    expect(r).toMatch(/overflow-x:\s*hidden/);
  });
  it('keeps a model name on one line', () => {
    expect(rule('.model-option-name')).toMatch(/white-space:\s*nowrap/);
  });
});
