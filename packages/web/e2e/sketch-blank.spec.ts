import { test, expect } from '@playwright/test';

// Sketch without a photo: the composer's sketch button opens the annotator on a
// blank white page, and Done attaches the drawing as a new PNG. Real canvas and
// toBlob, which jsdom can't back (unit coverage is in ImageAnnotator.test.tsx).

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('Sketch without a photo', () => {
  test('sketch button opens a blank page; drawing and Done attach a sketch PNG', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('composer-add-btn').click();
    await page.getByTestId('add-menu-sketch').click();
    await expect(page.getByTestId('image-annotator')).toBeVisible();

    const canvas = page.getByTestId('annotator-canvas');
    const box = (await canvas.boundingBox())!;
    expect(box.width).toBeGreaterThan(200);

    // Blank page starts white.
    const corner = await canvas.evaluate((c: HTMLCanvasElement) =>
      Array.from(c.getContext('2d')!.getImageData(2, 2, 1, 1).data),
    );
    expect(corner).toEqual([255, 255, 255, 255]);

    await page.getByLabel('Freehand tool').click();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByLabel('Undo last mark')).toBeEnabled();

    await page.getByTestId('annotator-done').click();
    await expect(page.getByTestId('image-annotator')).toBeHidden();
    const chip = page.getByTestId('composer-attachment');
    await expect(chip.locator('.att-name')).toHaveText(/^sketch-\d+\.png$/);
  });
});
