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
import { compactModelLabel, encodePairingUri, type PermissionMode } from '@patch/wire';
import { api } from '../api/rest.js';
import { ClaudeSignIn } from '../components/ClaudeSignIn.js';
import { PERMISSION_MODES } from '../components/Composer.js';
import { getDesktopBridge, type KeepRunningState } from '../lib/desktopBridge.js';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { AddChatGPTAccount } from './settings/SharedAccounts.js';
import { useModelOptions } from './settings/modelOptions.js';
import { patchShared } from './settings/sharedWrite.js';

/** Where a new user gets the phone app. */
export const ANDROID_APK_URL =
  'https://github.com/patch-hq/patch/releases/latest/download/Patch-android.apk';

type StepId = 'providers' | 'permissions' | 'model' | 'keep-running' | 'phone';

/** What each mode does, in a few words: the names alone don't say. */
const MODE_HINT: Record<string, string> = {
  auto: 'Claude judges what is safe to run',
  default: 'Asks before changing files or running commands',
  acceptEdits: 'Edits files freely, asks before commands',
  bypassPermissions: 'Never asks',
  plan: 'Reads and plans, changes nothing',
};

export function WelcomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The shell says whether this computer runs Patch itself; only then is there
  // anything to keep running.
  const local = params.get('machine') === 'local' && getDesktopBridge()?.keepRunning !== undefined;
  const steps: StepId[] = [
    'providers',
    'permissions',
    'model',
    ...(local ? (['keep-running'] as const) : []),
    'phone',
  ];
  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  const last = index === steps.length - 1;
  const next = (): void => {
    if (last) navigate('/', { replace: true });
    else setIndex(index + 1);
  };

  return (
    <div className="welcome" data-testid="welcome" data-step={step}>
      <div className="welcome-drag" />
      <main className="welcome-card">
        <ol className="welcome-dots" aria-label={`Step ${index + 2} of ${steps.length + 1}`}>
          {/* The first dot is the shell's own step: where agents run. */}
          {['where', ...steps].map((s, i) => (
            <li key={s} className={i <= index + 1 ? 'done' : ''} />
          ))}
        </ol>
        {step === 'providers' ? <ProvidersStep onNext={next} /> : null}
        {step === 'permissions' ? <PermissionStep onNext={next} /> : null}
        {step === 'model' ? <ModelStep onNext={next} /> : null}
        {step === 'keep-running' ? <KeepRunningStep onNext={next} /> : null}
        {step === 'phone' ? <PhoneStep onNext={next} /> : null}
        {index > 0 ? (
          <button
            type="button"
            className="welcome-back"
            data-testid="welcome-back"
            onClick={() => setIndex(index - 1)}
          >
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
}: {
  onNext: () => void;
  ready: boolean;
  label?: string;
  skip?: string;
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
        <button type="button" className="welcome-skip" data-testid="welcome-skip" onClick={onNext}>
          {skip}
        </button>
      ) : null}
    </div>
  );
}

function ProvidersStep({ onNext }: { onNext: () => void }): JSX.Element {
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

  return (
    <section className="welcome-step" data-testid="welcome-providers">
      <h1>Connect an AI</h1>
      <div className="welcome-provider" data-testid="welcome-claude">
        <div className="welcome-provider-head">
          <span className="welcome-provider-name">Claude</span>
          {claude.length > 0 ? (
            <span className="welcome-ok" data-testid="welcome-claude-connected">
              {claude.map((a) => a.label).join(', ')}
            </span>
          ) : null}
        </div>
        {claude.length === 0 ? <ClaudeSignIn primary /> : null}
        {installing ? (
          <p className="welcome-note" data-testid="welcome-claude-installing">
            Installing Claude Code on this computer…
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
        {chatgpt.length === 0 ? <AddChatGPTAccount /> : null}
      </div>
      <Footer
        onNext={onNext}
        ready={claude.length + chatgpt.length > 0}
        skip={claude.length + chatgpt.length > 0 ? undefined : 'Skip for now'}
      />
    </section>
  );
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

function ModelStep({ onNext }: { onNext: () => void }): JSX.Element {
  const value = usePreferencesStore((s) => s.preferences.defaultModel);
  const loaded = usePreferencesStore((s) => s.loaded);
  const { options, problem } = useModelOptions(value);
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
            onPick={() => void patchShared('default model', { defaultModel: m.id })}
          />
        ))}
      </div>
      {problem ? (
        <p className="welcome-note" data-testid="welcome-model-problem">
          {problem.text}
        </p>
      ) : null}
      <Footer onNext={onNext} ready={loaded} />
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

function PhoneStep({ onNext }: { onNext: () => void }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
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
  const [drawError, setDrawError] = useState<string | null>(null);
  useEffect(() => {
    if (!payload || !canvas.current) return;
    QRCode.toCanvas(canvas.current, payload, { width: 200, margin: 1 }, (err) =>
      setDrawError(err ? err.message : null),
    );
  }, [payload]);
  return (
    <section className="welcome-step" data-testid="welcome-phone">
      <h1>Connect your phone</h1>
      <ol className="welcome-phone-steps">
        <li>
          <a href={ANDROID_APK_URL} target="_blank" rel="noreferrer" data-testid="welcome-apk">
            Get the Android app
          </a>
        </li>
        <li>Open it and scan this code</li>
      </ol>
      <div className="welcome-qr">
        {error ? (
          <p className="set-error" role="alert" data-testid="welcome-qr-error">
            Could not make a pairing code: {(error as Error).message}{' '}
            <button type="button" className="set-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </p>
        ) : (
          <canvas ref={canvas} data-testid="welcome-qr" aria-label="Pairing code" />
        )}
        {drawError ? <p className="set-error">{drawError}</p> : null}
      </div>
      <Footer onNext={onNext} ready label="Done" />
    </section>
  );
}

function Option({
  id,
  checked,
  disabled,
  title,
  hint,
  onPick,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  hint?: string | undefined;
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
        {hint ? <span className="welcome-option-hint">{hint}</span> : null}
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
