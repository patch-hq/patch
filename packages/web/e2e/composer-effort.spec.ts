import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// Real-browser e2e (dev harness, real Composer + real CSS, no backend) for the
// thinking-effort control in the composer's action row, beside the model
// control (spec/04 § Effort, spec/14 § Composer — Effort control). Unlike the
// model picker there is no catalogue to mock: the five levels are fixed.

test.describe('composer effort', () => {
  test('sits in the composer row beside the model control, for a Claude chat', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const effort = page.getByTestId('chat-effort');
    await expect(effort).toBeVisible();
    await expect(effort).toContainText('Default');

    const model = (await page.getByTestId('chat-model').boundingBox())!;
    const effortBox = (await effort.boundingBox())!;
    const send = (await page.getByTestId('send-btn').boundingBox())!;
    // After the model control, before Send, on the row's one centre line.
    expect(effortBox.x).toBeGreaterThanOrEqual(model.x + model.width);
    expect(effortBox.x + effortBox.width).toBeLessThanOrEqual(send.x);
    expect(Math.abs(effortBox.y + effortBox.height / 2 - (send.y + send.height / 2))).toBeLessThan(
      2,
    );
  });

  test('renders no effort control for a chat with no known model', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-effort')).toHaveCount(0);
  });

  test('opens a list of fixed levels plus Default, with the turn-applies note', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-effort').click();
    const popup = page.getByTestId('effort-popup');
    await expect(popup).toBeVisible();
    await expect(page.getByTestId('effort-option-default')).toBeVisible();
    await expect(page.getByTestId('effort-option-low')).toBeVisible();
    await expect(page.getByTestId('effort-option-medium')).toBeVisible();
    await expect(page.getByTestId('effort-option-high')).toBeVisible();
    await expect(page.getByTestId('effort-option-xhigh')).toBeVisible();
    await expect(page.getByTestId('effort-option-max')).toBeVisible();
    await expect(page.getByTestId('effort-popup-note')).toBeVisible();
    // Default is selected to start (chat_bus has no effort override).
    await expect(page.getByTestId('effort-option-default')).toHaveClass(/selected/);
  });

  test('choosing a level sends chat.effort_request and shows the choice as pending', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-effort').click();
    await page.getByTestId('effort-option-high').click();

    await expect(page.getByTestId('effort-popup')).toHaveCount(0);
    const sent = await page.evaluate(
      () => (window as unknown as { __wsSent: WireEvent[] }).__wsSent,
    );
    expect(
      sent.filter(
        (e) => (e as { type: string }).type === 'chat.effort_request',
      ) as unknown as Array<{ chatId: string; effort: string | null }>,
    ).toEqual([{ type: 'chat.effort_request', chatId: 'chat_bus', effort: 'high' }]);

    // The harness has no host to answer, so the pill stays visibly unsettled —
    // it reads the choice, marked pending, never as an accomplished switch.
    const pill = page.getByTestId('chat-effort');
    await expect(pill).toContainText('High');
    await expect(pill).toHaveClass(/is-pending/);
  });

  test('choosing Default after a level sends effort: null', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-effort').click();
    await page.getByTestId('effort-option-max').click();
    await page.getByTestId('chat-effort').click();
    await page.getByTestId('effort-option-default').click();

    const sent = await page.evaluate(
      () => (window as unknown as { __wsSent: WireEvent[] }).__wsSent,
    );
    const effortRequests = sent.filter(
      (e) => (e as { type: string }).type === 'chat.effort_request',
    ) as unknown as Array<{ chatId: string; effort: string | null }>;
    expect(effortRequests.at(-1)).toEqual({
      type: 'chat.effort_request',
      chatId: 'chat_bus',
      effort: null,
    });
  });
});
