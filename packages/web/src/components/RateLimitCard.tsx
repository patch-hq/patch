// The usage-limit card (spec/12 § A usage or rate limit): the turn that is not
// running yet, why, and what can be done about it. Full width of the chat.
//
// The same four controls are always drawn. One that cannot help is disabled
// with a tooltip saying why, never hidden (`lib/limitControls.ts`). A model
// change is not offered: a session or weekly limit covers every model on the
// account, so it cannot escape one.

import { useEffect, useState, type JSX } from 'react';
import {
  harnessForModel,
  LIMIT_BEHAVIOUR_LABELS,
  LimitBehaviour,
  type ChatStateEvent,
} from '@patch/wire';
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
import { useNavigate } from 'react-router-dom';
import { draftLinkedChat, linkedChatError } from '../lib/linkedChat.js';

const EXTRA_USAGE_URLS: Record<string, string> = {
  claude: EXTRA_USAGE_URL,
  codex: 'https://chatgpt.com/codex/settings/usage',
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function RateLimitCard({ row }: { row: ChatRow }): JSX.Element | null {
  // The body holds hooks that fetch; a chat with no limit must not run them.
  if (!row.rateLimitResumingAt && !row.limitBlock && row.creditReturned !== true) return null;
  return <RateLimitCardBody row={row} />;
}

function RateLimitCardBody({ row }: { row: ChatRow }): JSX.Element {
  const resumingAt = row.rateLimitResumingAt;
  const block = row.limitBlock ?? null;
  const behaviour = usePreferencesStore((s) => s.preferences.limitBehaviour);
  const limitNext = row.limitNext ?? null;
  const creditReturned = row.creditReturned === true;
  const shared = usePreferencesStore((s) => s.shared);
  const navigate = useNavigate();
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
    limitNext,
    creditReturned,
  });

  const limitName = capitalise(LIMIT_NAME[block?.scope ?? 'unknown']);
  const account = block?.accountLabel ? ` · ${block.accountLabel}` : '';
  const heading = creditReturned
    ? `Credit available again${account}`
    : isOverload
      ? 'Claude is busy right now'
      : `${limitName}${pastReset ? ' reset' : ''}${account}`;
  const sendLabel = creditReturned || limitNext === 'ask' ? 'Continue' : 'Send';
  const nextLine = isOverload ? null : limitNextText(limitNext, creditReturned);

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
  // spec/04 § Provider switches — another provider is a new chat linked to
  // this one. The draft's first message carries the request that met the
  // limit (still unanswered), for the user to read, edit and send.
  const moveToProvider = (target: string): void => {
    const model = getModelCatalog().models.find((m) => harnessForModel(m.id) === target);
    if (!model) {
      pushError(`No ${target} model is available on this host to switch to`);
      return;
    }
    draftLinkedChat(row.chatId, model.id).then(
      (path) => navigate(path),
      (err: unknown) => pushError(`Could not start a linked chat: ${linkedChatError(err)}`),
    );
  };
  // The catalogue is how "Change provider" finds a model to move to; it is
  // fetched when that menu opens, not for every card.
  const loadCatalogue = (): void => {
    if (row.hostId !== '') void loadModels(row.hostId);
  };
  const chooseProvider = (target: string): void => moveToProvider(target);

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
          <button
            type="button"
            className="limit-retry"
            data-testid="rate-limit-retry-icon"
            aria-label="Retry now"
            title="Retry now"
            onClick={send}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.8-4.07M13.5 2.5v3h-3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
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
        {nextLine !== null ? (
          <p className="limit-unsent" data-testid="rate-limit-next">
            {nextLine}
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
            {sendLabel}
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
            <select
              aria-label="When a limit is hit"
              value={behaviour}
              onChange={(e) =>
                void patchShared('limit behaviour', {
                  limitBehaviour: LimitBehaviour.parse(e.target.value),
                })
              }
              data-testid="rate-limit-behaviour"
            >
              {LimitBehaviour.options.map((b) => (
                <option key={b} value={b}>
                  {LIMIT_BEHAVIOUR_LABELS[b]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

/** What happens next, in one line, for a paused chat (spec/12 § A usage or rate limit). */
export function limitNextText(
  next: ChatStateEvent['limitNext'] | null,
  creditReturned: boolean,
): string | null {
  if (creditReturned) return 'Continue sends the message again.';
  switch (next) {
    case 'resume_at_reset':
      return 'Resumes on its own when the limit resets.';
    case 'other_account':
      return 'Continues on the next account with usage left.';
    case 'switch_provider':
      return 'Waiting for you to switch provider or send again.';
    case 'ask':
      return 'Out of credit. Nothing runs until you continue.';
    default:
      return null;
  }
}
