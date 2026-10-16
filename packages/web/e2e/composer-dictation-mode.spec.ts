import { test, expect } from '@playwright/test';

// Real-browser e2e for dictation mode (spec/07 § Dictation mode): right-click
// the mic and it stays open; going quiet for a few seconds transcribes what was
// said and sends it, and the mic is still listening afterwards. Only the
// hardware boundary is stubbed: getUserMedia returns a REAL MediaStream from
// Web Audio — a tone for the first second ("speech"), then silence. The
// recorder, the segmenter and the composer all run for real.
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

test.describe('composer dictation mode', () => {
  test('right-click keeps the mic open; a quiet gap transcribes the utterance and it keeps listening', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(TONE_THEN_SILENCE);
    let transcribed = 0;
    await page.route('**/api/voice/transcribe*', (r) => {
      transcribed++;
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'hello from dictation mode' }),
      });
    });

    await page.goto('/app/dev-harness.html?chat=thread_manager');
    const mic = page.getByTestId('voice-note-btn');
    await mic.click({ button: 'right' });
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dictation-mode-status')).toBeVisible();

    // Not before the pause is long enough…
    await page.waitForTimeout(2000);
    expect(transcribed).toBe(0);
    // …then the utterance is cut and transcribed.
    await expect.poll(() => transcribed, { timeout: 15_000 }).toBe(1);
    // Still open and listening.
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dictation-mode-status')).toBeVisible();

    // Esc ends it.
    await page.getByTestId('composer-input').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dictation-mode-status')).toHaveCount(0);
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
  });
});
