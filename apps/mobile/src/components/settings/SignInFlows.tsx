// Signing in to a provider from the phone, with no terminal (spec/10 § Signing
// in). The server runs the sign-in and keeps its secrets; the phone opens the
// address, shows the code, and reports back.

import React from 'react';
import { Linking, View } from 'react-native';
import { api, type ChatGPTSignInStarted } from '../../api/rest';
import { space } from '../../lib/theme';
import { useSettingsStore } from '../../stores/settingsStore';
import { problemText } from './sharedWrite';
import { ButtonRow, ErrorLine, Field, Muted, SettingsButton } from './ui';

type Props = {
  /** Sign this row in again rather than adding an account. */
  accountId?: string;
  onDone?: () => void;
};

/** ChatGPT: show a code, the person approves on any device, the server collects the login. */
export function ChatGPTSignInFlow({ accountId, onDone }: Props): React.ReactElement {
  const [started, setStarted] = React.useState<ChatGPTSignInStarted | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const live = React.useRef(true);
  React.useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  React.useEffect(() => {
    if (!started) return;
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const res = await api.chatgptSignInStatus(started.signInId);
            if (!live.current) return;
            if (res.status === 'complete') {
              useSettingsStore.getState().applyShared(res.state);
              setStarted(null);
              onDone?.();
            } else if (res.status === 'failed') {
              setError(res.error);
              setStarted(null);
            } else {
              setTick((t) => t + 1);
            }
          } catch (e) {
            if (!live.current) return;
            setError(problemText(e));
            if ((e as { status?: number }).status === 410) setStarted(null);
            else setTick((t) => t + 1);
          }
        })();
      },
      Math.max(1, started.intervalSeconds) * 1000,
    );
    return () => clearTimeout(timer);
  }, [started, tick, onDone]);

  const start = async (): Promise<void> => {
    setError(null);
    setStarting(true);
    try {
      setStarted(await api.chatgptSignInStart(accountId ? { accountId } : {}));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={{ gap: space.sm }} testID="chatgpt-signin-flow">
      {started ? (
        <View testID="chatgpt-login-pending" style={{ gap: space.xs }}>
          <Muted>Open the sign-in page on any device, enter this code, and come back here.</Muted>
          <Muted testID="chatgpt-login-code">{started.userCode}</Muted>
          <ButtonRow>
            <SettingsButton
              testID="chatgpt-login-open"
              label="Open sign-in"
              onPress={() => void Linking.openURL(started.url)}
            />
            <SettingsButton
              testID="chatgpt-login-cancel"
              label="Cancel sign-in"
              variant="quiet"
              onPress={() => {
                void api.chatgptSignInCancel(started.signInId).catch(() => undefined);
                setStarted(null);
              }}
            />
          </ButtonRow>
        </View>
      ) : (
        <ButtonRow>
          <SettingsButton
            testID="chatgpt-signin"
            label="Sign in with ChatGPT"
            disabled={starting}
            onPress={() => void start()}
          />
        </ButtonRow>
      )}
      {error ? <ErrorLine testID="chatgpt-login-error" message={error} /> : null}
    </View>
  );
}

/** Claude: sign in on claude.ai in any browser and paste back the code it shows. */
export function ClaudeSignInFlow({ accountId, onDone }: Props): React.ReactElement {
  const [started, setStarted] = React.useState<{ signInId: string; url: string } | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const start = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const s = await api.claudeSignInStart();
      setCode('');
      setStarted(s);
      void Linking.openURL(s.url);
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (): Promise<void> => {
    if (!started) return;
    setError(null);
    setBusy(true);
    try {
      const state = await api.claudeSignInComplete({
        signInId: started.signInId,
        code: code.trim(),
        ...(accountId ? { accountId } : {}),
      });
      useSettingsStore.getState().applyShared(state);
      setStarted(null);
      onDone?.();
    } catch (e) {
      setError(problemText(e));
      // An expired sign-in cannot be finished; anything else can be tried again.
      if ((e as { status?: number }).status === 410) setStarted(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.sm }} testID="claude-signin-flow">
      {started ? (
        <View style={{ gap: space.xs }}>
          <Muted>Sign in at claude.ai, copy the code it shows, and paste it here.</Muted>
          <Field
            testID="claude-signin-code"
            accessibilityLabel="Claude sign-in code"
            value={code}
            onChangeText={setCode}
            placeholder="Code"
          />
          <ButtonRow>
            <SettingsButton
              testID="claude-signin-finish"
              label={busy ? 'Connecting…' : 'Connect'}
              disabled={busy || code.trim() === ''}
              onPress={() => void finish()}
            />
            <SettingsButton
              testID="claude-signin-reopen"
              label="Open claude.ai again"
              variant="quiet"
              onPress={() => void Linking.openURL(started.url)}
            />
            <SettingsButton
              testID="claude-signin-cancel"
              label="Cancel"
              variant="quiet"
              onPress={() => {
                setStarted(null);
                setError(null);
              }}
            />
          </ButtonRow>
        </View>
      ) : (
        <ButtonRow>
          <SettingsButton
            testID="claude-signin-start"
            label="Sign in with Claude"
            disabled={busy}
            onPress={() => void start()}
          />
        </ButtonRow>
      )}
      {error ? <ErrorLine testID="claude-signin-error" message={error} /> : null}
    </View>
  );
}
