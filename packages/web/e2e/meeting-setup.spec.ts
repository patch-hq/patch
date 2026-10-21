import { test, expect, type Page } from '@playwright/test';

// Meeting permissions are asked for ahead of a meeting (components/MeetingSetup.tsx):
// a first-run card, then a check when Start is pressed. The spec plays the
// desktop shell's side through a stub `window.patch`.

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function stubShell(page: Page, perms: Record<string, boolean>): Promise<void> {
  await page.addInitScript((initial) => {
    const state = { ...initial };
    (window as unknown as { __shell: unknown }).__shell = { state, requests: [] as string[] };
    (window as unknown as { patch: unknown }).patch = {
      getMeetingPermissions: async () => ({ ...state }),
      requestMeetingPermission: async (kind: string) => {
        (window as unknown as { __shell: { requests: string[] } }).__shell.requests.push(kind);
        (state as Record<string, boolean>)[kind] = true;
        return { ...state };
      },
      startSystemAudio: async () => {},
      stopSystemAudio: () => {},
      onSystemAudio: () => () => {},
    };
  }, perms);
}

const URL = '/app/dev-harness.html?chat=chat_tools';
const sentTypes = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent.map((e) => e.type),
  );

test.describe('meeting permissions ahead of the meeting', () => {
  test('first run shows the card, Allow fills a row in, Not now is remembered', async ({
    page,
  }) => {
    await stubShell(page, { microphone: true, callAudio: false, accessibility: false });
    await page.goto(URL);
    const card = page.getByTestId('meeting-setup');
    await expect(card).toHaveAttribute('data-mode', 'first-run', { timeout: 45_000 });
    await expect(page.getByTestId('meeting-perm-microphone')).toContainText('Allowed');
    await page.getByTestId('meeting-allow-callAudio').click();
    await expect(page.getByTestId('meeting-perm-callAudio')).toContainText('Allowed');
    await page.getByTestId('meeting-setup-dismiss').click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  });

  test('Start with Accessibility missing opens the popover and does not start', async ({
    page,
  }) => {
    await stubShell(page, { microphone: true, callAudio: true, accessibility: false });
    await page.addInitScript(() => localStorage.setItem('patch.meeting.setupDismissed', '1'));
    await page.goto(URL);
    await page.getByTestId('meeting-btn').click();
    await expect(page.getByTestId('meeting-setup')).toHaveAttribute('data-mode', 'start');
    await expect(page.getByTestId('meeting-start')).toBeDisabled();
    expect(await sentTypes(page)).not.toContain('meeting.control_request');
    await page.getByTestId('meeting-allow-accessibility').click();
    await expect(page.getByTestId('meeting-start')).toBeEnabled();
    await page.getByTestId('meeting-start').click();
    await expect.poll(() => sentTypes(page)).toContain('meeting.control_request');
  });

  test('Start without names starts the meeting with Accessibility still missing', async ({
    page,
  }) => {
    await stubShell(page, { microphone: true, callAudio: true, accessibility: false });
    await page.addInitScript(() => localStorage.setItem('patch.meeting.setupDismissed', '1'));
    await page.goto(URL);
    await page.getByTestId('meeting-btn').click();
    await page.getByTestId('meeting-start-without-names').click();
    await expect.poll(() => sentTypes(page)).toContain('meeting.control_request');
    const asked = await page.evaluate(
      () => (window as unknown as { __shell: { requests: string[] } }).__shell.requests,
    );
    expect(asked).toEqual([]);
  });

  test('with everything allowed there is no card and Start goes straight through', async ({
    page,
  }) => {
    await stubShell(page, { microphone: true, callAudio: true, accessibility: true });
    await page.goto(URL);
    await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
    await page.getByTestId('meeting-btn').click();
    await expect.poll(() => sentTypes(page)).toContain('meeting.control_request');
    await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  });
});
