// Capture a real Settings page (it needs the e2e API stub, so it runs as a
// Playwright test). Copy into packages/web/e2e/, then:
//   PATCH_PW_PORT=5201 KIT_PAGE=voice KIT_OUT=<out-dir> npx playwright test e2e/capture-settings.spec.ts
// and delete the copy afterwards.
import { test } from '@playwright/test';
import fs from 'node:fs';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

test('capture settings', async ({ page }) => {
  const pageId = process.env.KIT_PAGE ?? 'voice';
  const out = process.env.KIT_OUT!;
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubSettingsApi(page);
  await page.goto(settingsUrl(pageId as never));
  await page.locator('.set-page').waitFor();
  await page.waitForTimeout(800);
  fs.mkdirSync(`${out}/_src`, { recursive: true });
  fs.writeFileSync(`${out}/_src/settings.html`, await page.evaluate(() => document.body.innerHTML));
});
