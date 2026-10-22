// The controls that add an account, one per provider (spec/10 § Backend
// credentials). Providers.tsx points at these; the Usage page never does.

import React from 'react';
import { Linking, View } from 'react-native';
import { api } from '../../api/rest';
import { space } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { NoticeRow } from './HostSwitcher';
import { sendToHost } from './hostSend';
import { TokenEntry } from './accountRows';
import { writeShared } from './sharedWrite';
import { ButtonRow, ErrorLine, Muted, SettingsButton } from './ui';

/** Add a Claude account from a pasted token. */
export function AddClaude(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={{ gap: space.sm }}>
      <ButtonRow>
        <SettingsButton
          testID="add-claude-account"
          label="Add account"
          onPress={() => setOpen(true)}
        />
      </ButtonRow>
      {open ? (
        <TokenEntry
          testID="add-claude"
          placeholder="sk-ant-oat01-…"
          submitLabel="Add"
          withLabel
          onSubmit={(token, label) => {
            if (token === '') return;
            void writeShared('Add account', () =>
              api.addAccount('claude-code', { token, ...(label ? { label } : {}) }),
            ).then((ok) => {
              if (ok) setOpen(false);
            });
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Add a ChatGPT account: a device sign-in (run on whichever host is online —
 * its login goes to the server) or an API key added straight to the server.
 */
export function AddChatGPT(): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const online = Object.values(hosts).filter((h) => h.online);
  const [hostId, setHostId] = React.useState<string | null>(null);
  const [keyOpen, setKeyOpen] = React.useState(false);
  const host = online.find((h) => h.hostId === hostId) ?? online[0] ?? null;
  const login = host?.accounts['codex']?.login;
  const pending = login?.status === 'pending';
  const signIn = (authMethod: 'device' | 'cancel', requestId?: string): void => {
    if (!host) return;
    setHostId(host.hostId);
    sendToHost(
      host.hostId,
      {
        type: 'host.backend_add_account',
        hostId: host.hostId,
        backendId: 'codex',
        authMethod,
        requestId: requestId ?? `signin-${Date.now()}`,
      },
      'Sign in',
    );
  };
  return (
    <View style={{ gap: space.sm }} testID="add-chatgpt">
      <ButtonRow>
        <SettingsButton
          testID="chatgpt-signin"
          label="Sign in with ChatGPT"
          disabled={host === null || pending}
          onPress={() => signIn('device')}
        />
        <SettingsButton
          testID="chatgpt-add-api-key"
          label="Add API key"
          variant="quiet"
          onPress={() => setKeyOpen(true)}
        />
      </ButtonRow>
      {host === null ? (
        <NoticeRow testID="chatgpt-no-host" text="Nothing is online to sign in with" />
      ) : null}
      {keyOpen ? (
        <TokenEntry
          testID="chatgpt-api-key"
          placeholder="sk-…"
          submitLabel="Add"
          onSubmit={(apiKey) => {
            if (apiKey === '') return;
            void writeShared('Add API key', () => api.addAccount('codex', { apiKey })).then(
              (ok) => {
                if (ok) setKeyOpen(false);
              },
            );
          }}
        />
      ) : null}
      {pending && login && host ? (
        <View testID="chatgpt-login-pending" style={{ gap: space.xs }}>
          <Muted>Waiting for sign-in…</Muted>
          {login.code ? <Muted testID="chatgpt-login-code">{login.code}</Muted> : null}
          <ButtonRow>
            {login.url ? (
              <SettingsButton
                testID="chatgpt-login-open"
                label="Open sign-in"
                onPress={() => void Linking.openURL(login.url!)}
              />
            ) : null}
            <SettingsButton
              testID="chatgpt-login-cancel"
              label="Cancel sign-in"
              variant="quiet"
              onPress={() => signIn('cancel', login.requestId)}
            />
          </ButtonRow>
        </View>
      ) : null}
      {login?.status === 'failed' && login.error ? (
        <ErrorLine testID="chatgpt-login-error" message={login.error} />
      ) : null}
    </View>
  );
}
