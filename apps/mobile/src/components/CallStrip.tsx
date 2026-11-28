// Call strip (spec/15 § Voice states — Voice call). While a call runs, one
// strip is pinned to the top of EVERY screen:
//
//   On call · 1:23 · ▏▎▍▌▍▎▏▎▍ (live waveform) · [mute] [pause] [end]
//   On call · 1:23 · Paused · [resume] [end]
//
// Tapping the strip returns to the call's chat. The chat's own message stream
// is the transcript, so the strip carries only what the stream cannot say: the
// state of the line (connecting / thinking / failure), words in flight and the
// hands-free hint on a second line when there is something to show. The
// Call/Hands-free switch is not here — it lives in the call button's menu.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MicOff, Pause, PhoneOff, Play } from 'lucide-react-native';
import { useVoiceStore } from '../stores/voiceStore';
import { useMicLevelStore } from '../stores/micLevelStore';
import {
  endVoiceCall,
  pauseVoiceCall,
  resumeVoiceCall,
  retryVoiceCall,
  setCallMuted,
} from '../lib/voiceCall';
import { callModeLabel, formatElapsed, handsFreeHint } from '../lib/callStatus';
import { fixed, fonts, radii, space, textMin, useTheme } from '../lib/theme';
import { ConnectingLabel, useNow } from './CallParts';
import { agentWorkingLabel } from '@patch/wire/direct-call';
import type { DirectCallStatus } from '@patch/wire/direct-call-runtime';

/** What a direct call's line is doing, when it is not just listening. */
export function directLine(status: DirectCallStatus, now: number): string {
  if (status.line === 'speaking') return 'Speaking';
  if (status.line === 'sending') return 'Thinking';
  if (status.line === 'working') return agentWorkingLabel(now - (status.workingSince ?? now));
  return 'Listening';
}

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
  const reconnectingSince = useVoiceStore((s) => s.callReconnectingSince);
  const addressWord = useVoiceStore((s) => s.callAddressWord);
  const paused = useVoiceStore((s) => s.callPaused) !== null;
  const direct = useVoiceStore((s) => s.callDirect);
  const now = useNow(session !== null && connectedAt !== null);

  if (!session) return null;

  const connecting = phase === 'connecting';
  const failed = error !== null;
  const reconnecting = reconnectingSince !== null && !failed;
  const hint = handsFreeHint(mode, addressWord);
  const head = failed ? (connecting ? 'Could not connect' : 'Call problem') : callModeLabel(mode);
  const headLabel =
    direct && !failed ? 'On call · direct' : mode === 'call' && !failed ? 'On call' : head;
  // A direct call's failed engine is named on the strip, and the call stays open.
  const directFailure = direct?.status.failure ?? null;
  const note =
    failed || connecting || paused
      ? null
      : directFailure !== null
        ? directFailure
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
        backgroundColor: failed ? colors.red : fixed.stripGround,
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
            style={{ color: fixed.stripAccent, fontFamily: fonts.bodyMedium, fontSize: 14 }}
          >
            {headLabel}
          </Text>
          {connectedAt !== null && !failed ? (
            <Text
              testID="call-timer"
              style={{ color: fixed.stripText, fontSize: 14, fontVariant: ['tabular-nums'] }}
            >
              {/* Held at the moment the line dropped until it is back. */}
              {formatElapsed((reconnectingSince ?? now) - connectedAt)}
            </Text>
          ) : null}
          {direct ? (
            <Text testID="call-direct-setup" style={{ color: fixed.stripText, fontSize: textMin }}>
              {direct.setup}
            </Text>
          ) : null}
          {paused ? (
            <Text testID="call-paused" style={{ color: fixed.stripText, fontSize: 14 }}>
              Paused
            </Text>
          ) : reconnecting ? (
            <ConnectingLabel color={fixed.stripText} word="Lost contact" />
          ) : connecting && !failed ? (
            <ConnectingLabel color={fixed.stripText} />
          ) : direct && direct.status.line !== 'listening' && direct.status.line !== 'hearing' ? (
            <Text testID="call-direct-status" style={{ color: fixed.stripText, fontSize: 14 }}>
              {directLine(direct.status, now)}
            </Text>
          ) : phase === 'thinking' && !failed ? (
            <Text testID="call-working" style={{ color: fixed.stripText, fontSize: 14 }}>
              Agent working
            </Text>
          ) : failed ? (
            <View style={{ flex: 1 }} />
          ) : (
            <Waveform active={!muted} color={fixed.stripAccent} />
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
              backgroundColor: fixed.stripOn,
            }}
          >
            <Text style={{ color: fixed.stripGround, fontFamily: fonts.bodyMedium, fontSize: 14 }}>
              Retry
            </Text>
          </Pressable>
        ) : paused ? (
          <Pressable
            testID="call-resume"
            onPress={() => {
              resumeVoiceCall();
            }}
            accessibilityRole="button"
            accessibilityLabel="Resume call"
            hitSlop={6}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: fixed.stripButton,
            }}
          >
            <Play size={16} color={fixed.stripOn} />
          </Pressable>
        ) : (
          <>
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
                backgroundColor: muted ? fixed.stripButtonMuted : fixed.stripButton,
              }}
            >
              <MicOff size={16} color={fixed.stripOn} />
            </Pressable>
            <Pressable
              testID="call-pause"
              onPress={() => {
                pauseVoiceCall();
              }}
              accessibilityRole="button"
              accessibilityLabel="Pause call"
              hitSlop={6}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: fixed.stripButton,
              }}
            >
              <Pause size={16} color={fixed.stripOn} />
            </Pressable>
          </>
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
            backgroundColor: failed ? fixed.stripButton : colors.red,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <PhoneOff size={16} color={fixed.stripOn} />
        </Pressable>
      </View>
      {failed ? (
        <Text testID="call-error" style={{ color: fixed.stripOn, fontSize: textMin }}>
          {error}
        </Text>
      ) : null}
      {note !== null ? (
        <Text
          testID={
            directFailure !== null
              ? 'call-direct-failure'
              : partial.length > 0
                ? 'call-partial'
                : unaddressed !== null
                  ? 'call-unaddressed'
                  : 'call-hint'
          }
          style={{
            color: directFailure !== null ? fixed.stripOn : fixed.stripText,
            fontSize: textMin,
          }}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
