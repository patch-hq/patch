import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not apply the stylesheet, so the rule is checked in the source:
// `button.nav-row` must not use the `font` shorthand, which resets font-size
// and made the Files button larger than the Pads/Jobs/Settings links.
describe('sidebar nav row sizing', () => {
  it('button.nav-row does not reset font-size', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    const rule = /(^|\n)button\.nav-row\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![2]).not.toMatch(/(^|[\s;])font\s*:/);
  });
});
