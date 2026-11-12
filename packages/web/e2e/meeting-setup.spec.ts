import { test, expect, type Page } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Meeting permissions (lib/meetingSetup.ts, components/MeetingSetup.tsx) against a
// stand-in desktop bridge: `window.patch` reports and grants the three macOS
// permissions the way the shell does, and records what was asked.

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

const URL = '/app/dev-harness.html?chat=chat_tools';

type Perms = Record<
  'microphone' | 'callAudio' | 'accessibility',
  'granted' | 'missing' | 'unknown'
>;

async function fakeShell(page: Page, perms: Perms) {
  await page.addInitScript(
    ({ perms }) => {
      const state = { ...perms };
      const calls: string[] = [];
      (window as unknown as { __shellCalls: string[] }).__shellCalls = calls;
      (window as unknown as { patch: object }).patch = {
        getMeetingPermissions: async () => ({ ...state }),
        requestMeetingPermission: async (kind: keyof typeof state) => {
          calls.push(`request:${kind}`);
          state[kind] = 'granted';
          return 'granted';
        },
        startSystemAudio: async () => {
          calls.push('startSystemAudio');
        },
        stopSystemAudio: () => {},
        onSystemAudio: () => () => {},
        startMeetingSpeakers: () => {
          calls.push('startMeetingSpeakers');
        },
        stopMeetingSpeakers: () => {},
        onMeetingSpeakers: () => () => {},
      };
    },
    { perms },
  );
}

const shellCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls);
const sent = (page: Page, type: string) =>
  page.evaluate(
    (t) =>
      (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent.filter(
        (e) => e.type === t,
      ),
    type,
  );

test('nothing is asked before Meeting is pressed: the popover opens on the button, anchored above it', async ({
  page,
}) => {
  await fakeShell(page, { microphone: 'granted', callAudio: 'unknown', accessibility: 'missing' });
  await page.goto(URL);
  await page.waitForSelector('[data-testid=composer]');
  await page.waitForTimeout(800);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  await page.getByTestId('meeting-btn').click();
  const pop = page.getByTestId('meeting-setup');
  await expect(pop).toHaveAttribute('data-mode', 'start');
  await expect(pop.getByTestId('meeting-perm-microphone')).toContainText('✓ Allowed');
  await expect(pop.getByTestId('meeting-perm-allow-callAudio')).toBeVisible();
  const [p, b] = await Promise.all([
    pop.boundingBox(),
    page.getByTestId('meeting-btn').boundingBox(),
  ]);
  expect(p!.y + p!.height).toBeLessThanOrEqual(b!.y);
  expect(p!.x).toBeLessThanOrEqual(b!.x);
  await page.getByTestId('meeting-setup-close').click();
  await expect(pop).toHaveCount(0);
});

test('Allow asks the shell for that permission and the row turns Allowed', async ({ page }) => {
  await fakeShell(page, { microphone: 'granted', callAudio: 'unknown', accessibility: 'missing' });
  await page.goto(URL);
  await page.getByTestId('meeting-btn').click();
  await page.getByTestId('meeting-perm-allow-callAudio').click();
  await expect(page.getByTestId('meeting-perm-callAudio')).toContainText('✓ Allowed');
  expect(await shellCalls(page)).toEqual(['request:callAudio']);
});

test('nothing to set up: no popover, and Meeting starts at once', async ({ page }) => {
  await fakeShell(page, { microphone: 'granted', callAudio: 'granted', accessibility: 'granted' });
  await page.goto(URL);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  await page.getByTestId('meeting-btn').click();
  await expect.poll(async () => (await sent(page, 'meeting.control_request')).length).toBe(1);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  expect(await shellCalls(page)).toEqual(['startSystemAudio', 'startMeetingSpeakers']);
});

test('pressing Meeting with Accessibility missing shows what is missing, and can start without names', async ({
  page,
}) => {
  await fakeShell(page, { microphone: 'granted', callAudio: 'granted', accessibility: 'missing' });
  await page.goto(URL);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  await page.getByTestId('meeting-btn').click();
  const pop = page.getByTestId('meeting-setup');
  await expect(pop).toHaveAttribute('data-mode', 'start');
  await expect(pop.getByTestId('meeting-perm-accessibility')).toContainText(
    'Without it, speakers show as Unknown',
  );
  await expect(pop.getByTestId('meeting-setup-start')).toBeDisabled();
  expect(await sent(page, 'meeting.control_request')).toHaveLength(0);
  await pop.getByTestId('meeting-start-without-names').click();
  await expect.poll(async () => (await sent(page, 'meeting.control_request')).length).toBe(1);
  await expect(pop).toHaveCount(0);
  // no speaker watch, so no "Speaker names unavailable" error either
  expect(await shellCalls(page)).toEqual(['startSystemAudio']);
});

test('the microphone missing at start: Start waits until it is allowed', async ({ page }) => {
  await fakeShell(page, { microphone: 'missing', callAudio: 'granted', accessibility: 'granted' });
  await page.goto(URL);
  await page.getByTestId('meeting-btn').click();
  const pop = page.getByTestId('meeting-setup');
  await expect(pop.getByTestId('meeting-start-without-names')).toHaveCount(0);
  await expect(pop.getByTestId('meeting-setup-start')).toBeDisabled();
  await pop.getByTestId('meeting-perm-allow-microphone').click();
  await expect(pop.getByTestId('meeting-setup-start')).toBeEnabled();
  await pop.getByTestId('meeting-setup-start').click();
  await expect.poll(async () => (await sent(page, 'meeting.control_request')).length).toBe(1);
});

test('starting without names is remembered: the next Meeting press starts without asking', async ({
  page,
}) => {
  await fakeShell(page, { microphone: 'granted', callAudio: 'granted', accessibility: 'missing' });
  await page.goto(URL);
  await page.getByTestId('meeting-btn').click();
  await page.getByTestId('meeting-start-without-names').click();
  await expect.poll(async () => (await sent(page, 'meeting.control_request')).length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('patch.meetingNamesDeclined'))).toBe('1');
  await page.reload();
  await page.waitForSelector('[data-testid=composer]');
  await page.getByTestId('meeting-btn').click();
  await expect.poll(async () => (await sent(page, 'meeting.control_request')).length).toBe(1);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
});

test('Settings → Voice toggle: off remembers a decline, on asks for Accessibility again', async ({
  page,
}) => {
  await fakeShell(page, { microphone: 'granted', callAudio: 'granted', accessibility: 'missing' });
  await page.addInitScript(() => localStorage.setItem('patch.meetingNamesDeclined', '1'));
  await stubSettingsApi(page);
  await page.goto(settingsUrl('voice'));
  const toggle = page.getByTestId('meeting-names-toggle');
  await expect(toggle).not.toBeChecked();
  await page.getByTestId('meeting-names-row').locator('.toggle-track').click();
  await expect.poll(() => shellCalls(page)).toEqual(['request:accessibility']);
  await expect(toggle).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('patch.meetingNamesDeclined'))).toBeNull();
  await page.getByTestId('meeting-names-row').locator('.toggle-track').click();
  expect(await page.evaluate(() => localStorage.getItem('patch.meetingNamesDeclined'))).toBe('1');
});
