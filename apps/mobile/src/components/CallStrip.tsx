// Call strip (spec/15 § Voice states — Voice call). While a call runs, one
// strip is pinned to the top of EVERY screen:
//
//   On call · 1:23 · ▏▎▍▌▍▎▏▎▍ (live waveform) · [mute] [end]
//
// Tapping the strip returns to the call's chat. The chat's own message stream
// is the transcript, so the strip carries only what the stream cannot say: the
// state of the line (connecting / thinking / failure), words in flight and the
// hands-free hint on a second line when there is something to show. The
// Call/Hands-free switch is not here — it lives in the call button's menu.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MicOff, PhoneOff } from 'lucide-react-native';
import { useVoiceStore } from '../stores/voiceStore';
import { useMicLevelStore } from '../stores/micLevelStore';
import { endVoiceCall, retryVoiceCall, setCallMuted } from '../lib/voiceCall';
import { callModeLabel, formatElapsed, handsFreeHint } from '../lib/callStatus';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';
import { ConnectingLabel, useNow } from './CallParts';

const BARS = 40;
const TICK_MS = 80;

/** Heights 0..1 of a rolling window of the mic level; the newest enters on the right. */
export function Waveform({
  active,
  color,
}: {
  active: boolean;
  color: string;
}): React.ReactElement {
  const [bars, setBars] = React.useState<number[]>(() => new Array<number>(BARS).fill(0));
  React.useEffect(() => {
    const t = setInterval(() => {
      const level = active ? useMicLevelStore.getState().level : 0;
      setBars((prev) => [...prev.slice(1), level]);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [active]);
  return (
    <View
      testID="call-wave"
      accessibilityLabel="Listening"
      style={{
        flex: 1,
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      {bars.map((v, i) => (
        <View
          key={i}
          style={{
            width: 2,
            height: 2 + Math.min(1, Math.max(0, v)) * 20,
            borderRadius: 1,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

export function CallStrip(): React.ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const session = useVoiceStore((s) => s.activeSession);
  const muted = useVoiceStore((s) => s.callMuted);
  const partial = useVoiceStore((s) => s.callTranscriptPartial);
  const phase = useVoiceStore((s) => s.callPhase);
  const mode = useVoiceStore((s) => s.callMode);
  const unaddressed = useVoiceStore((s) => s.callUnaddressed);
  const error = useVoiceStore((s) => s.callError);
  const connectedAt = useVoiceStore((s) => s.callConnectedAt);
  const addressWord = useVoiceStore((s) => s.callAddressWord);
  const now = useNow(session !== null && connectedAt !== null);

  if (!session) return null;

  const connecting = phase === 'connecting';
  const failed = error !== null;
  const hint = handsFreeHint(mode, addressWord);
  const head = failed ? (connecting ? 'Could not connect' : 'Call problem') : callModeLabel(mode);
  const headLabel = mode === 'call' && !failed ? 'On call' : head;
  const note =
    failed || connecting
      ? null
      : partial.length > 0
        ? `You: ${partial}`
        : unaddressed !== null
          ? `Heard “${unaddressed}” — not addressed, so not sent`
          : hint;

  return (
    <View
      testID="call-strip"
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        gap: space.xs,
        backgroundColor: failed ? colors.red : '#1f1c17',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          testID="call-strip-open"
          onPress={() => router.navigate(`/chats/${session.chatId}`)}
          accessibilityRole="button"
          accessibilityLabel={`${headLabel} — return to the call`}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
        >
          <Text
            testID="call-phase"
            style={{ color: '#a9d391', fontFamily: fonts.bodyMedium, fontSize: 14 }}
          >
            {headLabel}
          </Text>
          {connectedAt !== null && !failed ? (
            <Text
              testID="call-timer"
              style={{ color: '#cfc8b8', fontSize: 14, fontVariant: ['tabular-nums'] }}
            >
              {formatElapsed(now - connectedAt)}
            </Text>
          ) : null}
          {connecting && !failed ? (
            <ConnectingLabel color="#cfc8b8" />
          ) : phase === 'thinking' && !failed ? (
            <Text testID="call-working" style={{ color: '#cfc8b8', fontSize: 14 }}>
              Agent working
            </Text>
          ) : failed ? (
            <View style={{ flex: 1 }} />
          ) : (
            <Waveform active={!muted} color="#a9d391" />
          )}
        </Pressable>
        {failed ? (
          <Pressable
            onPress={() => {
              void retryVoiceCall();
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry call"
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.xs + 2,
              borderRadius: radii.md,
              backgroundColor: '#f4f0e4',
            }}
          >
            <Text style={{ color: '#1f1c17', fontFamily: fonts.bodyMedium, fontSize: 14 }}>
              Retry
            </Text>
          </Pressable>
        ) : (
          <Pressable
            testID="call-mute"
            onPress={() => setCallMuted(!muted)}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute' : 'Mute'}
            accessibilityState={{ selected: muted }}
            hitSlop={6}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: muted ? '#555049' : '#2c2820',
            }}
          >
            <MicOff size={16} color="#f4f0e4" />
          </Pressable>
        )}
        <Pressable
          onPress={() => {
            void endVoiceCall();
          }}
          accessibilityRole="button"
          accessibilityLabel="End call"
          hitSlop={6}
          style={({ pressed }) => ({
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: failed ? '#2c2820' : colors.red,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <PhoneOff size={16} color="#f4f0e4" />
        </Pressable>
      </View>
      {failed ? (
        <Text testID="call-error" style={{ color: '#f4f0e4', fontSize: textMin }}>
          {error}
        </Text>
      ) : null}
      {note !== null ? (
        <Text
          testID={
            partial.length > 0
              ? 'call-partial'
              : unaddressed !== null
                ? 'call-unaddressed'
                : 'call-hint'
          }
          style={{ color: '#cfc8b8', fontSize: textMin }}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
