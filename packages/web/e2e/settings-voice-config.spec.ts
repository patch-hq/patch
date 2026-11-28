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

/** Merge `extra` into host d1's report, as a host's next `host.host` would. */
async function reportHost(page: Page, extra: Record<string, unknown>): Promise<void> {
  await page.evaluate((patch) => {
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
    store.getState().setHostReport({ ...host, type: 'host.host', ...patch });
  }, extra);
}

/** What a host read from each provider (spec/07 § The voice agent). */
const CATALOG = {
  voiceKeys: { gemini: true, openai: true, elevenlabs: true, deepgram: false },
  voiceCatalog: {
    gemini: {
      at: 1,
      models: [
        {
          id: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
          label: 'Gemini 2.5 Flash Native Audio',
        },
      ],
      voices: [
        { id: 'Puck', label: 'Puck' },
        { id: 'Kore', label: 'Kore' },
      ],
    },
    openai: {
      at: 1,
      models: [{ id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini' }],
      voices: [{ id: 'marin', label: 'marin' }],
    },
    elevenlabs: {
      at: 1,
      models: [{ id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' }],
      voices: [{ id: 'v-rachel', label: 'Rachel' }],
      speechModels: [{ id: 'eleven_v3_conversational', label: 'Eleven v3 conversational' }],
    },
  },
};

// Real-browser e2e for Settings → Voice calls (spec/14 § Voice): the voice
// agent revealed one choice at a time — provider, model, voice, then only that
// provider's sound controls — then Agents calling you and Calls.
test.describe('Settings — Voice calls', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('voice'));
    await expect(page.getByTestId('settings-voice-agent')).toBeVisible();
  });

  test('three providers, no Local; each choice appears once the one before is made', async ({
    page,
  }) => {
    await expect(page.getByTestId('voice-agent-provider').locator('button')).toHaveText([
      'Gemini',
      'OpenAI',
      'ElevenLabs',
    ]);
    await expectChosen(page, 'voice-agent-provider', 'Gemini');
    await reportHost(page, CATALOG);
    await expect(page.getByTestId('voice-agent-model-status')).toContainText('1 model');
    await expect(page.getByTestId('voice-agent-sound')).toHaveCount(0);
    await page.getByTestId('voice-agent-voice').selectOption('Kore');
    await expect(page.getByTestId('voice-agent-sound')).toBeVisible();
    await expect(page.getByTestId('voice-agent-tone')).toBeVisible();
    await expect(page.getByTestId('voice-agent-matchTone')).toBeAttached();
    await expect(page.getByTestId('voice-agent-stability')).toHaveCount(0);
  });

  test('ElevenLabs shows its own controls with calm defaults; OpenAI only tone and speed', async ({
    page,
  }) => {
    await reportHost(page, CATALOG);
    await page.getByTestId('voice-agent-provider-elevenlabs').click();
    await expectChosen(page, 'voice-agent-provider', 'ElevenLabs');
    await page.getByTestId('voice-agent-voice').selectOption('v-rachel');
    await expect(page.getByTestId('voice-agent-stability-value')).toHaveText('0.7');
    await expect(page.getByTestId('voice-agent-speed-value')).toHaveText('0.95×');
    await expect(page.getByTestId('voice-agent-stability-row')).toContainText('Expressive');
    await expect(page.getByTestId('voice-agent-stability-row')).toContainText('Steady');
    await expectChosen(page, 'voice-agent-eagerness', 'Patient');
    await page.getByTestId('voice-agent-provider-openai').click();
    await expectChosen(page, 'voice-agent-provider', 'OpenAI');
    await expect(page.getByTestId('voice-agent-speed-value')).toHaveText('1×');
    await expect(page.getByTestId('voice-agent-stability')).toHaveCount(0);
    await expect(page.getByTestId('voice-agent-eagerness')).toHaveCount(0);
  });

  test('Agents calling you and Calls', async ({ page }) => {
    await expect(page.getByTestId('agents-can-call-row')).toContainText('Rings every device');
    await expect(page.getByTestId('agent-call-auto-answer-row')).toContainText(
      'Pauses playback while the agent talks',
    );
    await expect(page.getByTestId('pause-when-quiet').locator('button')).toHaveText([
      'Off',
      '2 min',
      '5 min',
      '10 min',
      '30 min',
    ]);
    await expectChosen(page, 'pause-when-quiet', 'Off');
    await page.getByTestId('pause-when-quiet-5').click();
    await expectChosen(page, 'pause-when-quiet', '5 min');
  });

  test('row labels stay readable at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await reportHost(page, CATALOG);
    await page.getByTestId('voice-agent-provider-elevenlabs').click();
    await page.getByTestId('voice-agent-voice').selectOption('v-rachel');
    for (const row of [
      'voice-provider',
      'voice-agent-eagerness-row',
      'voice-agent-stability-row',
    ]) {
      const box = await page.getByTestId(row).locator('.set-row-title').boundingBox();
      expect(box!.width).toBeGreaterThan(40);
      expect(box!.height).toBeLessThan(30);
    }
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
    const line = page.getByTestId('voice-keys');
    await expect(line).toHaveText(
      'Not configured on dev-host: no Gemini key is set. Sessions there are refused.',
    );
    const color = await line.evaluate((el) => getComputedStyle(el).color);
    const hint = await line.evaluate(
      (el) => getComputedStyle(el.closest('.set-sub') as HTMLElement).color,
    );
    expect(color).not.toBe(hint);
    await page.getByTestId('voice-agent-provider-openai').click();
    await expect(page.getByTestId('voice-keys')).toHaveCount(0);
  });
});

test.describe('Settings — Direct calls', () => {
  const mac = {
    surfaceId: 'mac-1',
    surfaceKind: 'desktop',
    label: 'MacBook Pro',
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: true,
    speechEngines: {
      stt: [
        { engine: 'parakeet', where: 'device', models: ['parakeet-tdt-0.6b-v3'] },
        { engine: 'groq', where: 'cloud', models: ['whisper-large-v3-turbo'] },
      ],
      tts: [
        { engine: 'kokoro', where: 'device', models: ['kokoro-82m'], voices: ['af_heart'] },
        {
          engine: 'elevenlabs',
          where: 'cloud',
          models: ['eleven_flash_v2_5'],
          voices: ['v-rachel'],
        },
      ],
    },
  };
  const linux = {
    surfaceId: 'linux-1',
    surfaceKind: 'web',
    label: 'Linux laptop',
    status: 'offline',
    lastHeartbeat: 1,
    isCurrent: false,
    speechEngines: { stt: [], tts: [] },
  };

  test('one setup for every device: pick each step, see what this device runs', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page, {
      payload: { devices: [mac, linux] },
      preferences: {},
    });
    await page.goto(settingsUrl('voice'));
    await expect(page.getByTestId('direct-stt').locator('button')).toHaveText([
      'On device',
      'Groq Whisper',
    ]);
    await expect(page.getByTestId('direct-tts')).toHaveCount(0);
    await page.getByTestId('direct-stt-device').click();
    await expect.poll(() => server.patches.length).toBe(1);
    expect(server.patches[0]).toEqual({ directCall: { stt: { engine: 'device' } } });
    await page.getByTestId('direct-tts-elevenlabs').click();
    await expect.poll(() => server.patches.length).toBe(2);
    expect(server.patches[1]).toEqual({
      directCall: { stt: { engine: 'device' }, tts: { engine: 'elevenlabs' } },
    });
    await page.getByTestId('direct-tts-model').selectOption('eleven_flash_v2_5');
    await page.getByTestId('direct-voice').selectOption('v-rachel');
    await expect(page.getByTestId('direct-summary')).toHaveText('Parakeet → ElevenLabs');
    await expect(page.getByTestId('direct-stability')).toBeVisible();
    // No device-by-device list.
    await expect(page.getByTestId('direct-linux-1-row')).toHaveCount(0);
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
