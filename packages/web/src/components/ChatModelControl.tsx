// ChatModelControl — the model a chat runs on, and the control that changes it
// (spec/14 § Model selector). It sits in the composer's action row beside the
// approval mode: both are standing settings for the NEXT turn, so they belong
// with the message about to be sent rather than in the header.

import { useEffect, useRef, useState, type JSX } from 'react';
import { harnessForModel } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { ModelPicker } from './ModelPicker.js';
import { ProviderSwitchModal } from './ProviderSwitchModal.js';
import { usePopupPlacement } from '../lib/popupPlacement.js';
import { useDismissOnClickOff } from '../lib/dismissOnClickOff.js';
import { loadModels } from '../lib/models.js';
import { getActiveWs } from '../api/ws.js';

/**
 * How long the control waits for the host to confirm a model change before it
 * says the switch did not happen (spec/14 § Model selector). The confirmation
 * is a `chat.state` the host emits the moment it applies the change, so this is
 * a network round trip, not a turn — but a host running a host too old to
 * know `chat.model_request` will never answer at all, and leaving the pill
 * reading a model the chat is not on is exactly the silent failure the app
 * forbids.
 */
const MODEL_CONFIRM_TIMEOUT_MS = 8000;

export function ChatModelControl({ chatId }: { chatId: string }): JSX.Element | null {
  const row = useChatStore((s) => s.chats[chatId]);
  if (!row) return null;
  return (
    <>
      <ModelControl chatId={chatId} />
      <AccountControl chatId={chatId} />
    </>
  );
}

/**
 * Which account the chat is locked to (spec/10 § Backend credentials —
 * preferred account); Automatic follows the account strategy. With more than one connected account for the chat's
 * backend it is a select drawn like the approval-mode select beside it; with
 * one there is nothing to choose, so it stays a plain readout of the account
 * the latest turn ran on. The choice is held as pending until the host
 * confirms it on `chat.state`, and a host that never answers is reported.
 */
export function AccountControl({
  chatId,
  changeLabel,
  testId = 'chat-account',
}: {
  chatId: string;
  /** Reads as an action ("Change account") instead of naming the choice. */
  changeLabel?: string;
  testId?: string;
}): JSX.Element | null {
  const row = useChatStore((s) => s.chats[chatId])!;
  const pushError = useUiStore((s) => s.pushError);
  const hostLabel = usePresenceStore((s) =>
    (s.hosts[row.hostId]?.host?.hostName ?? row.hostId).trim(),
  );
  const shared = usePreferencesStore((s) => s.shared?.secrets);
  const accounts = (row.model?.startsWith('openai/') ? shared?.codex : shared?.claude) ?? [];
  const choices = accounts.filter((a) => a.connected);
  // `undefined` is "no change pending"; null is a pending "by strategy".
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const settled = row.preferredAccountId ?? null;
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (pending !== undefined && settled === pending) setPending(undefined);
  }, [pending, settled]);
  useEffect(() => {
    if (pending === undefined) return;
    const t = setTimeout(() => {
      setPending(undefined);
      pushError(`${hostLabel} did not switch the account — this chat is unchanged`);
    }, MODEL_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pending, hostLabel, pushError]);

  if (choices.length < 2) {
    if (changeLabel !== undefined) return null;
    return row.account ? (
      <span
        className="model-pill chat-account"
        data-testid="chat-account"
        title={`The latest turn ran on the ${row.account.label} account`}
      >
        {row.account.label}
      </span>
    ) : null;
  }
  const shown = pending !== undefined ? pending : settled;
  return (
    <div className="permission-mode-wrap chat-account-wrap">
      <select
        className={pending !== undefined ? 'permission-mode is-pending' : 'permission-mode'}
        data-testid={testId}
        aria-label="Account"
        // A native tooltip would draw over the open option list.
        title={
          focused
            ? undefined
            : row.account
              ? `The latest turn ran on the ${row.account.label} account`
              : 'The account this chat is locked to'
        }
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        value={changeLabel !== undefined ? '__change' : (shown ?? '')}
        onChange={(e) => {
          if (e.target.value === '__change') return;
          const next = e.target.value === '' ? null : e.target.value;
          if (next === settled) return;
          setPending(next);
          getActiveWs()?.send({
            type: 'chat.account_request',
            chatId: row.chatId,
            preferredAccountId: next,
          });
        }}
      >
        {changeLabel !== undefined ? (
          <option value="__change" disabled hidden>
            {changeLabel}
          </option>
        ) : null}
        <option value="">
          {row.account && settled === null ? `Automatic: ${row.account.label}` : 'Automatic'}
        </option>
        {choices.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <span className="permission-mode-caret" aria-hidden>
        ▾
      </span>
    </div>
  );
}

export function ModelControl({
  chatId,
  testId = 'chat-model',
  triggerLabel,
}: {
  chatId: string;
  testId?: string;
  /** Reads as an action ("Change model") instead of naming the model. */
  triggerLabel?: string;
}): JSX.Element {
  const row = useChatStore((s) => s.chats[chatId])!;
  const pushError = useUiStore((s) => s.pushError);
  const hostLabel = usePresenceStore((s) =>
    (s.hosts[row.hostId]?.host?.hostName ?? row.hostId).trim(),
  );
  // spec/04 § Model — the composer's model readout is also the model control. The chosen
  // model is held here as PENDING until the host confirms it on `chat.state`;
  // the pill reads the pending value so the click has an effect, but marked as
  // not-yet-settled, because until the host answers the chat is still on the old
  // one. NO FALLBACK: a host that never answers is reported, not waited on
  // forever.
  const [modelOpen, setModelOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const modelAnchorRef = useRef<HTMLDivElement | null>(null);
  // The pop-up is PORTALLED to the body (the `crumb` variant), so it is not
  // inside the anchor and has to be a
  // click-off region in its own right — without it a pointer-down on the list
  // reads as a press outside, and the list closes before the click can ever
  // reach an option.
  const modelPopupRef = useRef<HTMLDivElement | null>(null);
  const modelPlacement = usePopupPlacement(modelAnchorRef, modelOpen);
  useDismissOnClickOff(modelOpen, [modelAnchorRef, modelPopupRef], () => setModelOpen(false));
  // The catalogue is per MACHINE — offering this surface's last-loaded list for
  // a chat on another host would show models that host cannot run. Loaded on
  // mount, not on open, because the pill itself reads the catalogue's name.
  // With no model reported there is no name to read, so the catalogue waits
  // for the pop-up to open instead.
  const wantsCatalogue = row.model != null || modelOpen;
  useEffect(() => {
    if (!wantsCatalogue) return;
    void loadModels(row.hostId === '' ? null : row.hostId);
  }, [row.hostId, wantsCatalogue]);
  // The host's answer IS the new `row.model`; landing on it settles the pill.
  useEffect(() => {
    if (pendingModel !== null && row.model === pendingModel) setPendingModel(null);
  }, [pendingModel, row.model]);
  useEffect(() => {
    if (pendingModel === null) return;
    const t = setTimeout(() => {
      setPendingModel(null);
      pushError(
        `${hostLabel} did not switch the model — this chat is still on ${row.model ?? 'its previous model'}`,
      );
    }, MODEL_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pendingModel, hostLabel, row.model, pushError]);

  // spec/04 § History — a cross-provider switch may cost more (no cache to
  // resume from), so the picker confirms it first unless the account has
  // turned that off (Settings has a toggle to bring it back). A same-provider
  // model change never shows it — there's no `row.model` to compare against
  // for a chat that hasn't spawned yet, so nothing to switch FROM either.
  const [providerSwitchTarget, setProviderSwitchTarget] = useState<string | null>(null);
  const suppressProviderSwitchWarning = usePreferencesStore(
    (s) => s.preferences.suppressProviderSwitchWarning,
  );

  function sendModelChange(modelId: string): void {
    setPendingModel(modelId);
    // Sent on the live socket, not REST: the acknowledgement is a broadcast
    // `chat.state`, which every surface holding this chat needs anyway.
    getActiveWs()?.send({ type: 'chat.model_request', chatId: row.chatId, model: modelId });
  }

  function chooseModel(modelId: string): void {
    setModelOpen(false);
    if (modelId === row.model) return;
    const crossProvider =
      row.model != null && harnessForModel(modelId) !== harnessForModel(row.model);
    if (crossProvider && !suppressProviderSwitchWarning) {
      setProviderSwitchTarget(modelId);
      return;
    }
    sendModelChange(modelId);
  }

  return (
    <>
      <ModelPicker
        selected={pendingModel ?? row.model}
        pending={pendingModel !== null}
        onSelect={chooseModel}
        open={modelOpen}
        onToggle={() => setModelOpen((v) => !v)}
        anchorRef={modelAnchorRef}
        popupRef={modelPopupRef}
        placement={modelPlacement}
        testId={testId}
        triggerLabel={triggerLabel}
        variant="crumb"
        // A switch lands on the NEXT turn, so while one is running the pop-up
        // says which turn it affects — presenting it as instant would
        // misdescribe the reply streaming underneath it (spec/04 § Model).
        note={
          row.activity === 'running'
            ? 'Applies to your next message — this turn keeps its model'
            : 'Applies to your next message'
        }
      />
      {providerSwitchTarget !== null && (
        <ProviderSwitchModal
          onCancel={() => setProviderSwitchTarget(null)}
          onSwitch={(dontShowAgain) => {
            const target = providerSwitchTarget;
            setProviderSwitchTarget(null);
            if (dontShowAgain) {
              void usePreferencesStore.getState().update({ suppressProviderSwitchWarning: true });
            }
            sendModelChange(target);
          }}
        />
      )}
    </>
  );
}
