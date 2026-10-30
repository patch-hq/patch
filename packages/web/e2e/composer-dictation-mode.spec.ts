import { test, expect, type Page } from '@playwright/test';

// Real-browser e2e for dictation mode (spec/07 § Dictation mode): right-click
// the mic → Keep dictating and it stays open; once the speaker has finished,
// what they said is transcribed and sent, and the mic is still listening
// afterwards. Only the hardware boundary and the server are stubbed:
// getUserMedia returns a REAL MediaStream from Web Audio — a tone for the first
// second ("speech"), then silence — and the routes answer canned replies. The
// recorder, the segmenter, the turn check and the composer all run for real.
const TONE_THEN_SILENCE = `
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    osc.connect(gain).connect(dest);
    osc.start();
    setTimeout(() => osc.stop(), 1000);
    return dest.stream;
  };
`;

async function open(
  page: Page,
  prefs: { dictationPauseSeconds: number; dictationTurnDetection: boolean },
): Promise<void> {
  await page.goto('/app/dev-harness.html?chat=thread_manager');
  await page.evaluate((p) => {
    const store = (
      window as unknown as {
        __preferencesStore: {
          getState(): { preferences: Record<string, unknown> };
          setState(s: unknown): void;
        };
      }
    ).__preferencesStore;
    store.setState({ preferences: { ...store.getState().preferences, ...p } });
  }, prefs);
}

async function keepDictating(page: Page): Promise<void> {
  await page.getByTestId('voice-note-btn').click({ button: 'right' });
  await page.getByText('Keep dictating').click();
  await expect(page.getByTestId('dictation-mode-status')).toBeVisible();
}

function countTranscribes(page: Page, transcript = 'hello from dictation mode'): () => number {
  let n = 0;
  void page.route('**/api/voice/transcribe*', (r) => {
    n++;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ transcript }),
    });
  });
  return () => n;
}

test.describe('composer dictation mode', () => {
  test('right-click → Voice settings opens the Voice settings page', async ({ page }) => {
    await open(page, { dictationPauseSeconds: 3, dictationTurnDetection: false });
    await page.getByTestId('voice-note-btn').click({ button: 'right' });
    await page.getByText('Voice settings').click();
    await expect(page.getByTestId('settings-voice')).toBeVisible();
  });

  test('right-click → Keep dictating keeps the mic open; a quiet gap transcribes the utterance and it keeps listening', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(TONE_THEN_SILENCE);
    const transcribed = countTranscribes(page);
    await open(page, { dictationPauseSeconds: 3, dictationTurnDetection: false });

    // A right-click alone only offers it.
    const mic = page.getByTestId('voice-note-btn');
    await mic.click({ button: 'right' });
    await expect(page.getByTestId('mic-menu')).toBeVisible();
    await expect(page.getByTestId('dictation-mode-status')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await keepDictating(page);
    await expect(mic).toHaveAttribute('aria-pressed', 'true');

    // Not before the pause is long enough…
    await page.waitForTimeout(2000);
    expect(transcribed()).toBe(0);
    // …then the utterance is cut and transcribed.
    await expect.poll(transcribed, { timeout: 15_000 }).toBe(1);
    // Still open and listening.
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dictation-mode-status')).toBeVisible();

    // Esc ends it.
    await page.getByTestId('composer-input').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dictation-mode-status')).toHaveCount(0);
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
  });

  test('a shorter pause set in Settings sends sooner', async ({ page }) => {
    test.setTimeout(30_000);
    await page.addInitScript(TONE_THEN_SILENCE);
    const transcribed = countTranscribes(page, 'quick one');
    await open(page, { dictationPauseSeconds: 1, dictationTurnDetection: false });
    await keepDictating(page);
    // One second of tone, then one second of quiet. The three-second pause
    // could not cut before four seconds.
    await expect.poll(transcribed, { timeout: 3_600 }).toBe(1);
  });

  test('with turn detection, a finished turn sends at the first short pause', async ({ page }) => {
    test.setTimeout(30_000);
    await page.addInitScript(TONE_THEN_SILENCE);
    const transcribed = countTranscribes(page, 'finished thought');
    let checks = 0;
    await page.route('**/api/voice/turn-check*', (r) => {
      checks++;
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, probability: 0.93 }),
      });
    });
    await open(page, { dictationPauseSeconds: 15, dictationTurnDetection: true });
    await keepDictating(page);
    // Well inside the 15 s backstop: the model's verdict sent it.
    await expect.poll(transcribed, { timeout: 4_000 }).toBe(1);
    expect(checks).toBe(1);
  });

  test('a failed turn check is shown, and the long pause still sends', async ({ page }) => {
    test.setTimeout(30_000);
    await page.addInitScript(TONE_THEN_SILENCE);
    const transcribed = countTranscribes(page);
    await page.route('**/api/voice/turn-check*', (r) =>
      r.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'daemon_timeout',
          message: 'the host did not answer the turn check — it may need updating',
        }),
      }),
    );
    await open(page, { dictationPauseSeconds: 3, dictationTurnDetection: true });
    await keepDictating(page);
    await expect(page.getByText(/turn check failed: the host did not answer/)).toBeVisible();
    expect(transcribed()).toBe(0);
    await expect.poll(transcribed, { timeout: 10_000 }).toBe(1);
  });
});
