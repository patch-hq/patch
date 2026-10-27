import { test, expect } from '@playwright/test';
import { stubSettingsApi } from './settingsHarness.js';

// Transcript furniture reads in the prose face at the prose size: tool rows and
// inline code once rendered in a different size / the UA monospace family next
// to the surrounding message text.

test('inline code and tool rows share the prose font family and size', async ({ page }) => {
  await stubSettingsApi(page, {});
  await page.goto('/app/dev-harness.html?chat=new');
  const m = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="md"><p id="p">text <code class="md-inline-code" id="c">code</code></p></div>' +
      '<div class="tool-call" id="t"><button class="tool-summary">Checked runs</button></div>';
    document.body.appendChild(host);
    const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
    return {
      pFamily: cs('p').fontFamily,
      pSize: cs('p').fontSize,
      cFamily: cs('c').fontFamily,
      tFamily: cs('t').fontFamily,
      tSize: cs('t').fontSize,
    };
  });
  expect(m.cFamily).toBe(m.pFamily);
  expect(m.tFamily).toBe(m.pFamily);
  expect(m.tSize).toBe(m.pSize);
});
