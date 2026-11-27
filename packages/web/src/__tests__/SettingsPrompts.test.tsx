// Every prompt Patch sends lives once, on the page for the feature it drives,
// each Default or Custom, with a way back to the default. The old Prompts
// address lands on the Agent page.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import {
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_MODEL,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  DEFAULT_LINK_SUMMARY_PROMPT,
  DEFAULT_MANAGER_VOICE_PROMPT,
  DEFAULT_QUESTION_EXPIRED_PROMPT,
  DEFAULT_VOICE_DEVICE_PROMPT,
  DEFAULT_MANAGER_PROMPT,
  DEFAULT_WATCH_CHECK_IN_PROMPT,
} from '@patch/wire';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '@patch/wire/jobs';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import { reportHost } from './presenceHelpers.js';
import {
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

const serve = () => {
  const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
  vi.stubGlobal('fetch', makeFetch({}, server.handler));
  return server;
};

describe('Settings prompts', () => {
  it('every prompt sits on its own page, showing its default and marked Default', async () => {
    serve();
    const shown = async (id: string): Promise<string | null> =>
      (await screen.findByTestId(`prompt-${id}-shown`)).textContent;
    const isDefault = (id: string): string | null =>
      screen.getByTestId(`prompt-${id}-mode-default`).getAttribute('aria-pressed');
    const pages: Array<[string, Array<[string, string]>]> = [
      [
        'agent',
        [
          ['question-expired', DEFAULT_QUESTION_EXPIRED_PROMPT],
          ['watch-check-in', DEFAULT_WATCH_CHECK_IN_PROMPT],
          ['job-autonomy', DEFAULT_JOB_AUTONOMY_PROMPT],
          ['link-summary', DEFAULT_LINK_SUMMARY_PROMPT],
        ],
      ],
      ['goals', [['goal-judge', DEFAULT_GOAL_EVAL_PROMPT]]],
      [
        'manager',
        [
          ['manager', DEFAULT_MANAGER_PROMPT],
          ['manager-voice', DEFAULT_MANAGER_VOICE_PROMPT],
        ],
      ],
      ['voice', [['voice-device', DEFAULT_VOICE_DEVICE_PROMPT]]],
      [
        'meetings',
        [
          ['meeting-now', DEFAULT_MEETING_NOW_PROMPT],
          ['meeting-notes', DEFAULT_MEETING_NOTES_PROMPT],
          ['meeting-actions', DEFAULT_MEETING_ACTIONS_PROMPT],
        ],
      ],
    ];
    for (const [page, prompts] of pages) {
      const view = renderSettings(`/settings/${page}`);
      for (const [id, text] of prompts) {
        expect(await shown(id)).toBe(text);
        expect(isDefault(id)).toBe('true');
      }
      view.unmount();
    }
  });

  it('the agent page also holds the Claude Code layers', async () => {
    serve();
    renderSettings('/settings/agent');
    expect(await screen.findByTestId('prompt-tools')).toBeTruthy();
    expect(screen.getByTestId('prompt-system-shown').textContent).toBe(
      "Claude Code's own system prompt.",
    );
  });

  it('the old Prompts address opens the Agent page', async () => {
    serve();
    renderSettings('/settings/prompts');
    expect(await screen.findByTestId('settings-agent')).toBeTruthy();
  });

  it('a long prompt starts folded and opens with Show all', async () => {
    serve();
    renderSettings('/settings/agent');
    const pre = await screen.findByTestId('prompt-question-expired-shown');
    expect(pre.className).toContain('folded');
    fireEvent.click(screen.getByTestId('prompt-question-expired-more'));
    expect(pre.className).not.toContain('folded');
  });

  it('an emptied tools guidance can be saved, and reads as Off', async () => {
    const server = serve();
    reportHost('d1', { harnessToolsPromptDefault: 'Use the patch tools.' });
    renderSettings('/settings/agent');
    fireEvent.click(await screen.findByTestId('prompt-tools-mode-custom'));
    fireEvent.change(screen.getByTestId('prompt-tools-text'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('prompt-tools-save'));
    await waitFor(() => expect(server.writes).toEqual([{ harnessToolsPrompt: '' }]));
  });

  it('writes the check-in interval, and ignores a value that is not a positive whole number', async () => {
    const server = serve();
    renderSettings('/settings/agent');
    const input = (await screen.findByTestId('watch-check-in-minutes')) as HTMLInputElement;
    expect(input.value).toBe('60');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.change(input, { target: { value: '15' } });
    await waitFor(() => expect(server.writes).toEqual([{ watchCheckInMinutes: 15 }]));
  });

  it('switches to Custom seeded with the default, saves, then goes back to the default', async () => {
    const server = serve();
    renderSettings('/settings/agent');
    fireEvent.click(await screen.findByTestId('prompt-watch-check-in-mode-custom'));
    const box = screen.getByTestId('prompt-watch-check-in-text') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT_WATCH_CHECK_IN_PROMPT);
    fireEvent.change(box, { target: { value: 'Still alive, {description}?' } });
    fireEvent.click(screen.getByTestId('prompt-watch-check-in-save'));
    await waitFor(() =>
      expect(server.writes).toEqual([{ watchCheckInPrompt: 'Still alive, {description}?' }]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('prompt-watch-check-in-shown').textContent).toBe(
        'Still alive, {description}?',
      ),
    );
    expect(
      screen.getByTestId('prompt-watch-check-in-mode-custom').getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByTestId('prompt-watch-check-in-mode-default'));
    await waitFor(() =>
      expect(server.writes[1]).toEqual({ watchCheckInPrompt: DEFAULT_WATCH_CHECK_IN_PROMPT }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('prompt-watch-check-in-shown').textContent).toBe(
        DEFAULT_WATCH_CHECK_IN_PROMPT,
      ),
    );
  });

  it('cancelling a switch to Custom writes nothing', async () => {
    const server = serve();
    renderSettings('/settings/manager');
    fireEvent.click(await screen.findByTestId('prompt-manager-mode-custom'));
    fireEvent.click(screen.getByTestId('prompt-manager-cancel'));
    expect(server.writes).toEqual([]);
    expect(screen.getByTestId('prompt-manager-mode-default').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('the Meetings page has the now, notes and actions prompts, editable', async () => {
    const server = serve();
    renderSettings('/settings/meetings');
    const group = await screen.findByTestId('settings-meeting-prompts');
    expect(group).toBeTruthy();
    const shown = (id: string) => screen.getByTestId(`prompt-${id}-shown`).textContent;
    expect(shown('meeting-now')).toBe(DEFAULT_MEETING_NOW_PROMPT);
    expect(shown('meeting-notes')).toBe(DEFAULT_MEETING_NOTES_PROMPT);
    expect(shown('meeting-actions')).toBe(DEFAULT_MEETING_ACTIONS_PROMPT);
    fireEvent.click(screen.getByTestId('prompt-meeting-notes-mode-custom'));
    fireEvent.change(screen.getByTestId('prompt-meeting-notes-text'), {
      target: { value: 'Terse.' },
    });
    fireEvent.click(screen.getByTestId('prompt-meeting-notes-save'));
    await waitFor(() => expect(server.writes).toEqual([{ meetingNotesPrompt: 'Terse.' }]));
  });

  it('disables Save for a blank or unchanged prompt draft', async () => {
    const server = serve();
    renderSettings('/settings/meetings');
    fireEvent.click(await screen.findByTestId('prompt-meeting-notes-mode-custom'));
    const save = screen.getByTestId('prompt-meeting-notes-save') as HTMLButtonElement;
    const box = screen.getByTestId('prompt-meeting-notes-text');
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  ' } });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.change(box, { target: { value: 'Terse.' } });
    expect(save.disabled).toBe(false);
    expect(server.writes).toEqual([]);
  });

  it('the Meetings page shows the models and interval, with no transcription model field, and writes the interval', async () => {
    const server = serve();
    renderSettings('/settings/meetings');
    const analysis = (await screen.findByTestId('meeting-analysis-model')) as HTMLSelectElement;
    expect(analysis.value).toBe(DEFAULT_MEETING_MODEL);
    expect((screen.getByTestId('meeting-cleanup-model') as HTMLSelectElement).value).toBe(
      DEFAULT_MEETING_MODEL,
    );
    expect(screen.queryByTestId('meeting-transcription-model')).toBeNull();
    fireEvent.change(screen.getByTestId('meeting-analyse-seconds'), { target: { value: '40' } });
    await waitFor(() => expect(server.writes).toContainEqual({ meetingAnalyseSeconds: 40 }));
    // Out of range is never sent.
    fireEvent.change(screen.getByTestId('meeting-analyse-seconds'), { target: { value: '2' } });
    expect(server.writes).not.toContainEqual({ meetingAnalyseSeconds: 2 });
    // The research pass: its own model, and a floor on how often it runs.
    expect((screen.getByTestId('meeting-research-model') as HTMLSelectElement).value).toBe(
      DEFAULT_MEETING_MODEL,
    );
    fireEvent.change(screen.getByTestId('meeting-research-seconds'), { target: { value: '120' } });
    await waitFor(() => expect(server.writes).toContainEqual({ meetingResearchSeconds: 120 }));
    fireEvent.change(screen.getByTestId('meeting-research-seconds'), { target: { value: '5' } });
    expect(server.writes).not.toContainEqual({ meetingResearchSeconds: 5 });
  });
});
