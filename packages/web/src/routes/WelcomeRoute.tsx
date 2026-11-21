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
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_PROVIDERS,
  accountsForBackend,
  accountsKeyForBackend,
  backendIdForModel,
  compactModelLabel,
  encodePairingUri,
  PERMISSION_MODE_COPY,
  permissionModeForProviders,
  permissionModeHint,
  permissionModesForProviders,
  PROVIDERS,
  providerForModel,
  isEndpointModel,
  type PermissionMode,
} from '@patch/wire';
import { api } from '../api/rest.js';
import { ErrorDetail } from '../components/ErrorDetail.js';
import { requestInstall } from '../lib/useInstallPickedProviders.js';
import { getDesktopBridge, type KeepRunningState } from '../lib/desktopBridge.js';
import { permissionModeLabel } from '../lib/permissionModeLabel.js';
import {
  DEFAULT_PREFERENCES,
  anyProviderConnected,
  usePreferencesStore,
} from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { noUsageText, useBackendLimit } from '../lib/accountLimits.js';
import { PROVIDERS as PROVIDER_CARDS } from './settings/providers.js';
import { useModelOptions } from './settings/modelOptions.js';
import { patchShared } from './settings/sharedWrite.js';

/** Where a new user gets the phone app. */
export const ANDROID_APK_URL =
  'https://github.com/patch-hq/patch/releases/latest/download/Patch-android.apk';

type StepId = 'providers' | 'permissions' | 'model' | 'keep-running' | 'phone';
type PhonePhase = 'app' | 'pair';

/** How long the "installed" line stays after Claude Code finishes installing. */
export const INSTALLED_NOTE_MS = 6000;

/** The providers with at least one connected account, by provider id. */
export function useConnectedProviderIds(): string[] {
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  // Providers with no account (a local model) have nothing to connect here.
  return PROVIDERS.filter(
    (p) =>
      p.accountsKey !== null &&
      (secrets?.[p.accountsKey as 'claude' | 'codex'] ?? []).some((a) => a.connected),
  ).map((p) => p.id);
}

export function WelcomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The shell says whether this computer runs Patch itself; only then is there
  // anything to keep running.
  const local = params.get('machine') === 'local' && getDesktopBridge()?.keepRunning !== undefined;
  // The model step is always listed so the count never changes mid-way; with no
  // AI connected it says so rather than offering a meaningless choice.
  const steps: StepId[] = [
    'providers',
    'permissions',
    'model',
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
        <BackContext.Provider value={index > 0 ? back : null}>
          {step === 'providers' ? <ProvidersStep onNext={next} /> : null}
          {step === 'permissions' ? <PermissionStep onNext={next} /> : null}
          {step === 'model' ? <ModelStep onNext={next} /> : null}
          {step === 'keep-running' ? <KeepRunningStep onNext={next} /> : null}
          {step === 'phone' ? (
            <PhoneStep onNext={next} phase={phonePhase} onPhase={setPhonePhase} />
          ) : null}
        </BackContext.Provider>
      </main>
    </div>
  );
}

/** Set by the page when a step has a step before it; the footer draws the button. */
const BackContext = createContext<(() => void) | null>(null);

function Footer({
  onNext,
  ready,
  label = 'Continue',
  skip,
  onSkip = onNext,
  primary = true,
}: {
  onNext: () => void;
  ready: boolean;
  label?: string;
  skip?: string;
  /** What the quiet action does; it moves on unless told otherwise. */
  onSkip?: () => void;
  /** False leaves the quiet action as the only one. */
  primary?: boolean;
}): JSX.Element {
  const back = useContext(BackContext);
  return (
    <div className="welcome-footer">
      {back ? (
        <button type="button" className="welcome-back" data-testid="welcome-back" onClick={back}>
          Back
        </button>
      ) : null}
      {skip ? (
        <button type="button" className="welcome-skip" data-testid="welcome-skip" onClick={onSkip}>
          {skip}
        </button>
      ) : null}
      {primary ? (
        <button
          type="button"
          className="welcome-primary"
          data-testid="welcome-next"
          disabled={!ready}
          onClick={onNext}
        >
          {label}
        </button>
      ) : null}
    </div>
  );
}

function ProvidersStep({ onNext }: { onNext: () => void }): JSX.Element {
  const connected = useConnectedCount();
  return (
    <section className="welcome-step" data-testid="welcome-providers">
      <h1>Connect an AI</h1>
      <p className="welcome-note" data-testid="welcome-plans-note">
        Works with a Claude Pro or Max plan, or a ChatGPT Plus or Pro plan. An API key is billed
        separately by the provider.
      </p>
      <ProviderCards />
      {connected === 0 ? (
        <p className="welcome-note" data-testid="welcome-skip-note">
          Chats won’t run until you connect an AI. You can do it later from the banner in any chat.
        </p>
      ) : null}
      {connected > 0 ? (
        <Footer onNext={onNext} ready />
      ) : (
        <Footer onNext={onNext} ready={false} primary={false} skip="Skip for now" />
      )}
    </section>
  );
}

/** How many AI accounts are connected, of any provider. */
export function useConnectedCount(): number {
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  return ACCOUNT_PROVIDERS.flatMap((p) =>
    accountsForBackend<{ connected: boolean }>(secrets, p.backendId),
  ).filter((a) => a.connected).length;
}

/**
 * What a connected card says beside the provider's name: each account's email,
 * or its own label, never the provider's name said a second time.
 */
export function connectedNames(
  provider: string,
  accounts: readonly { label: string; email?: string | undefined }[],
): string {
  return accounts
    .map((a) =>
      a.label === provider || a.label === 'ChatGPT' ? (a.email ?? 'Connected') : a.label,
    )
    .join(', ');
}

/**
 * One card per provider, each with its sign-in. The welcome step and the
 * Connect page (routes/ConnectRoute) draw the same cards.
 */
export function ProviderCards(): JSX.Element {
  return (
    <>
      {PROVIDER_CARDS.map((p) => (
        <ProviderCard key={p.id} p={p} />
      ))}
    </>
  );
}

function ProviderCard({ p }: { p: (typeof PROVIDER_CARDS)[number] }): JSX.Element {
  const secrets = usePreferencesStore((st) => st.shared?.secrets);
  const connected = secrets ? p.rows(secrets).filter((a) => a.connected) : [];
  const { name, testId, Controls, installName, installTestId } = p.welcome;
  // Signed in is not the same as usable: an account that has used its limit
  // says so, and offers another sign-in rather than a green tick.
  const limit = useBackendLimit(p.id);
  return (
    <div className="welcome-provider" data-testid={`welcome-${testId}`}>
      <div className="welcome-provider-head">
        <span className="welcome-provider-name">{name}</span>
        {connected.length > 0 && !limit ? (
          <span className="welcome-ok" data-testid={`welcome-${testId}-connected`}>
            {connectedNames(name, connected)}
          </span>
        ) : null}
      </div>
      {connected.length > 0 && limit ? (
        <p className="welcome-warn" role="status" data-testid={`welcome-${testId}-limited`}>
          {noUsageText(limit, Date.now(), connected.length > 1)}. Add another account or provider
          below to carry on.
        </p>
      ) : null}
      {connected.length === 0 || limit ? <Controls /> : null}
      <InstallStatus backendId={p.id} name={installName} testId={installTestId} />
    </div>
  );
}

/**
 * Where installing a provider's CLI stands on the online hosts, inside that
 * provider's card: progress while it runs, a short "installed" when it ends, and
 * the installer's own error with a Retry when it fails. Hosts install only after
 * the provider is picked (lib/useInstallPickedProviders), so this is silent
 * until then.
 */
function InstallStatus({
  backendId,
  name,
  testId,
}: {
  backendId: string;
  name: string;
  testId: string;
}): JSX.Element | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const online = Object.values(hosts).filter((h) => h.online);
  const entries = online.map((h) => ({
    host: h,
    backend: h.host?.backends.find((b) => b.id === backendId),
  }));
  const installing = entries.some((e) => e.backend?.state === 'installing');
  const failed = entries.find((e) => e.backend?.state === 'failed');
  const installed = useJustInstalled(installing, failed !== undefined);
  return (
    <>
      {installing ? (
        <p className="welcome-note" data-testid={`welcome-${testId}-installing`}>
          Installing {name} on this computer…
        </p>
      ) : null}
      {installed ? (
        <p className="welcome-note" data-testid={`welcome-${testId}-installed`}>
          {name} is installed.
        </p>
      ) : null}
      {failed ? (
        <>
          <p className="set-error" role="alert" data-testid={`welcome-${testId}-install-failed`}>
            {failed.backend?.error ?? `Installing ${name} failed`}
          </p>
          <button
            type="button"
            className="set-btn"
            data-testid={`welcome-${testId}-install-retry`}
            onClick={() => requestInstall(failed.host, backendId)}
          >
            Retry install
          </button>
        </>
      ) : null}
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
  const connectedIds = useConnectedProviderIds();
  // Only what the connected providers can run, each described by what it does.
  // A stored default none of them can run (`auto` with only Codex) is moved to
  // `default`, which every provider runs, so the step never shows a choice
  // that is not one of its own.
  const modes = permissionModesForProviders(connectedIds);
  const shown = permissionModeForProviders(value, connectedIds);
  useEffect(() => {
    if (loaded && shown !== value) {
      void patchShared('permission mode', { permissionModeDefault: shown });
    }
  }, [loaded, shown, value]);
  return (
    <section className="welcome-step" data-testid="welcome-permissions">
      <h1>How much should agents ask first?</h1>
      <div className="welcome-options" role="radiogroup" aria-label="Permission mode">
        {modes.map((m) => (
          <Option
            key={m}
            id={`welcome-mode-${m}`}
            checked={shown === m}
            disabled={!loaded}
            title={permissionModeLabel(m)}
            hint={permissionModeHint(m, connectedIds)}
            warn={PERMISSION_MODE_COPY[m].warns}
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
 * the Manager and Speakers start on. All follow the choice made here.
 */
const CHAT_MODEL_SETTINGS = ['jobDefaultModel', 'specialThreadModel'] as const;

/** One line on what a model family is for; models outside these say nothing. */
export function modelHint(id: string): string | undefined {
  if (/fable/i.test(id))
    return 'The newest and most capable Claude model. Best for the hardest work.';
  if (/sonnet/i.test(id)) return 'Fast and capable. The right choice for most work.';
  if (/opus/i.test(id))
    return 'Very capable for complex work, but slower and costlier than Sonnet.';
  if (/haiku/i.test(id)) return 'The quickest and cheapest, for simple tasks.';
  return undefined;
}

/**
 * The short list shown first: the newest model of each Claude family, and the
 * first of any other provider. The catalogue is newest first. `def` is the one
 * a newcomer starts on: the newest Sonnet, else the top of the list.
 */
export function recommendedModels<T extends { id: string }>(
  options: readonly T[],
): { recommended: T[]; rest: T[]; def: T | undefined } {
  const seen = new Set<string>();
  const recommended: T[] = [];
  for (const m of options) {
    const family = /sonnet|opus|haiku/i.exec(m.id)?.[0].toLowerCase() ?? providerForModel(m.id);
    if (seen.has(family)) continue;
    seen.add(family);
    recommended.push(m);
  }
  const order = (m: T): number => (/sonnet/i.test(m.id) ? 0 : /opus/i.test(m.id) ? 1 : 2);
  recommended.sort((x, y) => order(x) - order(y));
  return {
    recommended,
    rest: options.filter((m) => !recommended.includes(m)),
    def: recommended[0],
  };
}

function ModelStep({ onNext }: { onNext: () => void }): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const value = preferences.defaultModel;
  const loaded = usePreferencesStore((s) => s.loaded);
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  const connected = usePreferencesStore((s) => anyProviderConnected(s.shared)) === true;
  const { options: all, problem } = useModelOptions(value);
  const [more, setMore] = useState(false);
  // Only the connected providers' models: a ChatGPT user is never offered, or
  // left on, a Claude model they cannot run.
  const runnable = (id: string): boolean =>
    // A model endpoint needs no sign-in: it is reachable or it is not listed.
    isEndpointModel(id)
      ? true
      : (secrets?.[accountsKeyForBackend(backendIdForModel(id))] ?? []).some((a) => a.connected);
  const options = all.filter((m) => runnable(m.id));
  const { recommended, rest, def } = recommendedModels(options);
  const choose = (id: string): void => {
    // The Manager and jobs start on the model chosen here, so what is shown
    // chosen is what every new thing uses.
    const others = Object.fromEntries(CHAT_MODEL_SETTINGS.map((k) => [k, id]));
    void patchShared('default model', { defaultModel: id, ...others });
  };
  // A default on a provider that isn't connected, or the untouched factory
  // default (the dearest model), reads as the recommended one and is written
  // when Continue is pressed, so what is shown chosen is what new chats use.
  // Nothing is written on arrival: the list may still be loading.
  const start = def?.id;
  const replaced =
    loaded &&
    secrets !== undefined &&
    (!runnable(value) || value === DEFAULT_PREFERENCES.defaultModel);
  // What the person clicked wins, even when it is the factory default.
  const [picked, setPicked] = useState<string | null>(null);
  const current = picked ?? (replaced && start !== undefined ? start : value);
  const advance = (): void => {
    if (picked === null && current !== value) choose(current);
    onNext();
  };
  const shown =
    more || rest.some((m) => m.id === current) ? [...recommended, ...rest] : recommended;
  return (
    <section className="welcome-step" data-testid="welcome-model">
      <h1>Which model should new chats use?</h1>
      <div className="welcome-options scroll" role="radiogroup" aria-label="Model for new chats">
        {shown.map((m) => (
          <Option
            key={m.id}
            id={`welcome-model-${m.id}`}
            checked={current === m.id}
            disabled={!loaded}
            title={compactModelLabel(m.id, m.label === m.id ? undefined : m.label)}
            hint={modelHint(m.id)}
            onPick={() => {
              setPicked(m.id);
              choose(m.id);
            }}
          />
        ))}
        {shown.length < options.length ? (
          <button
            type="button"
            className="welcome-skip"
            data-testid="welcome-model-more"
            onClick={() => setMore(true)}
          >
            More models
          </button>
        ) : null}
      </div>
      {problem ? (
        <div className="welcome-note" data-testid="welcome-model-problem" data-kind={problem.kind}>
          <p>{problem.text}</p>
          {problem.kind === 'error' ? (
            <ErrorDetail detail={problem.detail} testId="welcome-model-problem-detail" />
          ) : null}
        </div>
      ) : null}
      <Footer onNext={advance} ready={loaded && (!connected || runnable(current))} />
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
