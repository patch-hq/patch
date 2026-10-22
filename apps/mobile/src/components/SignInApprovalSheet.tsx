// A new device is asking to sign in (spec/10 § Surface linking). Allow reveals
// the six-digit code to type on that device; Deny turns it away. Mounted at the
// root layout; renders only while a request is waiting or a code is showing.

import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { signInQuestion } from '@patch/wire';
import { api } from '../api/rest';
import { useSignInStore } from '../stores/signInStore';
import { usePresenceStore } from '../stores/presenceStore';
import { fixed, fonts, radii, space, useTheme } from '../lib/theme';

export function SignInApprovalSheet(): React.ReactElement | null {
  const colors = useTheme();
  const requests = useSignInStore((s) => s.requests);
  const surfaceId = usePresenceStore((s) => s.surfaceId);
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState<{ label: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-checks every 30s so a failed check clears itself once the server is back.
  useEffect(() => {
    if (surfaceId === null) return;
    let cancelled = false;
    const check = (): void => {
      api
        .signInPending()
        .then((r) => {
          if (cancelled) return;
          setCheckFailed(null);
          for (const req of r.requests) useSignInStore.getState().add(req);
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setCheckFailed(`Could not check for sign-in requests: ${(e as Error).message}`);
        });
    };
    check();
    const t = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [surfaceId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const current = requests.find((r) => r.expiresAt > now);

  const answer = async (id: string, allow: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (allow) {
        const r = await api.signInApprove(id);
        setShown({ label: r.label, code: r.code });
      } else {
        await api.signInDeny(id);
      }
      useSignInStore.getState().remove(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (shown === null && current === undefined && (error ?? checkFailed) === null) return null;

  const button = (label: string, onPress: () => void, primary: boolean): React.ReactElement => (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityLabel={label}
      style={{
        backgroundColor: primary ? colors.leaf : 'transparent',
        borderWidth: primary ? 0 : 1,
        borderColor: fixed.onShade2,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        marginLeft: space.sm,
      }}
    >
      <Text
        style={{ color: primary ? colors.onAccent : fixed.onShade, fontFamily: fonts.bodyMedium }}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View
      testID="signin-sheet"
      style={{
        position: 'absolute',
        top: 32,
        left: space.lg,
        right: space.lg,
        backgroundColor: colors.shade,
        borderRadius: radii.lg,
        padding: space.lg,
      }}
    >
      {shown !== null ? (
        <>
          <Text style={{ color: fixed.onShade2 }}>Type this code on {shown.label}</Text>
          <Text
            testID="signin-code"
            selectable
            style={{
              color: fixed.onShade,
              fontFamily: fonts.bodyBold,
              fontSize: 36,
              letterSpacing: 8,
              textAlign: 'center',
              marginVertical: space.md,
            }}
          >
            {shown.code}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            {button('Done', () => setShown(null), true)}
          </View>
        </>
      ) : current !== undefined ? (
        <>
          <Text style={{ color: fixed.onShade, fontFamily: fonts.bodyBold }}>
            {signInQuestion(current.label)}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.md }}>
            {button('Deny', () => void answer(current.id, false), false)}
            {button('Allow', () => void answer(current.id, true), true)}
          </View>
        </>
      ) : null}
      {(error ?? checkFailed) !== null ? (
        <>
          <Text testID="signin-error" style={{ color: fixed.onShade, marginTop: space.sm }}>
            {error ?? checkFailed}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.sm }}>
            {button(
              'Dismiss',
              () => {
                setError(null);
                setCheckFailed(null);
              },
              false,
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}
