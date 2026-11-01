import { test, expect } from '@playwright/test';

// spec/14 § Tools panel — each Patch tool's description is editable; the edit is
// written as the shared setting `toolPromptOverrides`.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test('a Patch tool prompt can be edited, saved as a shared setting, and reset', async ({
  page,
}) => {
  const writes: unknown[] = [];
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(body);
    const current = await page.evaluate(
      () =>
        (
          window as unknown as {
            __preferencesStore: { getState: () => { preferences: object } };
          }
        ).__preferencesStore.getState().preferences,
    );
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ preferences: { ...current, ...body } }),
    });
  });

  await page.goto(HARNESS);
  await page.getByTestId('action-more').click();
  await page.getByTestId('action-tools').click();

  await page.getByTestId('tool-prompt-edit-patch_peek').click();
  const input = page.getByTestId('tool-prompt-input-patch_peek');
  await expect(input).toHaveValue('Built-in peek description.');
  await input.fill('My peek description.');
  await page.getByTestId('tool-prompt-save-patch_peek').click();

  await expect(page.getByTestId('tool-prompt-edited-patch_peek')).toBeVisible();
  expect(writes).toEqual([{ toolPromptOverrides: { patch_peek: 'My peek description.' } }]);

  await page.getByTestId('tool-prompt-edit-patch_peek').click();
  await expect(page.getByTestId('tool-prompt-input-patch_peek')).toHaveValue(
    'My peek description.',
  );
  await page.getByTestId('tool-prompt-reset-patch_peek').click();
  await expect(page.getByTestId('tool-prompt-edited-patch_peek')).toHaveCount(0);
  expect(writes.at(-1)).toEqual({ toolPromptOverrides: {} });
});
