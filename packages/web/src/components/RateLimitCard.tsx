// The usage-limit card (spec/12 § A usage or rate limit): the turn that is not
// running yet, why, and what can be done about it. Full width of the chat.
//
// The same four controls are always drawn. One that cannot help is disabled
// with a tooltip saying why, never hidden (`lib/limitControls.ts`). A model
// change is not offered: a session or weekly limit covers every model on the
// account, so it cannot escape one.

import { useEffect, useState, type JSX } from 'react';
import { harnessForModel } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { getActiveWs } from '../api/ws.js';
import { patchShared } from '../routes/settings/sharedWrite.js';
import { getModelCatalog, loadModels } from '../lib/models.js';
import { EXTRA_USAGE_URL, LIMIT_NAME, formatReset, formatResetDetail } from '../lib/usage.js';
import { formatSpanShort, limitControls, type LimitControl } from '../lib/limitControls.js';
import { accountRows } from './UsagePopover.js';
import { LimitMenu } from './LimitMenu.js';
import { ProviderSwitchModal } from './ProviderSwitchModal.js';

const EXTRA_USAGE_URLS: Record<string, string> = {
  claude: EXTRA_USAGE_URL,
  codex: 'https://chatgpt.com/codex/settings/usage',
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function RateLimitCard({ row }: { row: ChatRow }): JSX.Element | null {
  // The body holds hooks that fetch; a chat with no limit must not run them.
  if (!row.rateLimitResumingAt && !row.limitBlock) return null;
  return <RateLimitCardBody row={row} />;
}

function RateLimitCardBody({ row }: { row: ChatRow }): JSX.Element {
  const resumingAt = row.rateLimitResumingAt;
  const block = row.limitBlock ?? null;
  const autoResume = usePreferencesStore((s) => s.preferences.autoResumeRateLimit);
  const shared = usePreferencesStore((s) => s.shared);
  const suppressSwitchWarning = usePreferencesStore(
    (s) => s.preferences.suppressProviderSwitchWarning,
  );
  const hosts = usePresenceStore((s) => s.hosts);
  const pushError = useUiStore((s) => s.pushError);

  // Nothing said when nothing stated a reset — an invented one reads as a
  // promise the limit has not made. Epoch 0 is not a stated reset.
  const rawResetsAt = block?.resetsAt ?? resumingAt ?? null;
  const resetsAt = rawResetsAt !== null && rawResetsAt > 0 ? rawResetsAt : null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resetsAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, [resetsAt]);

  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const pastReset = resetsAt !== null && resetsAt <= now;
  const isOverload = row.resumeKind === 'overloaded';
  const providerId = harnessForModel(row.model);
  const controls = limitControls({
    now,
    resetsAt,
    currentAccountId: block?.accountId ?? row.account?.id,
    currentProviderId: providerId,
    rows: accountRows(hosts, shared),
    overageBlocked: block?.overageBlocked === true,
  });

  const limitName = capitalise(LIMIT_NAME[block?.scope ?? 'unknown']);
  const account = block?.accountLabel ? ` · ${block.accountLabel}` : '';
  const heading = isOverload
    ? 'Claude is busy right now'
    : `${limitName}${pastReset ? ' reset' : ''}${account}`;

  const send = (): void => {
    getActiveWs()?.send({ type: 'chat.resume_now_request', chatId: row.chatId });
  };
  // Moving the chat is the way past the limit, so it re-sends the turn: Send
  // itself is waiting for a reset the new account or provider does not have.
  const chooseAccount = (accountId: string): void => {
    const ws = getActiveWs();
    ws?.send({ type: 'chat.account_request', chatId: row.chatId, preferredAccountId: accountId });
    send();
  };
  const moveToProvider = (target: string): void => {
    const model = getModelCatalog().models.find((m) => harnessForModel(m.id) === target);
    if (!model) {
      pushError(`No ${target} model is available on this machine to switch to`);
      return;
    }
    getActiveWs()?.send({ type: 'chat.model_request', chatId: row.chatId, model: model.id });
    send();
  };
  // The catalogue is how "Change provider" finds a model to move to; it is
  // fetched when that menu opens, not for every card.
  const loadCatalogue = (): void => {
    if (row.hostId !== '') void loadModels(row.hostId);
  };
  const chooseProvider = (target: string): void => {
    if (suppressSwitchWarning) moveToProvider(target);
    else setSwitchTarget(target);
  };

  const btn = (key: 'account' | 'provider' | 'send'): string =>
    controls.main === key ? 'limit-btn limit-btn-main' : 'limit-btn';
  const disabledProps = (c: LimitControl): { 'aria-disabled'?: true; title?: string } =>
    c.enabled ? {} : { 'aria-disabled': true, title: c.reason };

  const extraUrl = EXTRA_USAGE_URLS[providerId] ?? EXTRA_USAGE_URL;
  return (
    <div className="msg msg-system rate-limit-bubble" data-testid="rate-limit-bar">
      <div className="content">
        <div className="limit-head">
          <p className="rate-limit-headline" data-testid="rate-limit-headline">
            {heading}
          </p>
          {resetsAt === null ? null : (
            <span
              className="limit-when"
              data-testid="rate-limit-countdown"
              title={formatResetDetail(resetsAt)}
            >
              {pastReset
                ? `${formatSpanShort(Math.max(1, now - resetsAt))} ago`
                : `Resets in ${formatSpanShort(resetsAt - now)} · ${formatReset(resetsAt, now)}`}
            </span>
          )}
        </div>
        {pastReset ? (
          <p className="limit-unsent" data-testid="rate-limit-unsent">
            Message not sent
          </p>
        ) : null}

        <div className="limit-actions">
          <button
            type="button"
            className={btn('send')}
            data-testid="rate-limit-send"
            data-enabled={controls.send.enabled ? 'true' : 'false'}
            {...disabledProps(controls.send)}
            onClick={() => {
              if (controls.send.enabled) send();
            }}
          >
            Send
          </button>
          <LimitMenu
            kind="account"
            label="Change account"
            control={controls.account}
            main={controls.main === 'account'}
            choose={chooseAccount}
          />
          <LimitMenu
            kind="provider"
            label="Change provider"
            control={controls.provider}
            main={controls.main === 'provider'}
            onOpen={loadCatalogue}
            choose={chooseProvider}
          />
          {controls.extraUsage.enabled ? (
            <a
              className="limit-btn"
              data-testid="rate-limit-extra-usage"
              data-enabled="true"
              href={extraUrl}
              target="_blank"
              rel="noreferrer"
            >
              Extra usage ↗
            </a>
          ) : (
            <span
              className="limit-btn"
              data-testid="rate-limit-extra-usage"
              data-enabled="false"
              aria-disabled="true"
              title={controls.extraUsage.reason}
            >
              Extra usage ↗
            </span>
          )}
          <label className="limit-auto">
            <input
              type="checkbox"
              role="switch"
              checked={autoResume}
              onChange={() => void patchShared('auto-resume', { autoResumeRateLimit: !autoResume })}
              data-testid="rate-limit-auto-resume"
            />
            Auto-resume
          </label>
        </div>
      </div>
      {switchTarget !== null ? (
        <ProviderSwitchModal
          onCancel={() => setSwitchTarget(null)}
          onSwitch={(dontShowAgain) => {
            const target = switchTarget;
            setSwitchTarget(null);
            if (dontShowAgain) {
              void usePreferencesStore.getState().update({ suppressProviderSwitchWarning: true });
            }
            moveToProvider(target);
          }}
        />
      ) : null}
    </div>
  );
}
