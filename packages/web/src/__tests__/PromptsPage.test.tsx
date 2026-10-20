// Settings → Prompts: every prompt Patch sends to an agent on one page, each
// Default or Custom, with a way back to the default.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import {
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_MODEL,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  DEFAULT_LINK_SUMMARY_PROMPT,
  DEFAULT_SWEEP_PROMPT,
  DEFAULT_WATCH_CHECK_IN_PROMPT,
} from '@patch/wire';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '@patch/wire/jobs';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
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

describe('Settings → Prompts', () => {
  it('lists every prompt with its default text and marks each Default', async () => {
    serve();
    renderSettings('/settings/prompts');
    const shown = async (id: string): Promise<string | null> =>
      (await screen.findByTestId(`prompt-${id}-shown`)).textContent;
    expect(await shown('watch-check-in')).toBe(DEFAULT_WATCH_CHECK_IN_PROMPT);
    expect(await shown('sweep')).toBe(DEFAULT_SWEEP_PROMPT);
    expect(await shown('goal-judge')).toBe(DEFAULT_GOAL_EVAL_PROMPT);
    expect(await shown('link-summary')).toBe(DEFAULT_LINK_SUMMARY_PROMPT);
    expect(await shown('job-autonomy')).toBe(DEFAULT_JOB_AUTONOMY_PROMPT);
    for (const id of ['watch-check-in', 'sweep', 'goal-judge', 'link-summary', 'job-autonomy']) {
      expect(screen.getByTestId(`prompt-${id}-mode-default`).getAttribute('aria-pressed')).toBe(
        'true',
      );
    }
    expect(screen.getByTestId('prompt-tools')).toBeTruthy();
    expect(screen.getByTestId('prompt-system')).toBeTruthy();
  });

  it('writes the check-in interval, and ignores a value that is not a positive whole number', async () => {
    const server = serve();
    renderSettings('/settings/prompts');
    const input = (await screen.findByTestId('watch-check-in-minutes')) as HTMLInputElement;
    expect(input.value).toBe('60');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.change(input, { target: { value: '15' } });
    await waitFor(() => expect(server.writes).toEqual([{ watchCheckInMinutes: 15 }]));
  });

  it('switches to Custom seeded with the default, saves, then goes back to the default', async () => {
    const server = serve();
    renderSettings('/settings/prompts');
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
    renderSettings('/settings/prompts');
    fireEvent.click(await screen.findByTestId('prompt-sweep-mode-custom'));
    fireEvent.click(screen.getByTestId('prompt-sweep-cancel'));
    expect(server.writes).toEqual([]);
    expect(screen.getByTestId('prompt-sweep-mode-default').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('has a Meetings group with the now, notes and actions prompts, editable', async () => {
    const server = serve();
    renderSettings('/settings/prompts');
    const group = await screen.findByTestId('settings-prompts-meetings');
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

  it('shows the meeting models and interval, and writes the transcription model and interval', async () => {
    const server = serve();
    renderSettings('/settings/prompts');
    const analysis = (await screen.findByTestId('meeting-analysis-model')) as HTMLSelectElement;
    expect(analysis.value).toBe(DEFAULT_MEETING_MODEL);
    expect((screen.getByTestId('meeting-cleanup-model') as HTMLSelectElement).value).toBe(
      DEFAULT_MEETING_MODEL,
    );
    const stt = screen.getByTestId('meeting-transcription-model') as HTMLInputElement;
    expect(stt.value).toBe('');
    fireEvent.change(stt, { target: { value: ' /models/whisper/small.en ' } });
    fireEvent.blur(stt);
    await waitFor(() =>
      expect(server.writes).toContainEqual({
        meetingTranscriptionModel: '/models/whisper/small.en',
      }),
    );
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
