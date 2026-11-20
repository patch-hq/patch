import { test, expect, type Page } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

/** The pill currently chosen in a Pills group. */
async function chosen(page: Page, testid: string): Promise<string> {
  return page.getByTestId(testid).locator('button[aria-pressed="true"]').innerText();
}

/** Wait for a Pills group to settle on `label` — a click re-renders the group, so
 *  reading the chosen pill straight after one can see the old choice. */
async function expectChosen(page: Page, testid: string, label: string): Promise<void> {
  await expect.poll(() => chosen(page, testid)).toBe(label);
}

// Real-browser e2e for Settings → Voice (spec/07 § Voice): ONE config for
// every voice conversation — calls, hands-free and voice devices — a provider,
// its model and voice, and the hand-off switch; Local nests what reads the
// replies out. Dictation lists every device with its own engine.
test.describe('Settings — Voice', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('voice'));
    await expect(page.getByTestId('settings-voice-config')).toBeVisible();
  });

  test('one provider choice, named for people, with Local the default', async ({ page }) => {
    await expect(page.getByTestId('voice-engine').locator('button')).toHaveText([
      'Local',
      'Gemini',
      'OpenAI',
      'ElevenLabs',
    ]);
    await expectChosen(page, 'voice-engine', 'Local');
    // Local nests what reads the replies out.
    await expect(page.getByTestId('voice-local-tts')).toBeVisible();
    await expect(page.getByTestId('kokoro-voice')).toBeVisible();
    await expect(page.getByText(/\b(direct|light|heavy)\b/)).toHaveCount(0);
    // No per-surface rows, no chat title, no "Speaking" section.
    for (const surface of ['device', 'handsFree', 'call']) {
      await expect(page.getByTestId(`voice-${surface}-engine`)).toHaveCount(0);
    }
    await expect(page.getByText('Speaking', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('chat-name-interval')).toHaveCount(0);
  });

  test('a hosted provider: model, its own voice, and the hand-off switch', async ({ page }) => {
    await page.getByTestId('voice-engine-gemini').click();
    await expectChosen(page, 'voice-engine', 'Gemini');
    await page.getByTestId('voice-variant-heavy').click();
    await expectChosen(page, 'voice-variant', 'Thinking');
    await expect(page.getByTestId('voice-gemini-voice')).toBeVisible();
    await expect(page.getByTestId('voice-handoff-toggle')).toBeChecked();
    await page.getByTestId('voice-engine-openai').click();
    await expectChosen(page, 'voice-variant', 'full');
    await expect(page.getByTestId('voice-openai-voice')).toBeVisible();
    await expect(page.getByTestId('voice-gemini-voice')).toHaveCount(0);
  });

  test('row labels stay readable at phone width — chips sit under the label', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByTestId('voice-engine-elevenlabs').click();
    const title = page.getByTestId('voice-provider').locator('.set-row-title');
    const box = await title.boundingBox();
    expect(box!.width).toBeGreaterThan(40);
    expect(box!.height).toBeLessThan(30);
    const handoff = page.getByTestId('voice-handoff-row');
    await expect(handoff).toContainText('Pass work to the chat’s agent');
    expect((await handoff.locator('.set-row-title').boundingBox())!.height).toBeLessThan(60);
  });

  test('usage is one account-wide summary in tokens and credits, not dollars per host', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __presenceStore: {
            getState(): {
              hosts: Record<string, { host: Record<string, unknown> | null }>;
              setHostReport(r: Record<string, unknown>): void;
            };
          };
        }
      ).__presenceStore;
      const host = store.getState().hosts['d1']!.host!;
      store.getState().setHostReport({
        ...host,
        type: 'host.host',
        voiceUsage: {
          monthUsd: 0.0412,
          monthCalls: 3,
          allUsd: 1.5,
          allCalls: 40,
          monthTokens: 12000,
          allTokens: 90000,
          monthCredits: 7400,
          allCredits: 41304,
          elevenLabsPlan: { used: 41304, limit: 185575 },
        },
      });
    });
    await expect(page.getByTestId('voice-usage-month')).toContainText(
      '3 calls · 12,000 tokens · 7,400 ElevenLabs credits',
    );
    await expect(page.getByTestId('voice-usage-plan')).toContainText(
      '41,304 of 185,575 credits used',
    );
    await expect(page.getByTestId('voice-usage')).not.toContainText('$');
  });

  test('a hosted provider whose key the host lacks says so, as an error', async ({ page }) => {
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __presenceStore: {
            getState(): {
              hosts: Record<string, { host: Record<string, unknown> | null }>;
              setHostReport(r: Record<string, unknown>): void;
            };
          };
        }
      ).__presenceStore;
      const host = store.getState().hosts['d1']!.host!;
      store.getState().setHostReport({
        ...host,
        type: 'host.host',
        voiceKeys: { gemini: false, openai: true, deepgram: false },
      });
    });
    await page.getByTestId('voice-engine-gemini').click();
    const line = page.getByTestId('voice-keys');
    await expect(line).toHaveText(
      'Not configured on dev-host: no Gemini key is set. Sessions there are refused.',
    );
    const color = await line.evaluate((el) => getComputedStyle(el).color);
    const hint = await line.evaluate(
      (el) => getComputedStyle(el.closest('.set-sub') as HTMLElement).color,
    );
    expect(color).not.toBe(hint);
    await page.getByTestId('voice-engine-openai').click();
    await expect(page.getByTestId('voice-keys')).toHaveCount(0);
  });
});

test.describe('Settings — Dictation, one engine per device', () => {
  test('every device is listed with only the engines it can run', async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('dictation'));
    const row = page.getByTestId('dictation-device-web-1');
    await expect(row).toContainText('This device');
    await expect(page.getByTestId('dictation-device-web-1-engine').locator('button')).toHaveText([
      'Deepgram',
      'ElevenLabs',
      'Host server',
      'Whisper',
    ]);
    await expectChosen(page, 'dictation-device-web-1-engine', 'Whisper');
    await page.getByTestId('dictation-device-web-1-engine-deepgram').click();
    await expectChosen(page, 'dictation-device-web-1-engine', 'Deepgram');
  });

  test('Meetings has its own page', async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('meetings'));
    await expect(page.getByTestId('meeting-engine-pills')).toBeVisible();
    await page.getByTestId('settings-nav-dictation').click();
    await expect(page.getByTestId('meeting-engine-pills')).toHaveCount(0);
  });
});
