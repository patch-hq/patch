import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not apply the stylesheet, so the rule is checked in the source:
// the meta strip (time / host / model) is hidden with opacity, which leaves it
// selectable, so copying a message copied the metadata too.
describe('message meta strip', () => {
  it('is not selectable, so it never joins a copied selection', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    const rule = /(^|\n)\.msg-meta\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![2]).toMatch(/user-select:\s*none/);
  });
});
