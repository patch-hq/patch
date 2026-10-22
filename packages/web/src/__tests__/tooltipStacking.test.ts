// A tooltip names a control wherever it sits — including inside a context
// menu, the annotator or a confirm modal. It must stack above every app
// overlay or it is drawn behind the very control it describes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function zIndexByRule(): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const z = /z-index:\s*(\d+)/.exec(m[2]!);
    if (z) out.set(m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim(), Number(z[1]));
  }
  return out;
}

describe('app tooltip stacking', () => {
  it('sits above every app overlay', () => {
    const rules = zIndexByRule();
    const tooltip = rules.get('.app-tooltip');
    expect(tooltip).toBeDefined();
    for (const [sel, z] of rules) {
      if (sel === '.app-tooltip' || sel.startsWith('.dev-')) continue;
      expect(tooltip!, `${sel} (${z})`).toBeGreaterThan(z);
    }
  });
});
