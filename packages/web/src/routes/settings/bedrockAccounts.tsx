// Claude on Amazon Bedrock accounts on Settings → Usage (spec/10 § Backend
// credentials, § Spending caps, § Settings; spec/14 § Credit sources).
//
// A Bedrock account is a Claude account with no sign-in: an AWS profile on one
// host, a region, where its requests run and a monthly cap. Its row names the
// host and shows the month's estimated spend against the cap; the add form
// offers only hosts that report AWS profiles, and only that host's profiles.
// The server asks the host to check the profile before it stores anything, so
// a refusal here is the server's own sentence.

import type { JSX } from 'react';
import { useState } from 'react';
import { create } from 'zustand';
import {
  bedrockAtCap,
  bedrockCapResetsAt,
  bedrockSpentThisMonth,
  type BedrockRegionPrefix,
  type ClaudeBedrock,
} from '@patch/wire';
import { api } from '../../api/rest.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { writeShared } from './sharedWrite.js';
import { Pills } from './ui.js';

/** What the Claude card's Add account has opened, if anything. */
export type ClaudeAdding =
  | null
  | { kind: 'subscription' }
  | { kind: 'bedrock' }
  | { kind: 'bedrock-edit'; accountId: string };

export const useClaudeAddStore = create<{
  adding: ClaudeAdding;
  setAdding: (next: ClaudeAdding) => void;
}>((set) => ({ adding: null, setAdding: (adding) => set({ adding }) }));

const PREFIXES: readonly BedrockRegionPrefix[] = ['auto', 'eu', 'us', 'apac', 'jp', 'au', 'global'];
const PREFIX_LABELS: Record<Exclude<BedrockRegionPrefix, 'auto'>, string> = {
  eu: 'EU',
  us: 'US',
  apac: 'APAC',
  jp: 'Japan',
  au: 'Australia',
  global: 'Global',
};

/**
 * Where `auto` sends a region's requests, as Claude Code derives the prefix
 * from the region's geography; `null` where the region names none of them.
 */
export function derivedPrefix(region: string): Exclude<BedrockRegionPrefix, 'auto'> | null {
  const geo = region.trim().toLowerCase().split('-')[0];
  if (geo === 'us') return 'us';
  if (geo === 'eu') return 'eu';
  if (geo === 'ap') return 'apac';
  return null;
}

function prefixLabels(region: string): Record<BedrockRegionPrefix, string> {
  const derived = derivedPrefix(region);
  return { auto: derived ? `Auto (${PREFIX_LABELS[derived]})` : 'Auto', ...PREFIX_LABELS };
}

/** Dollars as the row and the new-chat card say them: `$100`, `$18.42`. */
export function formatUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The month's spend against the cap, in words: `$18.42 of $100`. */
export function bedrockSpendText(bedrock: ClaudeBedrock, now: number = Date.now()): string {
  return `${formatUsd(bedrockSpentThisMonth(bedrock, now))} of ${formatUsd(bedrock.monthlyCapUsd)}`;
}

/** The cap's reset as a date: `Dec 1` (the first of next month, UTC). */
function resetDay(now: number): string {
  return new Date(bedrockCapResetsAt(now)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function useHostName(hostId: string): string {
  return usePresenceStore((s) => {
    const h = s.hosts[hostId];
    return h ? hostLabel(h) : hostId;
  });
}

/** A Bedrock row's labelled lines: where it runs, then its spend, or that it is signed out. */
export function BedrockLines({
  bedrock,
  signedOut,
  testid,
  now = Date.now(),
}: {
  bedrock: ClaudeBedrock;
  signedOut: boolean;
  testid: string;
  now?: number;
}): JSX.Element {
  const host = useHostName(bedrock.hostId);
  const spent = bedrockSpentThisMonth(bedrock, now);
  const fraction = Math.min(1, spent / bedrock.monthlyCapUsd);
  const line = (label: string, value: string, id: string, error = false): JSX.Element => (
    <div className="set-bar-row" data-testid={`${testid}-${id}`}>
      <span className="set-bar-label">{label}</span>
      <span className={`acct-val${error ? ' set-error' : ''}`}>{value}</span>
    </div>
  );
  return (
    <div className="set-bars" data-testid={testid}>
      {line('Host', host, 'host')}
      {line('AWS profile', bedrock.awsProfile, 'profile')}
      {line('Region', bedrock.awsRegion, 'region')}
      {signedOut ? (
        line('Status', 'AWS sign-in expired', 'status', true)
      ) : (
        <>
          <div
            className={`set-bar-row${bedrockAtCap(bedrock, now) ? ' blocked' : ''}`}
            data-testid={`${testid}-monthly`}
          >
            <span className="set-bar-label">Monthly</span>
            <span className="set-bar" aria-hidden="true">
              <i style={{ width: `${Math.round(fraction * 100)}%` }} />
            </span>
            <span className="set-bar-value">
              {Math.round((spent / bedrock.monthlyCapUsd) * 100)}%
            </span>
            <span className="set-bar-reset">resets {resetDay(now)}</span>
          </div>
          {line('Spent', `${bedrockSpendText(bedrock, now)} cap · estimated`, 'spent')}
        </>
      )}
    </div>
  );
}

/** The hosts a Bedrock account can run on: those reporting AWS profiles. */
function useBedrockHosts(): HostPresence[] {
  const hosts = usePresenceStore((s) => s.hosts);
  return sortHosts(Object.values(hosts).filter((h) => h.host?.awsProfiles !== undefined));
}

/** The cap as typed (`$100`, `100`, `12.50`), or null when it is not a positive amount. */
function parseCap(raw: string): number | null {
  const n = Number(raw.trim().replace(/^\$\s*/, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface BedrockFormValues {
  label: string;
  hostId: string;
  awsProfile: string;
  awsRegion: string;
  regionPrefix: BedrockRegionPrefix;
  monthlyCapUsd: number;
  auto: boolean;
}

/**
 * Add a Bedrock account, or edit one (`initial` filled in). Drawn in the
 * Claude card under the list; Cancel or a stored answer closes it.
 */
export function BedrockForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: BedrockFormValues;
  onSubmit: (values: BedrockFormValues) => Promise<boolean>;
  onCancel: () => void;
}): JSX.Element {
  const capable = useBedrockHosts();
  const [label, setLabel] = useState(initial?.label ?? '');
  // A new account starts on the first host that has a profile to offer.
  const [hostId, setHostId] = useState(
    initial?.hostId ??
      (capable.find((h) => (h.host?.awsProfiles?.length ?? 0) > 0) ?? capable[0])?.hostId ??
      '',
  );
  const [awsProfile, setAwsProfile] = useState(initial?.awsProfile ?? '');
  const [awsRegion, setAwsRegion] = useState(initial?.awsRegion ?? '');
  const [regionPrefix, setRegionPrefix] = useState<BedrockRegionPrefix>(
    initial?.regionPrefix ?? 'auto',
  );
  const [cap, setCap] = useState(initial ? formatUsd(initial.monthlyCapUsd) : '');
  const [auto, setAuto] = useState(initial?.auto ?? false);
  const [busy, setBusy] = useState(false);

  const allHosts = usePresenceStore((s) => s.hosts);
  // An edited account's own host stays choosable while it is offline.
  const hostIds = capable.map((h) => h.hostId);
  if (hostId !== '' && !hostIds.includes(hostId)) hostIds.push(hostId);
  const hostNames = Object.fromEntries(
    hostIds.map((id) => [id, allHosts[id] ? hostLabel(allHosts[id]) : id]),
  );
  const profiles = allHosts[hostId]?.host?.awsProfiles ?? [];
  const profileNames = profiles.map((p) => p.name);
  if (awsProfile !== '' && !profileNames.includes(awsProfile)) profileNames.push(awsProfile);

  const capUsd = parseCap(cap);
  const ready =
    !busy &&
    label.trim() !== '' &&
    hostId !== '' &&
    awsProfile !== '' &&
    awsRegion.trim() !== '' &&
    capUsd !== null;

  return (
    <form
      className="set-row stack set-form"
      data-testid="bedrock-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onSubmit({
          label: label.trim(),
          hostId,
          awsProfile,
          awsRegion: awsRegion.trim(),
          regionPrefix,
          monthlyCapUsd: capUsd,
          auto,
        }).then((ok) => {
          setBusy(false);
          if (ok) onCancel();
        });
      }}
    >
      <span className="set-row-title bedrock-form-title">
        {initial ? 'Edit Amazon Bedrock account' : 'Add Amazon Bedrock account'}
      </span>
      <label className="set-field">
        <span className="set-row-title">Name</span>
        <input
          value={label}
          data-testid="bedrock-name"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <div className="set-field">
        <span className="set-row-title">Host</span>
        {hostIds.length > 0 ? (
          <Pills
            label="Host"
            options={hostIds}
            value={hostId}
            labels={hostNames}
            testid="bedrock-host"
            onChange={(next) => {
              setHostId(next);
              setAwsProfile('');
            }}
          />
        ) : (
          <span className="set-sub warn" data-testid="bedrock-no-hosts">
            No host reports AWS profiles
          </span>
        )}
      </div>
      <div className="set-field">
        <span className="set-row-title">AWS profile</span>
        {profileNames.length > 0 ? (
          <Pills
            label="AWS profile"
            options={profileNames}
            value={awsProfile}
            testid="bedrock-profile"
            onChange={(next) => {
              setAwsProfile(next);
              const region = profiles.find((p) => p.name === next)?.region;
              if (region !== undefined) setAwsRegion(region);
            }}
          />
        ) : hostId !== '' ? (
          <span className="set-sub warn" data-testid="bedrock-no-profiles">
            {hostNames[hostId]} has no AWS profiles
          </span>
        ) : null}
      </div>
      <label className="set-field">
        <span className="set-row-title">Region</span>
        <input
          className="mono"
          value={awsRegion}
          data-testid="bedrock-region"
          onChange={(e) => setAwsRegion(e.target.value)}
        />
      </label>
      <div className="set-field">
        <span className="set-row-title">Requests run in</span>
        <Pills
          label="Requests run in"
          options={PREFIXES}
          value={regionPrefix}
          labels={prefixLabels(awsRegion)}
          testid="bedrock-prefix"
          onChange={setRegionPrefix}
        />
      </div>
      <label className="set-field">
        <span className="set-row-title">Monthly cap</span>
        <input
          className="mono bedrock-cap"
          value={cap}
          inputMode="decimal"
          data-testid="bedrock-cap"
          onChange={(e) => setCap(e.target.value)}
          onBlur={() => {
            if (capUsd !== null) setCap(formatUsd(capUsd));
          }}
        />
      </label>
      {/* An existing account's switch is the Auto box on its row: a second
          copy here would drift from it and overwrite it on save. */}
      {initial ? null : (
        <label className="acct-auto-label">
          <input
            type="checkbox"
            className="acct-auto"
            checked={auto}
            data-testid="bedrock-auto"
            onChange={(e) => setAuto(e.target.checked)}
          />{' '}
          Switch to automatically
        </label>
      )}
      <div className="set-actions">
        <span className="set-spacer" />
        <button
          type="button"
          className="set-btn ghost"
          data-testid="bedrock-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="set-btn primary"
          data-testid="bedrock-submit"
          disabled={!ready}
        >
          {initial ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  );
}

/** Store a new Bedrock account; the server checks the profile on its host first. */
export function addBedrock(values: BedrockFormValues): Promise<boolean> {
  return writeShared('add Bedrock account', () =>
    api.addAccount('claude-code', { bedrock: values }),
  );
}

/** Change what was edited on a Bedrock account, and only that. */
export function editBedrock(
  accountId: string,
  before: BedrockFormValues,
  after: BedrockFormValues,
): Promise<boolean> {
  const changed = Object.fromEntries(
    (Object.keys(after) as (keyof BedrockFormValues)[])
      .filter((k) => after[k] !== before[k])
      .map((k) => [k, after[k]]),
  ) as Partial<BedrockFormValues>;
  if (Object.keys(changed).length === 0) return Promise.resolve(true);
  return writeShared('edit Bedrock account', () =>
    api.updateAccount('claude-code', accountId, changed),
  );
}
