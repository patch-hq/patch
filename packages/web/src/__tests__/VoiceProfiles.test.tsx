// Settings → Voice → Who is speaking (spec/16 § Who is speaking): add a person,
// set what they may do, and give them a voice from what a device heard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { voiceSimilarity, type VoiceProfile } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import {
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';

const axis = (i: number): number[] => Array.from({ length: 256 }, (_, j) => (j === i ? 1 : 0));

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

function serve(recent: unknown[] = []) {
  const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
  vi.stubGlobal(
    'fetch',
    makeFetch({}, (url, init) => {
      if (url.includes('/api/voice/recent-voices')) {
        return new Response(JSON.stringify({ recent }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return server.handler(url, init);
    }),
  );
  return server;
}

function seed(voiceProfiles: VoiceProfile[]): void {
  usePreferencesStore.setState((st) => ({
    preferences: { ...st.preferences, voiceProfiles },
    loaded: true,
  }));
}

const lastProfiles = (writes: Record<string, unknown>[]): VoiceProfile[] =>
  writes.filter((w) => 'voiceProfiles' in w).at(-1)!.voiceProfiles as VoiceProfile[];

describe('Settings → Voice → Who is speaking', () => {
  it('adds the first person as the owner, the next as household', async () => {
    const server = serve();
    renderSettings('/settings/voice');
    const input = await screen.findByTestId('voice-profile-new-name');
    fireEvent.change(input, { target: { value: 'Tom' } });
    fireEvent.click(screen.getByTestId('voice-profile-add'));
    await waitFor(() => expect(lastProfiles(server.writes)).toHaveLength(1));
    expect(lastProfiles(server.writes)[0]).toMatchObject({
      name: 'Tom',
      access: 'owner',
      samples: 0,
    });
    fireEvent.change(screen.getByTestId('voice-profile-new-name'), {
      target: { value: 'Eleanor' },
    });
    fireEvent.click(screen.getByTestId('voice-profile-add'));
    await waitFor(() => expect(lastProfiles(server.writes)).toHaveLength(2));
    expect(lastProfiles(server.writes)[1]).toMatchObject({ name: 'Eleanor', access: 'household' });
  });

  it('changes what someone may do, and what Patch should know about them', async () => {
    seed([{ id: 'p1', name: 'Eleanor', access: 'household', context: '', samples: 0 }]);
    const server = serve();
    renderSettings('/settings/voice');
    fireEvent.click(await screen.findByTestId('voice-profile-p1-access-guest'));
    await waitFor(() => expect(lastProfiles(server.writes)[0]!.access).toBe('guest'));
    const ctx = screen.getByTestId('voice-profile-p1-context');
    fireEvent.change(ctx, { target: { value: 'Dentist on Fridays.' } });
    fireEvent.blur(ctx);
    await waitFor(() =>
      expect(lastProfiles(server.writes)[0]!.context).toBe('Dentist on Fridays.'),
    );
  });

  it('gives someone a voice from what a device heard', async () => {
    seed([{ id: 'p1', name: 'Tom', access: 'owner', context: '', samples: 0 }]);
    const server = serve([
      {
        id: 'v1',
        at: Date.now() - 120_000,
        text: 'what is the time',
        seconds: 2.1,
        voiceprint: axis(4),
        score: 0.2,
      },
    ]);
    renderSettings('/settings/voice');
    fireEvent.click(await screen.findByTestId('voice-profile-p1-pick'));
    expect(await screen.findByText('"what is the time"')).toBeTruthy();
    fireEvent.click(screen.getByTestId('voice-recent-v1-use'));
    await waitFor(() => expect(lastProfiles(server.writes)[0]!.samples).toBe(1));
    expect(voiceSimilarity(lastProfiles(server.writes)[0]!.voiceprint!, axis(4))).toBeCloseTo(1, 4);
    expect(await screen.findByText('Added')).toBeTruthy();
  });

  it('says when the device engine will not recognise voices', async () => {
    seed([
      { id: 'p1', name: 'Tom', access: 'owner', context: '', samples: 1, voiceprint: axis(0) },
    ]);
    serve();
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('voice-profiles-engine-note')).toBeTruthy();
  });
});

describe('Settings → Voice → how sure to be', () => {
  it('writes the chosen strictness as the match threshold', async () => {
    seed([{ id: 'p1', name: 'Tom', access: 'owner', context: '', samples: 0 }]);
    const server = serve();
    renderSettings('/settings/voice');
    fireEvent.click(await screen.findByTestId('voice-match-level-strict'));
    await waitFor(() =>
      expect(server.writes.find((w) => 'voiceMatchThreshold' in w)).toEqual({
        voiceMatchThreshold: 0.85,
      }),
    );
  });
});
