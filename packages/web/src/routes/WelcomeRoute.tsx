// The setup steps after the desktop app's first run (spec/05 § Desktop first
// run). The first step, where agents run, is the shell's own window — there is
// no server to load this page from until it is answered. Everything after it is
// here, in the app itself, so each step uses the same accounts, shared settings
// and pairing the rest of the app does, and each choice stays changeable in
// Settings.
//
// One question per step. Every step can be left for later; nothing here is
// stored anywhere but where Settings stores it.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  accountsKeyForBackend,
  backendIdForModel,
  compactModelLabel,
  encodePairingUri,
  type PermissionMode,
} from '@patch/wire';
import { api } from '../api/rest.js';
import { ClaudeSignIn } from '../components/ClaudeSignIn.js';
import { ErrorDetail } from '../components/ErrorDetail.js';
import { PERMISSION_MODES } from '../components/Composer.js';
import { getDesktopBridge, type KeepRunningState } from '../lib/desktopBridge.js';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';
import { anyProviderConnected, usePreferencesStore } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { AddChatGPTAccount } from './settings/SharedAccounts.js';
import { useModelOptions } from './settings/modelOptions.js';
import { patchShared } from './settings/sharedWrite.js';

/** Where a new user gets the phone app. */
export const ANDROID_APK_URL =
  'https://github.com/patch-hq/patch/releases/latest/download/Patch-android.apk';

type StepId = 'providers' | 'permissions' | 'model' | 'keep-running' | 'phone';
type PhonePhase = 'app' | 'pair';

/** How long the "installed" line stays after Claude Code finishes installing. */
export const INSTALLED_NOTE_MS = 6000;

/** What each mode does, in a few words: the names alone don't say. Said of
 *  "the agent", never of one provider: nothing may be connected yet. */
export const MODE_HINT: Record<string, string> = {
  auto: 'Asks only when something looks risky',
  default: 'Asks before changing files or running commands',
  acceptEdits: 'Edits files freely, asks before commands',
  bypassPermissions: 'Never asks, so it can delete or overwrite anything',
  plan: 'Reads and plans, changes nothing',
};
/** The modes whose hint is a warning, drawn as one. */
const MODE_WARNS = new Set(['bypassPermissions']);

export function WelcomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The shell says whether this computer runs Patch itself; only then is there
  // anything to keep running.
  const local = params.get('machine') === 'local' && getDesktopBridge()?.keepRunning !== undefined;
  // With no AI connected there are no models to choose between, so the model
  // step is not asked at all rather than offering one meaningless option.
  const connected = usePreferencesStore((s) => anyProviderConnected(s.shared)) === true;
  const steps: StepId[] = [
    'providers',
    'permissions',
    ...(connected ? (['model'] as const) : []),
    ...(local ? (['keep-running'] as const) : []),
    'phone',
  ];
  const [index, setIndex] = useState(0);
  // The phone step asks for the app first, then shows the pairing code, so the
  // two codes are never on screen together to be scanned the wrong way round.
  const [phonePhase, setPhonePhase] = useState<PhonePhase>('app');
  const step = steps[Math.min(index, steps.length - 1)]!;
  const last = index >= steps.length - 1;
  const next = (): void => {
    // A newcomer lands on a chat ready to type into, not on the Manager.
    if (last) navigate('/chats/new', { replace: true });
    else setIndex(index + 1);
  };
  const back = (): void => {
    if (step === 'phone' && phonePhase === 'pair') setPhonePhase('app');
    else setIndex(index - 1);
  };

  return (
    <div className="welcome" data-testid="welcome" data-step={step}>
      <div className="welcome-drag" />
      <main className="welcome-card">
        {/* One dot per step on this page, and nothing else: the shell's own
            question before it draws no bar, so counting it here made the bar
            start part-filled and count a step the page never shows. */}
        <ol
          className="welcome-dots"
          data-testid="welcome-dots"
          aria-label={`Step ${index + 1} of ${steps.length}`}
        >
          {steps.map((s, i) => (
            <li key={s} className={i <= index ? 'done' : ''} />
          ))}
        </ol>
        {step === 'providers' ? <ProvidersStep onNext={next} /> : null}
        {step === 'permissions' ? <PermissionStep onNext={next} /> : null}
        {step === 'model' ? <ModelStep onNext={next} /> : null}
        {step === 'keep-running' ? <KeepRunningStep onNext={next} /> : null}
        {step === 'phone' ? (
          <PhoneStep onNext={next} phase={phonePhase} onPhase={setPhonePhase} />
        ) : null}
        {index > 0 ? (
          <button type="button" className="welcome-back" data-testid="welcome-back" onClick={back}>
            Back
          </button>
        ) : null}
      </main>
    </div>
  );
}

function Footer({
  onNext,
  ready,
  label = 'Continue',
  skip,
  onSkip = onNext,
}: {
  onNext: () => void;
  ready: boolean;
  label?: string;
  skip?: string;
  /** What the quiet action does; it moves on unless told otherwise. */
  onSkip?: () => void;
}): JSX.Element {
  return (
    <div className="welcome-footer">
      <button
        type="button"
        className="welcome-primary"
        data-testid="welcome-next"
        disabled={!ready}
        onClick={onNext}
      >
        {label}
      </button>
      {skip ? (
        <button type="button" className="welcome-skip" data-testid="welcome-skip" onClick={onSkip}>
          {skip}
        </button>
      ) : null}
    </div>
  );
}

function ProvidersStep({ onNext }: { onNext: () => void }): JSX.Element {
  const connected = useConnectedCount();
  // Skipping says once what it costs, then lets the person carry on.
  const [skipping, setSkipping] = useState(false);
  const warned = skipping && connected === 0;
  return (
    <section className="welcome-step" data-testid="welcome-providers">
      <h1>Connect an AI</h1>
      <ProviderCards />
      {warned ? (
        <p className="welcome-note" role="status" data-testid="welcome-skip-note">
          Chats won’t run until you connect an AI. You can do it later from the banner in any chat.
        </p>
      ) : null}
      {connected > 0 || warned ? (
        <Footer onNext={onNext} ready />
      ) : (
        <Footer
          onNext={onNext}
          ready={false}
          skip="Skip for now"
          onSkip={() => setSkipping(true)}
        />
      )}
    </section>
  );
}

/** How many AI accounts are connected, of any provider. */
export function useConnectedCount(): number {
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  return [...(secrets?.claude ?? []), ...(secrets?.codex ?? [])].filter((a) => a.connected).length;
}

/**
 * One card per provider, each with its sign-in. The welcome step and the
 * Connect page (routes/ConnectRoute) draw the same cards.
 */
export function ProviderCards(): JSX.Element {
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  const hosts = usePresenceStore((s) => s.hosts);
  const claude = secrets?.claude.filter((a) => a.connected) ?? [];
  const chatgpt = secrets?.codex.filter((a) => a.connected) ?? [];
  // Whether a host is still installing Claude Code, or could not: a Claude
  // sign-in is no use until a host can run it, and a failed install must show.
  const claudeOnHosts = Object.values(hosts)
    .filter((h) => h.online)
    .map((h) => h.host?.backends.find((b) => b.id === 'claude-code'))
    .filter((b) => b !== undefined);
  const installing = claudeOnHosts.some((b) => b.state === 'installing');
  const failed = claudeOnHosts.find((b) => b.state === 'failed');
  const installed = useJustInstalled(installing, failed !== undefined);

  return (
    <>
      <div className="welcome-provider" data-testid="welcome-claude">
        <div className="welcome-provider-head">
          <span className="welcome-provider-name">Claude</span>
          {claude.length > 0 ? (
            <span className="welcome-ok" data-testid="welcome-claude-connected">
              {claude.map((a) => a.label).join(', ')}
            </span>
          ) : null}
        </div>
        {claude.length === 0 ? (
          <>
            <p className="welcome-note" data-testid="welcome-claude-plans">
              Works with a Claude Pro, Max, Team or Enterprise plan.
            </p>
            <ClaudeSignIn primary />
          </>
        ) : null}
        {installing ? (
          <p className="welcome-note" data-testid="welcome-claude-installing">
            Installing Claude Code on this computer…
          </p>
        ) : null}
        {installed ? (
          <p className="welcome-note" data-testid="welcome-claude-installed">
            Claude Code is installed.
          </p>
        ) : null}
        {failed ? (
          <p className="set-error" role="alert" data-testid="welcome-claude-install-failed">
            {failed.error ?? 'Installing Claude Code failed'}
          </p>
        ) : null}
      </div>
      <div className="welcome-provider" data-testid="welcome-chatgpt">
        <div className="welcome-provider-head">
          <span className="welcome-provider-name">ChatGPT and OpenAI</span>
          {chatgpt.length > 0 ? (
            <span className="welcome-ok" data-testid="welcome-chatgpt-connected">
              {chatgpt.map((a) => a.label).join(', ')}
            </span>
          ) : null}
        </div>
        {chatgpt.length === 0 ? (
          <>
            <p className="welcome-note" data-testid="welcome-chatgpt-plans">
              Works with a ChatGPT plan or an OpenAI API key.
            </p>
            <AddChatGPTAccount />
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * True for a few seconds after an install this page watched finishes without
 * failing, so the "installing" line ends in a "done" rather than vanishing.
 */
function useJustInstalled(installing: boolean, failed: boolean): boolean {
  const wasInstalling = useRef(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (installing) {
      wasInstalling.current = true;
      setDone(false);
      return;
    }
    if (!wasInstalling.current) return;
    wasInstalling.current = false;
    if (!failed) setDone(true);
  }, [installing, failed]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), INSTALLED_NOTE_MS);
    return () => clearTimeout(t);
  }, [done]);
  return done;
}

function PermissionStep({ onNext }: { onNext: () => void }): JSX.Element {
  const value = usePreferencesStore((s) => s.preferences.permissionModeDefault);
  const loaded = usePreferencesStore((s) => s.loaded);
  return (
    <section className="welcome-step" data-testid="welcome-permissions">
      <h1>How much should agents ask first?</h1>
      <div className="welcome-options" role="radiogroup" aria-label="Permission mode">
        {PERMISSION_MODES.map((m) => (
          <Option
            key={m}
            id={`welcome-mode-${m}`}
            checked={value === m}
            disabled={!loaded}
            title={permissionModeLabel(m)}
            hint={MODE_HINT[m]}
            warn={MODE_WARNS.has(m)}
            onPick={() =>
              void patchShared('permission mode', { permissionModeDefault: m as PermissionMode })
            }
          />
        ))}
      </div>
      <Footer onNext={onNext} ready={loaded} />
    </section>
  );
}

/**
 * The chat models the setup's choice is written to: what new chats, jobs and
 * the Manager and Speakers start on. Each is moved only when it is the default
 * being chosen, or sits on a provider that isn't connected and so could not
 * run at all.
 */
const CHAT_MODEL_SETTINGS = ['jobDefaultModel', 'specialThreadModel'] as const;

function ModelStep({ onNext }: { onNext: () => void }): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const value = preferences.defaultModel;
  const loaded = usePreferencesStore((s) => s.loaded);
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  const { options: all, problem } = useModelOptions(value);
  // Only the connected providers' models: a ChatGPT user is never offered, or
  // left on, a Claude model they cannot run.
  const runnable = (id: string): boolean =>
    (secrets?.[accountsKeyForBackend(backendIdForModel(id))] ?? []).some((a) => a.connected);
  const options = all.filter((m) => runnable(m.id));
  const choose = (id: string): void => {
    const others = Object.fromEntries(
      CHAT_MODEL_SETTINGS.filter((k) => !runnable(preferences[k])).map((k) => [k, id]),
    );
    void patchShared('default model', { defaultModel: id, ...others });
  };
  // A default on a provider that isn't connected is moved to the newest model
  // that is, so what is shown chosen is what new chats will really use.
  const first = options[0]?.id;
  const stranded = loaded && secrets !== undefined && !runnable(value);
  useEffect(() => {
    if (stranded && first !== undefined) choose(first);
    // Once per stranded default: `choose` is rebuilt every render and is not
    // what the move depends on.
  }, [stranded, first]);
  return (
    <section className="welcome-step" data-testid="welcome-model">
      <h1>Which model should new chats use?</h1>
      <div className="welcome-options scroll" role="radiogroup" aria-label="Model for new chats">
        {options.map((m) => (
          <Option
            key={m.id}
            id={`welcome-model-${m.id}`}
            checked={value === m.id}
            disabled={!loaded}
            title={compactModelLabel(m.id, m.label === m.id ? undefined : m.label)}
            onPick={() => choose(m.id)}
          />
        ))}
      </div>
      {problem ? (
        <div className="welcome-note" data-testid="welcome-model-problem" data-kind={problem.kind}>
          <p>{problem.text}</p>
          {problem.kind === 'error' ? (
            <ErrorDetail detail={problem.detail} testId="welcome-model-problem-detail" />
          ) : null}
        </div>
      ) : null}
      <Footer onNext={onNext} ready={loaded && runnable(value)} />
    </section>
  );
}

function KeepRunningStep({ onNext }: { onNext: () => void }): JSX.Element {
  const bridge = getDesktopBridge()?.keepRunning;
  const [state, setState] = useState<KeepRunningState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bridge
      ?.get()
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [bridge]);
  const set = (patch: Partial<Pick<KeepRunningState, 'openAtLogin' | 'keepAwake'>>): void => {
    void bridge
      ?.set(patch)
      .then(setState)
      .catch((e: Error) => setError(e.message));
  };
  return (
    <section className="welcome-step" data-testid="welcome-keep-running">
      <h1>Keep Patch running</h1>
      <div className="welcome-options">
        {state?.canOpenAtLogin === false ? null : (
          <Toggle
            id="welcome-open-at-login"
            title="Open at login"
            checked={state?.openAtLogin ?? false}
            disabled={state === null}
            onChange={(v) => set({ openAtLogin: v })}
          />
        )}
        <Toggle
          id="welcome-keep-awake"
          title="Keep this computer awake while plugged in"
          hint="So your phone can reach it. The display still sleeps."
          checked={state?.keepAwake ?? false}
          disabled={state === null}
          onChange={(v) => set({ keepAwake: v })}
        />
      </div>
      {error ? (
        <p className="set-error" role="alert">
          {error}
        </p>
      ) : null}
      <Footer onNext={onNext} ready={state !== null} />
    </section>
  );
}

function PhoneStep({
  onNext,
  phase,
  onPhase,
}: {
  onNext: () => void;
  phase: PhonePhase;
  onPhase: (p: PhonePhase) => void;
}): JSX.Element {
  return (
    <section className="welcome-step" data-testid="welcome-phone" data-phase={phase}>
      <h1>Connect your phone</h1>
      {phase === 'app' ? (
        <>
          <p className="welcome-lead">Scan with your phone’s camera to get the Android app.</p>
          <QrCode payload={ANDROID_APK_URL} testId="welcome-apk-qr" label="Android app download" />
          <p className="welcome-muted">iPhone isn’t available yet.</p>
          <Footer
            onNext={() => onPhase('pair')}
            ready
            label="I have the app"
            skip="No phone, skip"
            onSkip={onNext}
          />
        </>
      ) : (
        <PairPhase onNext={onNext} />
      )}
    </section>
  );
}

function PairPhase({ onNext }: { onNext: () => void }): JSX.Element {
  const { data, error, refetch } = useQuery({
    queryKey: ['welcome-pair-nonce'],
    queryFn: () => api.surfacePairStart(),
    // The code lives five minutes; a fresh one before it lapses.
    refetchInterval: 4.5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const payload = data
    ? (data.uri ?? encodePairingUri({ nonce: data.nonce, server: window.location.origin }))
    : null;
  return (
    <>
      <p className="welcome-lead">Open Patch on your phone and scan this code.</p>
      {error ? (
        <p className="set-error" role="alert" data-testid="welcome-qr-error">
          Could not make a pairing code: {(error as Error).message}{' '}
          <button type="button" className="set-btn" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <QrCode payload={payload} testId="welcome-qr" label="Pairing code" />
      )}
      <Footer onNext={onNext} ready label="Done" />
    </>
  );
}

function QrCode({
  payload,
  testId,
  label,
}: {
  payload: string | null;
  testId: string;
  label: string;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  useEffect(() => {
    if (!payload || !canvas.current) return;
    QRCode.toCanvas(canvas.current, payload, { width: 200, margin: 1 }, (err) =>
      setDrawError(err ? err.message : null),
    );
  }, [payload]);
  return (
    <div className="welcome-qr">
      <canvas ref={canvas} data-testid={testId} data-payload={payload ?? ''} aria-label={label} />
      {drawError ? <p className="set-error">{drawError}</p> : null}
    </div>
  );
}

function Option({
  id,
  checked,
  disabled,
  title,
  hint,
  warn = false,
  onPick,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  hint?: string | undefined;
  /** Draw the hint as a warning. */
  warn?: boolean;
  onPick: () => void;
}): JSX.Element {
  return (
    <label className={`welcome-option${checked ? ' checked' : ''}`} data-testid={id}>
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={() => {
          if (!checked) onPick();
        }}
      />
      <span className="welcome-option-text">
        <span className="welcome-option-title">{title}</span>
        {hint ? <span className={`welcome-option-hint${warn ? ' warn' : ''}`}>{hint}</span> : null}
      </span>
    </label>
  );
}

function Toggle({
  id,
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className={`welcome-option${checked ? ' checked' : ''}`} data-testid={id}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="welcome-option-text">
        <span className="welcome-option-title">{title}</span>
        {hint ? <span className="welcome-option-hint">{hint}</span> : null}
      </span>
    </label>
  );
}
