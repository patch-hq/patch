// Settings → Hosts and Settings → Keys (design/settings-redesign; spec/02 §
// Host identity, § Provider keys).
//
// Hosts — Add a host (the server's install command and a single-use pairing
// code), then one row per host: a presence dot, its name, platform and when
// it was last seen, Update when it is behind. Tapping a row opens that host
// (app/hosts/[hostId]/index.tsx → HostDetail): its name, the
// state of its agent backends with Sign in, its optional components, its Files
// and Terminal, Replace with… and Remove this host.
//
// Keys — the picked host's provider keys, then the account's Secrets.
//
// A host that has not reported yet is shown as awaiting its first report,
// never given a fabricated name or platform. Every edit is addressed to that
// host and refused up front, naming it, when it cannot hear it.

import React from 'react';
import { Alert, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  acpBackendStatus,
  backendStatus,
  isAcpBackendRow,
  endpointIdFor,
  providerDescriptor,
  providerForBackendId,
  providerKeyInfo,
  type ModelEndpoint,
  type ModelEndpointApi,
  type ProviderKeyId,
} from '@patch/wire';
import { api, ApiError, type ReplaceHostPlan, type SharedState } from '../../api/rest';
import { useExperimentalFeatures, useSettingsStore } from '../../stores/settingsStore';
import { patchShared, writeShared } from './sharedWrite';
import { filesRoute, formatSize, terminalRoute } from '../../lib/hostFiles';
import { fonts, space, typography, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { useUiStore } from '../../stores/uiStore';
import { SettingsSection } from '../SettingsSection';
import { agoLabel, sendToHost } from './hostSend';
import { NoticeRow, hostName, sortedHosts } from './HostSwitcher';
import { ClaudeSettingsRow } from './ClaudeSettingsSection';
import { ProviderOwnSettings } from './ProviderOwnSettings';
import { SecretsSection } from './SecretsSection';
import { PROVIDERS } from './providers';
import { SettingsPage } from './SettingsPage';
import { ButtonRow, Chevron, Dot, ErrorLine, Field, Muted, Row, SettingsButton } from './ui';

/** How a host's `platform` reads: macOS, Linux, Windows, else as reported. */
export function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  return platform;
}

/** `macOS · online` / `Linux · seen 3h ago` — a host row's second line. */
export function hostSubtitle(h: HostPresence, now: number = Date.now()): string {
  if (!h.host) return 'awaiting first report';
  const where = platformLabel(h.host.platform);
  return `${where} · ${h.online ? 'online' : `seen ${agoLabel(h.lastSeenAt, now)}`}`;
}

// ── Hosts ────────────────────────────────────────────────────────────────────

export function HostsPage(): React.ReactElement {
  const [adding, setAdding] = React.useState(false);
  return (
    <SettingsPage
      title="Hosts"
      testID="settings-page-hosts"
      right={
        adding ? null : (
          <SettingsButton testID="add-host" label="Add a host" onPress={() => setAdding(true)} />
        )
      }
    >
      {adding ? <AddHost onClose={() => setAdding(false)} /> : null}
      <HostsSection />
    </SettingsPage>
  );
}

/** Every registered host, one row each, opening its own page. */
export function HostsSection(): React.ReactElement {
  const router = useRouter();
  const hosts = usePresenceStore((s) => s.hosts);
  const rows = sortedHosts(hosts);
  return (
    <SettingsSection testID="settings-hosts">
      {rows.length === 0 ? (
        <NoticeRow testID="hosts-empty" text="No hosts yet" />
      ) : (
        rows.map((h) => (
          <Row
            key={h.hostId}
            testID={`host-${h.hostId}`}
            accessibilityLabel={hostName(h)}
            onPress={() =>
              router.push({ pathname: '/hosts/[hostId]', params: { hostId: h.hostId } })
            }
            leading={<Dot on={h.online} />}
            title={hostName(h)}
            titleTestID={`host-${h.hostId}-name`}
            subtitle={hostSubtitle(h)}
            subtitleTestID={`host-${h.hostId}-status`}
            right={
              <>
                {h.host?.updateAvailable ? (
                  <SettingsButton
                    testID={`host-${h.hostId}-update`}
                    label="Update"
                    variant="quiet"
                    disabled={!h.online}
                    onPress={() =>
                      void sendToHost(h.hostId, { type: 'host.update', hostId: h.hostId }, 'Update')
                    }
                  />
                ) : null}
                <Chevron />
              </>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

/**
 * One host's own page. Its name (renamable), Update, the state of
 * its agent backends with Sign in on any that needs one, its optional
 * components, Files and Terminal, and Remove this host.
 */
export function HostDetail({ hostId }: { hostId: string }): React.ReactElement {
  const router = useRouter();
  const host = usePresenceStore((s) => s.hosts[hostId] ?? null);
  const seen = React.useRef(false);
  if (host !== null) seen.current = true;

  // Removed while open (here, or by another surface's `host.removed`): there
  // is nothing left to show, so go back to the list.
  React.useEffect(() => {
    if (host === null && seen.current) router.back();
  }, [host, router]);

  if (host === null) {
    return (
      <SettingsPage title={hostId} testID="settings-host-detail">
        <SettingsSection>
          <NoticeRow testID="host-detail-gone" text="This host is no longer on the account" />
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={hostName(host)} testID="settings-host-detail">
      {host.host === null ? (
        <SettingsSection>
          <Row
            title={hostId}
            subtitle="awaiting first report"
            subtitleTestID={`host-${hostId}-status`}
          />
        </SettingsSection>
      ) : (
        <>
          <HostIdentity host={host} />
          <HostSettingsState host={host} />
          <HostBackends host={host} />
          <HostComponents host={host} />
          <HostTools host={host} />
          <ClaudeSettingsRow host={host} />
        </>
      )}
      <ReplaceHost host={host} />
      <RemoveHost host={host} />
    </SettingsPage>
  );
}

/**
 * Which version of the shared settings this host runs (spec/01 § Settings):
 * behind, or refusing part of it, is said by name.
 */
function HostSettingsState({ host }: { host: HostPresence }): React.ReactElement | null {
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  if (shared === null) return null;
  const state = shared.hosts.find((h) => h.hostId === host.hostId);
  const text = state?.error
    ? `Could not apply: ${state.error}`
    : state?.appliedVersion === undefined
      ? host.online
        ? 'Not applied yet'
        : 'Gets them when it reconnects'
      : state.appliedVersion === shared.version
        ? 'Up to date'
        : host.online
          ? 'Updating'
          : 'Gets the latest when it reconnects';
  return (
    <SettingsSection testID={`host-${host.hostId}-settings-version`}>
      <Row title="Settings" subtitle={text} subtitleTestID={`host-${host.hostId}-settings-state`} />
    </SettingsSection>
  );
}

/** Name (renamable), presence, platform and version with Update, and home. */
function HostIdentity({ host }: { host: HostPresence }): React.ReactElement | null {
  const report = host.host;
  const hostId = host.hostId;
  const [draft, setDraft] = React.useState(report?.hostName ?? '');
  React.useEffect(() => setDraft(report?.hostName ?? ''), [report?.hostName]);
  if (!report) return null;

  const commitRename = (): void => {
    const next = draft.trim();
    if (next.length === 0) {
      // A host must always have a name.
      Alert.alert('Rename failed', 'A host name cannot be empty.');
      setDraft(report.hostName);
      return;
    }
    if (next === report.hostName) return;
    if (!sendToHost(hostId, { type: 'host.rename', hostId, hostName: next }, 'Rename')) {
      setDraft(report.hostName);
    }
  };

  return (
    <SettingsSection testID={`host-${hostId}`}>
      <Row
        title="Name"
        right={
          <>
            <Field
              testID={`host-${hostId}-name-input`}
              accessibilityLabel="Host name"
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={commitRename}
              editable={host.online}
              style={{ width: 150 }}
            />
            {draft.trim() !== report.hostName ? (
              <SettingsButton
                testID={`host-${hostId}-rename-save`}
                label="Save"
                disabled={draft.trim() === '' || !host.online}
                onPress={commitRename}
              />
            ) : null}
          </>
        }
      />
      <Row
        leading={<Dot on={host.online} />}
        title={host.online ? 'Online' : 'Offline'}
        subtitle={host.online ? undefined : `seen ${agoLabel(host.lastSeenAt)}`}
        titleTestID={`host-${hostId}-status`}
      />
      <Row
        title={`${platformLabel(report.platform)} ${report.arch}`}
        titleTestID={`host-${hostId}-platform`}
        subtitle={`Host ${report.hostVersion}`}
        right={
          report.updateAvailable ? (
            <SettingsButton
              testID={`host-${hostId}-update`}
              label="Update"
              variant="quiet"
              disabled={!host.online}
              onPress={() => void sendToHost(hostId, { type: 'host.update', hostId }, 'Update')}
            />
          ) : null
        }
      />
    </SettingsSection>
  );
}

/** The host's agent backends and their state, with Sign in where one is needed. */
function HostBackends({ host }: { host: HostPresence }): React.ReactElement | null {
  const router = useRouter();
  const report = host.host;
  const hostId = host.hostId;
  const [signingIn, setSigningIn] = React.useState<string | null>(null);
  const [token, setToken] = React.useState('');
  const [openDetails, setOpenDetails] = React.useState<string | null>(null);
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  if (!report || report.backends.length === 0) return null;
  return (
    <SettingsSection title="Agents" testID={`host-${hostId}-backends`}>
      {report.backends.map((b) => {
        const provider = PROVIDERS.find((p) => p.id === b.id);
        const status = isAcpBackendRow(b.id)
          ? acpBackendStatus(b)
          : backendStatus(b, shared === null ? null : (provider?.rows(shared.secrets) ?? []));
        return (
          <Row
            key={b.id}
            title={b.label}
            subtitle={`${b.version ? `${b.version} · ` : ''}${status.text}${status.details !== undefined && openDetails === b.id ? ` — ${status.details}` : ''}`}
            subtitleTestID={`host-${hostId}-backend-${b.id}`}
            right={
              // A backend that is logged out or absent is the one state to act on.
              status.needsSignIn ? (
                <SettingsButton
                  testID={`host-${hostId}-backend-${b.id}-connect`}
                  label="Sign in"
                  variant="quiet"
                  disabled={!host.online}
                  accessibilityLabel={`Sign in to ${b.label}`}
                  onPress={() => {
                    if (!host.online) {
                      Alert.alert(
                        'Sign in failed',
                        `${report.hostName} is offline. Sign in once it reconnects.`,
                      );
                      return;
                    }
                    if (
                      providerDescriptor(providerForBackendId(b.id)).hostSignIn === 'accountFlow'
                    ) {
                      // The provider's own sign-in lives on Usage, where its form is.
                      useUiStore.getState().setCodexSignInHost(hostId);
                      router.push({ pathname: '/settings/[page]', params: { page: 'usage' } });
                      return;
                    }
                    setToken('');
                    setSigningIn((cur) => (cur === b.id ? null : b.id));
                  }}
                />
              ) : null
            }
          >
            {status.details !== undefined ? (
              <SettingsButton
                testID={`host-${hostId}-backend-${b.id}-details-toggle`}
                label="Details"
                variant="quiet"
                onPress={() => setOpenDetails((cur) => (cur === b.id ? null : b.id))}
              />
            ) : null}
            {signingIn === b.id ? (
              <View style={{ marginTop: space.sm, gap: space.sm }}>
                <Field
                  testID={`host-${hostId}-signin-token`}
                  accessibilityLabel="Token"
                  value={token}
                  onChangeText={setToken}
                  placeholder="sk-ant-oat01-… (empty uses this host's own login)"
                  secureTextEntry
                />
                <SettingsButton
                  testID={`host-${hostId}-signin-submit`}
                  label="Sign in"
                  onPress={() => {
                    // A Claude account is shared by every host (spec/01 § Settings):
                    // a pasted token is added for all of them; an empty one adopts
                    // the login already on this host.
                    const t = token.trim();
                    void writeShared('Sign in', () =>
                      t
                        ? api.addAccount('claude-code', { token: t })
                        : api.adoptAccount('claude-code', hostId),
                    ).then((ok) => {
                      if (ok) {
                        setSigningIn(null);
                        setToken('');
                      }
                    });
                  }}
                />
              </View>
            ) : null}
          </Row>
        );
      })}
    </SettingsSection>
  );
}

/** The host's optional components (spec/02 § Optional components). */
function HostComponents({ host }: { host: HostPresence }): React.ReactElement | null {
  const report = host.host;
  const hostId = host.hostId;
  if (!report || report.components.length === 0) return null;
  return (
    <SettingsSection title="Components" testID={`host-${hostId}-components`}>
      {report.components.map((c) => {
        const state =
          c.state === 'downloading'
            ? `downloading ${Math.round((c.progress ?? 0) * 100)}%`
            : c.state === 'failed'
              ? `failed${c.error ? ` — ${c.error}` : ''}`
              : c.state === 'installed'
                ? 'installed'
                : formatSize(c.bytes);
        return (
          <Row
            key={c.id}
            testID={`host-${hostId}-component-${c.id}`}
            title={c.label}
            subtitle={state}
            right={
              c.state === 'installed' ? (
                <SettingsButton
                  testID={`host-${hostId}-component-${c.id}-remove`}
                  label="Remove"
                  variant="danger"
                  onPress={() =>
                    Alert.alert(`Remove ${c.label}?`, `Delete it from ${report.hostName}.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () =>
                          void sendToHost(
                            hostId,
                            { type: 'host.component_remove', hostId, componentId: c.id },
                            'Remove',
                          ),
                      },
                    ])
                  }
                />
              ) : c.state === 'downloading' ? null : (
                <SettingsButton
                  testID={`host-${hostId}-component-${c.id}-install`}
                  label={c.state === 'failed' ? 'Retry' : 'Install'}
                  variant="quiet"
                  onPress={() =>
                    void sendToHost(
                      hostId,
                      { type: 'host.component_install', hostId, componentId: c.id },
                      'Install',
                    )
                  }
                />
              )
            }
          />
        );
      })}
    </SettingsSection>
  );
}

/**
 * Files and Terminal for this host (spec/15 § Host files and terminal).
 * Unpressable while the host or the link is down: a screen that opened only
 * to fail would be a worse answer than a dimmed row.
 */
function HostTools({ host }: { host: HostPresence }): React.ReactElement | null {
  const router = useRouter();
  const colors = useTheme();
  const experimental = useExperimentalFeatures();
  const conn = usePresenceStore((s) => s.connection);
  const reachable = conn === 'connected' && host.online;
  const tool = (key: 'files' | 'terminal', label: string, go: () => void): React.ReactElement => (
    <Row
      testID={`host-${host.hostId}-${key}`}
      accessibilityLabel={label}
      title={label}
      titleColor={reachable ? colors.ink : colors.inkFaint}
      onPress={reachable ? go : undefined}
      right={<Chevron />}
    />
  );
  if (!experimental) return null;
  return (
    <SettingsSection title="Tools" testID={`host-${host.hostId}-tools`}>
      {tool('files', 'Files', () => router.push(filesRoute(host.hostId)))}
      {tool('terminal', 'Terminal', () => router.push(terminalRoute(host.hostId)))}
    </SettingsSection>
  );
}

/**
 * Replace with… (spec/11 § Replacing a host): a new machine takes over every
 * chat of this host. Choosing it asks the new host which of this host's
 * folders it has; each folder and each provider's session store is listed to
 * carry across unchanged. Replacing moves every chat, hands over held messages
 * and removes this host. A missing folder is gone ahead without only when the
 * user says so.
 */
function ReplaceHost({ host }: { host: HostPresence }): React.ReactElement | null {
  const hosts = usePresenceStore((s) => s.hosts);
  const [plan, setPlan] = React.useState<ReplaceHostPlan | null>(null);
  const [busy, setBusy] = React.useState(false);
  const others = sortedHosts(hosts).filter((h) => h.hostId !== host.hostId);
  if (others.length === 0) return null;

  const check = async (withHostId: string): Promise<void> => {
    setBusy(true);
    try {
      setPlan(await api.replaceHostPlan(host.hostId, withHostId));
    } catch (e) {
      Alert.alert('Checking the new host failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = (): void => {
    Alert.alert('Replace with', undefined, [
      ...others.map((h) => ({ text: hostName(h), onPress: () => void check(h.hostId) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };
  const replace = async (p: ReplaceHostPlan): Promise<void> => {
    setBusy(true);
    try {
      await api.replaceHost(host.hostId, p.to.hostId, p.missing);
      usePresenceStore.getState().removeHost(host.hostId);
    } catch (e) {
      Alert.alert('Replacing the host failed', (e as Error).message);
      setBusy(false);
    }
  };
  const confirm = (p: ReplaceHostPlan): void => {
    if (p.missing.length === 0) {
      void replace(p);
      return;
    }
    Alert.alert(
      `Replace without ${p.missing.length === 1 ? 'a folder' : `${p.missing.length} folders`}?`,
      `${p.to.name} does not have ${p.missing.join(', ')}. Chats in ${p.missing.length === 1 ? 'it' : 'them'} move but cannot run until the folder is there.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: () => void replace(p) },
      ],
    );
  };

  return (
    <SettingsSection>
      <Row
        title="Replace with"
        onPress={plan || busy ? undefined : choose}
        testID={`host-${host.hostId}-replace`}
        right={plan ? undefined : <Chevron />}
      />
      {plan ? (
        <Row
          title={`${plan.to.name} takes over ${plan.chats} ${plan.chats === 1 ? 'chat' : 'chats'}`}
          subtitle="Carry each folder and session store to the same path."
          testID={`host-${host.hostId}-replace-plan`}
          stack
        >
          {plan.folders.map((f) =>
            f.present ? (
              <Muted key={f.folder} testID="replace-folder">
                {f.folder} · present
              </Muted>
            ) : (
              <ErrorLine
                key={f.folder}
                testID="replace-folder-missing"
                message={`${f.folder} · missing`}
              />
            ),
          )}
          {plan.sessions.map((s) => (
            <Muted key={`${s.provider}:${s.path}`} testID="replace-session">
              {s.provider} {s.path}
            </Muted>
          ))}
          {plan.sessions.length > 0 ? (
            <Muted testID="replace-assumed-home">
              Assumes {plan.from.name} keeps Patch in {plan.assumedHome}
            </Muted>
          ) : null}
          {plan.jobs.map((j) => (
            <Muted key={j.jobId} testID="replace-job">
              Job moves: {j.name}
            </Muted>
          ))}
          <ButtonRow>
            <SettingsButton
              testID="replace-cancel"
              label="Cancel"
              variant="ghost"
              disabled={busy}
              onPress={() => setPlan(null)}
            />
            <SettingsButton
              testID="replace-recheck"
              label="Check again"
              variant="ghost"
              disabled={busy}
              onPress={() => void check(plan.to.hostId)}
            />
            <SettingsButton
              testID="replace-confirm"
              label={busy ? 'Replacing…' : 'Replace'}
              variant="danger"
              disabled={busy}
              onPress={() => confirm(plan)}
            />
          </ButtonRow>
        </Row>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Remove this host from the account (`DELETE /api/hosts/:hostId`). Its
 * credential is revoked, so it cannot reconnect without being paired again —
 * asked first. The host is dropped here as soon as the server says so (every
 * surface is also sent `host.removed`).
 */
function RemoveHost({ host }: { host: HostPresence }): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const name = hostName(host);
  // The Manager never moves by itself (spec/06 § Changing home): its home is
  // removed only after the user has chosen another one.
  const ask = async (): Promise<void> => {
    const others = Object.keys(usePresenceStore.getState().hosts).filter(
      (id) => id !== host.hostId,
    );
    if (others.length > 0) {
      let home: string | null;
      try {
        home = (await api.managerHome()).hostId;
      } catch (e) {
        Alert.alert('Remove failed', (e as Error).message);
        return;
      }
      if (home === host.hostId) {
        Alert.alert(
          `${name} is the Manager's home`,
          `Choose a new home for the Manager before removing ${name}.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Choose new home',
              onPress: () =>
                router.push({ pathname: '/settings/[page]', params: { page: 'manager' } }),
            },
          ],
        );
        return;
      }
    }
    Alert.alert(
      `Remove ${name}?`,
      `${name} is signed out and has to be paired again to come back.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void remove() },
      ],
    );
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.removeHost(host.hostId);
      usePresenceStore.getState().removeHost(host.hostId);
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 404
          ? `${name} is not on this account any more.`
          : (e as Error).message;
      Alert.alert('Remove failed', message);
      setBusy(false);
    }
  };
  return (
    <SettingsSection>
      <Row
        title="Remove this host"
        right={
          <SettingsButton
            testID={`host-${host.hostId}-remove`}
            label={busy ? 'Removing…' : 'Remove'}
            variant="danger"
            disabled={busy}
            onPress={() => void ask()}
          />
        }
      />
    </SettingsSection>
  );
}

// ── Add a host ───────────────────────────────────────────────────────────────

/** The server's refusal, said in words rather than as a code. */
function installCommandProblem(message: string): string {
  if (message.startsWith('nothing_published')) {
    return 'No host build has been published yet.';
  }
  if (message.startsWith('no_build_for_os')) {
    return 'No host build has been published for that operating system yet.';
  }
  if (message.startsWith('no_public_url')) {
    return 'This server has no public address configured.';
  }
  return message;
}

/** Which operating systems the server has actually published a build for. */
function osOptionsFrom(targets: string[]): { value: 'macos' | 'linux'; label: string }[] {
  const out: { value: 'macos' | 'linux'; label: string }[] = [];
  if (targets.some((t) => t.startsWith('darwin-'))) out.push({ value: 'macos', label: 'macOS' });
  if (targets.some((t) => t.startsWith('linux-'))) out.push({ value: 'linux', label: 'Linux' });
  return out;
}

type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ok'; value: T }
  | { state: 'error'; error: string };

/**
 * Add a host: the install command and the single-use pairing code BOTH come
 * from the server — this screen mints nothing and composes no command. Nothing
 * published means nothing to install, and it says so rather than showing a code
 * for a flow whose first step does not exist.
 */
function AddHost({ onClose }: { onClose: () => void }): React.ReactElement {
  const theme = useTheme();
  const [platforms, setPlatforms] = React.useState<
    Loaded<{ value: 'macos' | 'linux'; label: string }[]>
  >({ state: 'loading' });
  const [command, setCommand] = React.useState<Loaded<string>>({ state: 'loading' });
  const [code, setCode] = React.useState<Loaded<string>>({ state: 'loading' });

  const mintCode = React.useCallback(() => {
    setCode({ state: 'loading' });
    void api
      .hostPairStart()
      .then((r) => setCode({ state: 'ok', value: r.nonce }))
      .catch((e: Error) => setCode({ state: 'error', error: e.message }));
  }, []);

  React.useEffect(() => {
    let live = true;
    void api
      .hostManifest()
      .then((m) => {
        if (!live) return;
        const published = Array.isArray(m.artifacts) ? m.artifacts : [];
        const options = osOptionsFrom(published.map((a) => a.target));
        setPlatforms({ state: 'ok', value: options });
        const chosen = options[0];
        if (!chosen) return;
        mintCode();
        void api
          .hostInstallCommand(chosen.value)
          .then((r) => live && setCommand({ state: 'ok', value: r.command }))
          .catch((e: Error) => live && setCommand({ state: 'error', error: e.message }));
      })
      .catch((e: Error) => live && setPlatforms({ state: 'error', error: e.message }));
    return () => {
      live = false;
    };
  }, [mintCode]);

  // Codes last five minutes; re-mint just before that while one is on screen.
  const showingCode = platforms.state === 'ok' && platforms.value.length > 0;
  React.useEffect(() => {
    if (!showingCode) return;
    const timer = setInterval(mintCode, 4.5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [showingCode, mintCode]);

  const nothingPublished =
    platforms.state === 'error' || (platforms.state === 'ok' && platforms.value.length === 0);

  return (
    <SettingsSection title="Add a host" testID="add-host-panel">
      {platforms.state === 'loading' ? <NoticeRow text="…" /> : null}
      {nothingPublished ? (
        <NoticeRow testID="add-host-error" text="No host build has been published yet" />
      ) : null}
      {platforms.state === 'ok' && platforms.value.length > 0 ? (
        <>
          <Row
            title="Run on the new host"
            subtitle={`Builds: ${platforms.value.map((o) => o.label).join(', ')}`}
            subtitleTestID="add-host-platforms"
            stack
          >
            {command.state === 'ok' ? (
              <Text
                testID="add-host-command"
                selectable
                style={{ ...typography.code, color: theme.ink, marginTop: space.sm }}
              >
                {command.value}
              </Text>
            ) : command.state === 'error' ? (
              <ErrorLine
                testID="add-host-command-error"
                message={installCommandProblem(command.error)}
              />
            ) : (
              <Muted>…</Muted>
            )}
          </Row>
          <Row
            title="Pairing code"
            right={
              code.state === 'ok' ? (
                <Text
                  testID="pairing-code"
                  selectable
                  style={{
                    fontFamily: fonts.bodyMedium,
                    fontSize: 20,
                    letterSpacing: 2,
                    color: theme.ink,
                  }}
                >
                  {code.value}
                </Text>
              ) : code.state === 'loading' ? (
                <Muted testID="pairing-code-loading">Issuing…</Muted>
              ) : null
            }
          >
            {code.state === 'error' ? (
              <ErrorLine
                testID="pairing-code-error"
                message={`Couldn’t issue a pairing code: ${code.error}`}
                onRetry={mintCode}
              />
            ) : null}
          </Row>
        </>
      ) : null}
      <View
        style={{
          padding: space.md,
          flexDirection: 'row',
          justifyContent: 'flex-end',
          borderTopWidth: 1,
          borderColor: theme.lineSoft,
        }}
      >
        <SettingsButton testID="add-host-close" label="Close" variant="quiet" onPress={onClose} />
      </View>
    </SettingsSection>
  );
}

// ── Providers ────────────────────────────────────────────────────────────────

export function ProvidersPage(): React.ReactElement {
  return (
    <SettingsPage title="Providers" testID="settings-page-providers">
      <ProviderKeys />
      <ProviderOwnSettings />
      <ModelEndpoints />
      <SecretsSection />
    </SettingsPage>
  );
}

/**
 * The account's provider keys (spec/02 § Provider keys) — Gemini, OpenAI
 * Realtime, Groq — shared settings held on the server and sent to every host,
 * each stating whether it is set and its last four characters, never the
 * value. A key only some hosts' environments supply names them and can be
 * used for every host. Separate from Secrets (which are injected into chats).
 */
export function ProviderKeys(): React.ReactElement {
  const conn = usePresenceStore((s) => s.connection);
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  const [editing, setEditing] = React.useState<ProviderKeyId | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (shared === null) {
    return (
      <SettingsSection title="Provider keys" testID="providers-keys">
        <NoticeRow testID="providers-keys-loading" text="Settings haven’t loaded yet" />
      </SettingsSection>
    );
  }
  const reachable = conn === 'connected';
  const envHosts = (id: ProviderKeyId): HostPresence[] =>
    Object.values(hosts).filter(
      (h) => h.online && h.host?.providerKeys?.some((k) => k.id === id && k.envSet),
    );
  const run = async (what: string, call: () => Promise<SharedState>): Promise<boolean> => {
    setBusy(true);
    try {
      return await writeShared(what, call);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Provider keys" testID="providers-keys">
      {shared.secrets.providerKeys.map((k) => {
        const { label } = providerKeyInfo(k.id);
        const row = `provider-key-${k.id}`;
        const env = envHosts(k.id);
        const status = k.set
          ? `Set${k.last4 ? ` · ends ${k.last4}` : ''}`
          : env.length > 0
            ? `From the environment on ${env.map((h) => hostName(h)).join(', ')}`
            : 'Not set';
        return (
          <Row
            key={k.id}
            testID={row}
            title={label}
            subtitle={status}
            subtitleTestID={`${row}-status`}
            right={
              editing === k.id ? null : (
                <>
                  {!k.set && env[0] ? (
                    <SettingsButton
                      testID={`${row}-adopt`}
                      label="Use for all"
                      variant="quiet"
                      disabled={!reachable || busy}
                      onPress={() =>
                        void run(`${label} key`, () => api.adoptProviderKey(k.id, env[0]!.hostId))
                      }
                    />
                  ) : null}
                  <SettingsButton
                    testID={`${row}-edit`}
                    label={k.set ? 'Replace' : 'Add'}
                    variant={k.set || env.length > 0 ? 'quiet' : 'primary'}
                    accessibilityLabel={`${k.set ? 'Replace' : 'Add'} ${label} key`}
                    disabled={!reachable || busy}
                    onPress={() => {
                      setEditing(k.id);
                      setDraft('');
                    }}
                  />
                  {k.set ? (
                    <SettingsButton
                      testID={`${row}-revoke`}
                      label="Revoke"
                      variant="danger"
                      accessibilityLabel={`Revoke ${label} key`}
                      disabled={!reachable || busy}
                      onPress={() =>
                        Alert.alert(
                          `Revoke ${label} key?`,
                          'It is deleted from every host; a host with one in its own environment goes back to that.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Revoke',
                              style: 'destructive',
                              onPress: () =>
                                void run(`${label} key`, () => api.revokeProviderKey(k.id)),
                            },
                          ],
                        )
                      }
                    />
                  ) : null}
                </>
              )
            }
          >
            {editing === k.id ? (
              <View style={{ marginTop: space.sm }}>
                <Field
                  testID={`${row}-input`}
                  accessibilityLabel={`${label} key`}
                  placeholder="Paste key"
                  value={draft}
                  onChangeText={setDraft}
                  secureTextEntry
                  autoFocus
                />
                <ButtonRow>
                  <SettingsButton
                    testID={`${row}-save`}
                    label="Save"
                    disabled={!reachable || busy || draft.trim() === ''}
                    onPress={() =>
                      void run(`${label} key`, () => api.setProviderKey(k.id, draft.trim())).then(
                        (ok) => {
                          if (ok) {
                            setEditing(null);
                            setDraft('');
                          }
                        },
                      )
                    }
                  />
                  <SettingsButton
                    testID={`${row}-cancel`}
                    label="Cancel"
                    variant="quiet"
                    onPress={() => {
                      setEditing(null);
                      setDraft('');
                    }}
                  />
                </ButtonRow>
              </View>
            ) : null}
          </Row>
        );
      })}
    </SettingsSection>
  );
}

const ENDPOINT_API_LABEL: Record<ModelEndpointApi, string> = {
  openai: 'OpenAI-compatible · runs in Codex',
  anthropic: 'Anthropic-compatible · runs in Claude Code',
};

/**
 * Model endpoints (spec/02 § Provider adapters): local model servers and
 * routers, each run inside Codex (OpenAI-compatible) or Claude Code
 * (Anthropic-compatible). The list is a shared setting; a key is a write-only
 * shared secret.
 */
export function ModelEndpoints(): React.ReactElement {
  const reachable = usePresenceStore((s) => s.connection) === 'connected';
  const endpoints = useSettingsStore((s) => s.data?.preferences.modelEndpoints) ?? [];
  const keys = useSettingsStore((s) => s.data?.shared?.secrets.endpointKeys) ?? [];
  const loaded = useSettingsStore((s) => s.data !== null);
  const [adding, setAdding] = React.useState(false);
  const [label, setLabel] = React.useState('');
  const [endpointApi, setEndpointApi] = React.useState<ModelEndpointApi>('openai');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const save = async (): Promise<void> => {
    const endpoint: ModelEndpoint = {
      id: endpointIdFor(
        label,
        endpoints.map((e) => e.id),
      ),
      label: label.trim(),
      api: endpointApi,
      baseUrl: baseUrl.trim(),
    };
    setBusy(true);
    try {
      if (!(await patchShared('Model endpoint', { modelEndpoints: [...endpoints, endpoint] })))
        return;
      if (
        key.trim() &&
        !(await writeShared('Endpoint key', () => api.setEndpointKey(endpoint.id, key.trim())))
      )
        return;
      setAdding(false);
      setLabel('');
      setBaseUrl('');
      setKey('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Model endpoints" testID="model-endpoints">
      {endpoints.map((e) => {
        const k = keys.find((x) => x.id === e.id);
        return (
          <Row
            key={e.id}
            testID={`model-endpoint-${e.id}`}
            title={e.label}
            subtitle={`${ENDPOINT_API_LABEL[e.api]} · ${e.baseUrl} · ${
              k ? `Key set${k.last4 ? ` · ends ${k.last4}` : ''}` : 'No key'
            }`}
            right={
              <SettingsButton
                testID={`model-endpoint-${e.id}-remove`}
                label="Remove"
                variant="danger"
                disabled={!reachable || busy}
                onPress={() =>
                  Alert.alert(
                    `Remove ${e.label}?`,
                    'Chats on its models stay readable but cannot continue until it is added again with the same name.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () =>
                          void patchShared('Model endpoint', {
                            modelEndpoints: endpoints.filter((x) => x.id !== e.id),
                          }),
                      },
                    ],
                  )
                }
              />
            }
          />
        );
      })}
      {adding ? (
        <Row testID="model-endpoint-new" title="New endpoint">
          <View style={{ marginTop: space.sm, gap: space.sm }}>
            <Field
              testID="model-endpoint-new-label"
              accessibilityLabel="Name"
              placeholder="Name, e.g. Ollama"
              value={label}
              onChangeText={setLabel}
            />
            <ButtonRow>
              {(['openai', 'anthropic'] as const).map((a) => (
                <SettingsButton
                  key={a}
                  testID={`model-endpoint-new-api-${a}`}
                  label={a === 'openai' ? 'Codex' : 'Claude Code'}
                  variant={endpointApi === a ? 'primary' : 'quiet'}
                  onPress={() => setEndpointApi(a)}
                />
              ))}
            </ButtonRow>
            <Field
              testID="model-endpoint-new-url"
              accessibilityLabel="Base URL"
              placeholder={
                endpointApi === 'openai' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:4000'
              }
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Field
              testID="model-endpoint-new-key"
              accessibilityLabel="Key"
              placeholder="Key (optional)"
              value={key}
              onChangeText={setKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <ButtonRow>
              <SettingsButton label="Cancel" variant="quiet" onPress={() => setAdding(false)} />
              <SettingsButton
                testID="model-endpoint-new-save"
                label="Save"
                disabled={!reachable || busy || label.trim() === '' || baseUrl.trim() === ''}
                onPress={() => void save()}
              />
            </ButtonRow>
          </View>
        </Row>
      ) : (
        <Row
          testID="model-endpoint-add-row"
          title="Add an endpoint"
          right={
            <SettingsButton
              testID="model-endpoint-add"
              label="Add"
              disabled={!reachable || !loaded}
              onPress={() => setAdding(true)}
            />
          }
        />
      )}
    </SettingsSection>
  );
}
