// Settings → Voice → Who is speaking (spec/16 § Who is speaking).
//
// The people a voice device recognises by voice: each with how much they may
// do, what Patch should know when they speak, and a voiceprint built from
// samples. A sample is either recorded here or picked from the voices the
// devices heard lately, which matches the device's own microphone best.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
  addVoiceSample,
  VOICE_MATCH_LEVELS,
  VOICE_PROFILES_MAX,
  type RecentVoice,
  type VoiceProfile,
  type VoiceProfileAccess,
} from '@patch/wire';
import { api } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { recordVoiceSample, VOICE_SAMPLE_SECONDS } from '../../lib/voiceSample.js';
import { patchShared, problemText } from './sharedWrite.js';
import { Group, Note, Pills, Row } from './ui.js';

const ACCESS: readonly VoiceProfileAccess[] = ['owner', 'household', 'guest'];
const ACCESS_LABELS: Record<VoiceProfileAccess, string> = {
  owner: 'Owner',
  household: 'Household',
  guest: 'Guest',
};
const ACCESS_TITLES: Record<VoiceProfileAccess, string> = {
  owner: 'Everything: your chats and the agent',
  household: 'Can ask the agent for things; not told your chats',
  guest: 'General chat only',
};

type MatchLevel = keyof typeof VOICE_MATCH_LEVELS;
const MATCH_LEVELS = Object.keys(VOICE_MATCH_LEVELS) as MatchLevel[];
const MATCH_LABELS: Record<MatchLevel, string> = {
  relaxed: 'Relaxed',
  normal: 'Normal',
  strict: 'Strict',
};
const MATCH_TITLES: Record<MatchLevel, string> = {
  relaxed: 'Recognises people more readily; more likely to mistake one voice for another',
  normal: 'The default',
  strict: 'Mistakes one voice for another least; may not recognise someone in a noisy room',
};

/** The level a stored threshold reads as: the nearest of the three. */
function levelOf(threshold: number): MatchLevel {
  return MATCH_LEVELS.reduce((best, l) =>
    Math.abs(VOICE_MATCH_LEVELS[l] - threshold) < Math.abs(VOICE_MATCH_LEVELS[best] - threshold)
      ? l
      : best,
  );
}

function saveProfiles(next: VoiceProfile[]): Promise<boolean> {
  return patchShared('voice profiles', { voiceProfiles: next });
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function VoiceProfilesGroup(): JSX.Element {
  const prefs = usePreferencesStore((s) => s.preferences);
  const profiles = prefs.voiceProfiles;
  // Only the OpenAI voice agent recognises speakers so far.
  const recognises =
    prefs.voiceConfig.deviceAnswer === 'agent' && prefs.voiceAgent.provider === 'openai';
  const [name, setName] = useState('');

  const update = (id: string, change: (p: VoiceProfile) => VoiceProfile): Promise<boolean> =>
    saveProfiles(profiles.map((p) => (p.id === id ? change(p) : p)));

  const add = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const id = `vp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // The first person is usually the account's owner.
    const access: VoiceProfileAccess = profiles.length === 0 ? 'owner' : 'household';
    void saveProfiles([...profiles, { id, name: trimmed, access, context: '', samples: 0 }]).then(
      (ok) => {
        if (ok) setName('');
      },
    );
  };

  return (
    <Group label="Who is speaking" testid="settings-voice-profiles">
      <Note>
        A voice device can tell people apart by their voice. Someone it does not recognise gets
        general chat only: no agent, and nothing from your chats.
      </Note>
      {!recognises && profiles.some((p) => p.voiceprint) ? (
        <Note testid="voice-profiles-engine-note">
          Voices are recognised when voice devices use OpenAI (Voice conversations above). With the
          current choice, everyone in the room is answered alike.
        </Note>
      ) : null}
      {profiles.length > 0 ? (
        <Row
          title="How sure to be"
          sub="How closely a voice must match before Patch treats it as that person."
        >
          <Pills
            label="How sure Patch must be of a voice"
            options={MATCH_LEVELS}
            labels={MATCH_LABELS}
            titles={MATCH_TITLES}
            value={levelOf(prefs.voiceMatchThreshold)}
            testid="voice-match-level"
            onChange={(l) =>
              void patchShared('voice recognition', { voiceMatchThreshold: VOICE_MATCH_LEVELS[l] })
            }
          />
        </Row>
      ) : null}
      {profiles.map((p) => (
        <ProfileCard key={p.id} profile={p} update={update} all={profiles} />
      ))}
      {profiles.length < VOICE_PROFILES_MAX ? (
        <Row title="Add a person">
          <input
            type="text"
            aria-label="Name of the person to add"
            data-testid="voice-profile-new-name"
            placeholder="Name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
          <button
            type="button"
            className="set-btn"
            data-testid="voice-profile-add"
            disabled={name.trim() === ''}
            onClick={add}
          >
            Add
          </button>
        </Row>
      ) : null}
    </Group>
  );
}

function ProfileCard({
  profile,
  all,
  update,
}: {
  profile: VoiceProfile;
  all: VoiceProfile[];
  update: (id: string, change: (p: VoiceProfile) => VoiceProfile) => Promise<boolean>;
}): JSX.Element {
  const [context, setContext] = useState(profile.context);
  const [recording, setRecording] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const pushError = useUiStore((s) => s.pushError);
  const tid = `voice-profile-${profile.id}`;

  const addSample = (voiceprint: number[]): Promise<boolean> =>
    update(profile.id, (p) => ({
      ...p,
      voiceprint: addVoiceSample(p.voiceprint, p.samples, voiceprint),
      samples: p.samples + 1,
    }));

  const record = async (): Promise<void> => {
    setRecording(0);
    try {
      const pcm = await recordVoiceSample(VOICE_SAMPLE_SECONDS, (s) => setRecording(s)).done;
      setRecording(null);
      setBusy(true);
      const { voiceprint } = await api.voiceprint(pcm);
      await addSample(voiceprint);
    } catch (e) {
      pushError(`Voice sample for ${profile.name}: ${problemText(e)}`);
    } finally {
      setRecording(null);
      setBusy(false);
    }
  };

  return (
    <div className="set-row stack" data-testid={tid}>
      <Row
        title={profile.name}
        sub={
          profile.samples === 0
            ? 'No voice recorded yet'
            : `${profile.samples} sample${profile.samples === 1 ? '' : 's'}`
        }
      >
        <Pills
          label={`What ${profile.name} may do`}
          options={ACCESS}
          labels={ACCESS_LABELS}
          titles={ACCESS_TITLES}
          value={profile.access}
          testid={`${tid}-access`}
          onChange={(access) => void update(profile.id, (p) => ({ ...p, access }))}
        />
        <button
          type="button"
          className="set-btn ghost"
          data-testid={`${tid}-remove`}
          onClick={() =>
            void patchShared('voice profiles', {
              voiceProfiles: all.filter((p) => p.id !== profile.id),
            })
          }
        >
          Remove
        </button>
      </Row>
      <textarea
        aria-label={`What Patch should know when ${profile.name} is speaking`}
        placeholder={`What Patch should know when ${profile.name} is speaking`}
        data-testid={`${tid}-context`}
        value={context}
        rows={3}
        maxLength={4000}
        onChange={(e) => setContext(e.target.value)}
        onBlur={() => {
          if (context !== profile.context) void update(profile.id, (p) => ({ ...p, context }));
        }}
      />
      <div className="set-actions">
        <button
          type="button"
          className="set-btn"
          data-testid={`${tid}-record`}
          disabled={recording !== null || busy}
          onClick={() => void record()}
        >
          {recording !== null
            ? `Recording… ${Math.max(0, Math.ceil(VOICE_SAMPLE_SECONDS - recording))} s`
            : busy
              ? 'Saving…'
              : 'Record a sample'}
        </button>
        <button
          type="button"
          className="set-btn ghost"
          data-testid={`${tid}-pick`}
          onClick={() => setPicking((v) => !v)}
        >
          {picking ? 'Close' : 'Pick from voices heard'}
        </button>
      </div>
      {recording !== null ? <Note>Read a sentence or two aloud in your normal voice.</Note> : null}
      {picking ? (
        <RecentVoices
          profile={profile}
          all={all}
          onPick={async (v) => {
            await addSample(v.voiceprint);
          }}
        />
      ) : null}
    </div>
  );
}

function RecentVoices({
  profile,
  all,
  onPick,
}: {
  profile: VoiceProfile;
  all: VoiceProfile[];
  onPick: (v: RecentVoice) => Promise<void>;
}): JSX.Element {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; recent: RecentVoice[] }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [used, setUsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    api
      .recentVoices()
      .then((r) => {
        if (live) setState({ kind: 'ok', recent: r.recent });
      })
      .catch((e: unknown) => {
        if (live) setState({ kind: 'error', message: problemText(e) });
      });
    return () => {
      live = false;
    };
  }, []);
  if (state.kind === 'idle' || state.kind === 'loading') return <Note>Loading…</Note>;
  if (state.kind === 'error') return <Note testid="voice-recent-error">{state.message}</Note>;
  if (state.recent.length === 0) {
    return (
      <Note testid="voice-recent-empty">
        Nothing heard yet. Talk to a voice device, then come back here.
      </Note>
    );
  }
  const nameOf = (id?: string): string | undefined => all.find((p) => p.id === id)?.name;
  return (
    <div className="set-list" data-testid="voice-recent">
      {state.recent.map((v) => (
        <Row
          key={v.id}
          title={v.text ? `"${v.text}"` : '(no words caught)'}
          sub={`${ago(v.at)} · ${v.seconds} s · ${
            nameOf(v.matchedProfileId)
              ? `taken for ${nameOf(v.matchedProfileId)}`
              : 'not recognised'
          } (match ${v.score.toFixed(2)})`}
          testid={`voice-recent-${v.id}`}
        >
          <button
            type="button"
            className="set-btn"
            disabled={used.has(v.id)}
            data-testid={`voice-recent-${v.id}-use`}
            onClick={() => void onPick(v).then(() => setUsed((s) => new Set(s).add(v.id)))}
          >
            {used.has(v.id) ? 'Added' : `This is ${profile.name}`}
          </button>
        </Row>
      ))}
    </div>
  );
}
