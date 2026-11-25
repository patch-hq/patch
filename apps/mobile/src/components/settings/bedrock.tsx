// Claude on Amazon Bedrock accounts in Settings → Usage (spec/10 § Settings,
// design/bedrock-accounts): the labelled lines a Bedrock row shows, the Auto
// checkbox every Claude row starts with, and the form that adds or edits a
// Bedrock account. A Bedrock account is an AWS profile on one host, so this is
// the one place on the page that names a host.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  bedrockSpentThisMonth,
  type BedrockRegionPrefix,
  type AwsProfileInfo,
  type ClaudeBedrock,
} from '@patch/wire';
import { api, type BedrockAccountFields } from '../../api/rest';
import {
  bedrockResets,
  bedrockSpend,
  PREFIX_LABEL,
  PREFIX_ORDER,
  prefixLabel,
} from '../../lib/bedrock';
import { fonts, radii, space, textMin, typography, useTheme } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { writeShared } from './sharedWrite';
import { ButtonRow, Chips, Field, FieldLabel, Muted, SettingsButton } from './ui';

/** How a Bedrock account whose host says its profile is signed out reads (spec/10 § Settings). */
export const AWS_SIGNED_OUT = 'AWS sign-in expired';

/** The `Bedrock` tag beside a Bedrock account's label. */
export function BedrockTag({ testID }: { testID?: string }): React.ReactElement {
  const colors = useTheme();
  return (
    <Text
      testID={testID}
      style={{
        ...typography.meta,
        color: colors.ink3,
        borderWidth: 1,
        borderColor: colors.divider,
        borderRadius: radii.pill,
        paddingHorizontal: space.xs + 2,
        overflow: 'hidden',
      }}
    >
      Bedrock
    </Text>
  );
}

/** Whether an account is in the order (spec/10 § Choosing an account): the box each Claude row starts with. */
export function AutoCheckbox({
  checked,
  label,
  testID,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  testID: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={() => onChange(!checked)}
      style={{
        width: 20,
        height: 20,
        borderRadius: radii.sm,
        borderWidth: 1.5,
        borderColor: checked ? colors.leaf : colors.divider,
        backgroundColor: checked ? colors.leaf : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {checked ? (
        <Text style={{ fontFamily: fonts.bodyBold, fontSize: textMin, color: colors.onAccent }}>
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One `Label  value` line under a Bedrock row. */
function Line({
  label,
  testID,
  children,
  danger = false,
}: {
  label: string;
  testID: string;
  children: React.ReactNode;
  danger?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View testID={testID} style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xs }}>
      <Text style={{ ...typography.meta, color: colors.ink3, width: 96 }}>{label}</Text>
      <Text
        style={{ ...typography.meta, flex: 1, color: danger ? colors.red : colors.ink2 }}
        numberOfLines={1}
      >
        {children}
      </Text>
    </View>
  );
}

/**
 * A Bedrock row's labelled lines: Host, AWS profile, Region, then the Monthly
 * bar and Spent — or, signed out, the Status line in their place.
 */
export function BedrockLines({
  bedrock,
  signedOut,
  testID,
  now = Date.now(),
}: {
  bedrock: ClaudeBedrock;
  signedOut: boolean;
  testID: string;
  now?: number;
}): React.ReactElement {
  const colors = useTheme();
  const hostName = usePresenceStore(
    (s) => s.hosts[bedrock.hostId]?.host?.hostName ?? bedrock.hostId,
  );
  const spent = bedrockSpentThisMonth(bedrock, now);
  const share = spent / bedrock.monthlyCapUsd;
  const pct = Math.min(100, Math.round(share * 100));
  const fill = share >= 1 ? colors.red : share >= 0.75 ? colors.amber : colors.leaf;
  return (
    <View testID={testID}>
      <Line label="Host" testID={`${testID}-host`}>
        {hostName}
      </Line>
      <Line label="AWS profile" testID={`${testID}-profile`}>
        {bedrock.awsProfile}
      </Line>
      <Line label="Region" testID={`${testID}-region`}>
        {bedrock.awsRegion}
        {bedrock.regionPrefix === 'auto' ? '' : ` · ${PREFIX_LABEL[bedrock.regionPrefix]}`}
      </Line>
      {signedOut ? (
        <Line label="Status" testID={`${testID}-status`} danger>
          {AWS_SIGNED_OUT}
        </Line>
      ) : (
        <>
          <View
            testID={`${testID}-monthly`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              marginTop: space.xs,
            }}
          >
            <Text style={{ ...typography.meta, color: colors.ink3, width: 96 }}>Monthly</Text>
            <View
              style={{
                flex: 1,
                height: 5,
                borderRadius: 3,
                backgroundColor: colors.bgSoft,
                overflow: 'hidden',
              }}
            >
              <View style={{ width: `${pct}%`, height: 5, backgroundColor: fill }} />
            </View>
            <Text style={{ ...typography.meta, color: colors.ink3 }}>
              {pct}% · resets {bedrockResets(now)}
            </Text>
          </View>
          <Line label="Spent" testID={`${testID}-spent`}>
            {bedrockSpend(bedrock, now)} cap · estimated
          </Line>
        </>
      )}
    </View>
  );
}

/** The hosts that run Bedrock accounts: those reporting `awsProfiles`, even none. */
function useBedrockHosts(): Array<{ hostId: string; name: string; profiles: AwsProfileInfo[] }> {
  const hosts = usePresenceStore((s) => s.hosts);
  return Object.values(hosts)
    .filter((h) => h.host?.awsProfiles !== undefined)
    .map((h) => ({
      hostId: h.hostId,
      name: h.host?.hostName ?? h.hostId,
      profiles: h.host?.awsProfiles ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What the form starts with when it edits an account. */
export interface BedrockFormInitial extends BedrockAccountFields {
  label: string;
  auto: boolean;
}

/**
 * Add (or, given `editing`, edit) a Bedrock account: Name, Host, AWS profile,
 * Region (filled from the profile's own), Requests run in, Monthly cap and
 * Switch to automatically (off). The host checks the profile before the
 * server stores it; a refusal is said in the server's words.
 */
export function BedrockForm({
  editing,
  onDone,
  testID = 'bedrock-form',
}: {
  editing?: { accountId: string; initial: BedrockFormInitial } | undefined;
  onDone: () => void;
  testID?: string;
}): React.ReactElement {
  const hosts = useBedrockHosts();
  const initial = editing?.initial;
  const [label, setLabel] = React.useState(initial?.label ?? '');
  const [hostId, setHostId] = React.useState<string | null>(
    initial?.hostId ?? (hosts.length === 1 ? hosts[0]!.hostId : null),
  );
  const [profile, setProfile] = React.useState<string | null>(initial?.awsProfile ?? null);
  const [region, setRegion] = React.useState(initial?.awsRegion ?? '');
  const [prefix, setPrefix] = React.useState<BedrockRegionPrefix>(initial?.regionPrefix ?? 'auto');
  const [cap, setCap] = React.useState(initial ? String(initial.monthlyCapUsd) : '');
  const [auto, setAuto] = React.useState(initial?.auto ?? false);
  const [saving, setSaving] = React.useState(false);

  const host = hosts.find((h) => h.hostId === hostId);
  // An edited account's host may not be reporting now; its stored profile still shows.
  const profiles = host?.profiles.map((p) => p.name) ?? [];
  if (profile !== null && !profiles.includes(profile)) profiles.unshift(profile);
  const hostOptions = hosts.map((h) => h.hostId);
  if (hostId !== null && !hostOptions.includes(hostId)) hostOptions.unshift(hostId);
  const hostName = (id: string): string => hosts.find((h) => h.hostId === id)?.name ?? id;

  const capUsd = Number(cap.trim().replace(/^\$/, ''));
  const capOk = cap.trim() !== '' && Number.isFinite(capUsd) && capUsd > 0;
  const ready =
    label.trim() !== '' && hostId !== null && profile !== null && region.trim() !== '' && capOk;

  const pickProfile = (name: string): void => {
    setProfile(name);
    const own = host?.profiles.find((p) => p.name === name)?.region;
    if (own !== undefined) setRegion(own);
  };

  const submit = (): void => {
    if (!ready || hostId === null || profile === null) return;
    const fields: BedrockAccountFields = {
      hostId,
      awsProfile: profile,
      awsRegion: region.trim(),
      regionPrefix: prefix,
      monthlyCapUsd: capUsd,
    };
    setSaving(true);
    const write = editing
      ? writeShared('Edit account', () =>
          api.updateAccount('claude-code', editing.accountId, {
            ...changed(editing.initial, fields),
            ...(label.trim() !== editing.initial.label ? { label: label.trim() } : {}),
          }),
        )
      : writeShared('Add account', () =>
          api.addBedrockAccount({ ...fields, label: label.trim(), auto }),
        );
    void write.then((ok) => {
      setSaving(false);
      if (ok) onDone();
    });
  };

  return (
    <View testID={testID} style={{ marginTop: space.sm }}>
      <Muted>{editing ? 'Edit Amazon Bedrock account' : 'Add Amazon Bedrock account'}</Muted>
      <FieldLabel>Name</FieldLabel>
      <Field
        testID={`${testID}-name`}
        accessibilityLabel="Name"
        value={label}
        onChangeText={setLabel}
        autoCapitalize="sentences"
      />
      <FieldLabel>Host</FieldLabel>
      {hostOptions.length === 0 ? (
        <Muted testID={`${testID}-no-hosts`}>No host has reported AWS profiles</Muted>
      ) : (
        <Chips
          options={hostOptions}
          selected={hostId ?? ''}
          labelOf={hostName}
          testIDPrefix={`${testID}-host`}
          labelPrefix="Host"
          onSelect={(id) => {
            if (id === hostId) return;
            setHostId(id);
            setProfile(null);
          }}
        />
      )}
      {hostId !== null ? (
        <>
          <FieldLabel>AWS profile</FieldLabel>
          {profiles.length === 0 ? (
            <Muted testID={`${testID}-no-profiles`}>No AWS profiles on {hostName(hostId)}</Muted>
          ) : (
            <Chips
              options={profiles}
              selected={profile ?? ''}
              testIDPrefix={`${testID}-profile`}
              labelPrefix="AWS profile"
              onSelect={pickProfile}
            />
          )}
        </>
      ) : null}
      <FieldLabel>Region</FieldLabel>
      <Field
        testID={`${testID}-region`}
        accessibilityLabel="Region"
        value={region}
        onChangeText={setRegion}
        placeholder="eu-west-2"
      />
      <FieldLabel>Requests run in</FieldLabel>
      <Chips
        options={PREFIX_ORDER}
        selected={prefix}
        labelOf={(p) => prefixLabel(p, region)}
        testIDPrefix={`${testID}-prefix`}
        labelPrefix="Requests run in"
        onSelect={setPrefix}
      />
      <FieldLabel>Monthly cap ($)</FieldLabel>
      <Field
        testID={`${testID}-cap`}
        accessibilityLabel="Monthly cap in dollars"
        value={cap}
        onChangeText={setCap}
        keyboardType="decimal-pad"
        placeholder="100"
      />
      {/* An existing account's switch is the Auto box on its row; a second
          copy here would drift from it and overwrite it on save. */}
      {editing ? null : (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}
        >
          <AutoCheckbox
            testID={`${testID}-auto`}
            label="Switch to automatically"
            checked={auto}
            onChange={setAuto}
          />
          <Muted>Switch to automatically</Muted>
        </View>
      )}
      <View style={{ marginTop: space.md }}>
        <ButtonRow>
          <SettingsButton
            testID={`${testID}-cancel`}
            label="Cancel"
            variant="ghost"
            onPress={onDone}
          />
          <SettingsButton
            testID={`${testID}-submit`}
            label={editing ? 'Save' : 'Add'}
            disabled={!ready || saving}
            onPress={submit}
          />
        </ButtonRow>
      </View>
    </View>
  );
}

/** The Bedrock fields an edit changed; a new host or profile is checked again by the server. */
function changed(
  before: BedrockAccountFields,
  after: BedrockAccountFields,
): Partial<BedrockAccountFields> {
  const out: Partial<BedrockAccountFields> = {};
  if (after.hostId !== before.hostId) out.hostId = after.hostId;
  if (after.awsProfile !== before.awsProfile) out.awsProfile = after.awsProfile;
  if (after.awsRegion !== before.awsRegion) out.awsRegion = after.awsRegion;
  if (after.regionPrefix !== before.regionPrefix) out.regionPrefix = after.regionPrefix;
  if (after.monthlyCapUsd !== before.monthlyCapUsd) out.monthlyCapUsd = after.monthlyCapUsd;
  return out;
}
