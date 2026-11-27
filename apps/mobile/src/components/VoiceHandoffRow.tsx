// spec/15 § Chat detail — hand-off rows, following web (spec/14 § Main chat
// panel — Hand-off rows). One collapsed row per voice hand-off, where it was
// made: `Asked the agent` and its state, the request on the line below. A tap
// opens it to the request as sent and the chat's agent's answer, which is drawn
// here and nowhere else in the transcript.

import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ArrowRight, ArrowRightLeft, ChevronRight } from 'lucide-react-native';
import { ChatMarkdown } from './ChatMarkdown';
import { useNow } from './CallParts';
import { radii, space, textMin, useTheme } from '../lib/theme';
import { handoffStateLabel } from '../lib/voiceHandoff';
import type { VoiceHandoffView } from '../stores/chatStore';

function Direction({ from, to }: { from: string; to: string }): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <Text style={{ fontSize: textMin, fontWeight: '600', color: colors.ink2 }}>{from}</Text>
      <ArrowRight size={12} color={colors.ink3} />
      <Text style={{ fontSize: textMin, fontWeight: '600', color: colors.ink2 }}>{to}</Text>
    </View>
  );
}

export function VoiceHandoffRow({
  request,
  handoff,
}: {
  /** The request as the hand-off's own message holds it. */
  request: string;
  /** Where it stands; absent on a record from before hand-off state was kept. */
  handoff: VoiceHandoffView | undefined;
}): React.ReactElement {
  const colors = useTheme();
  const [open, setOpen] = React.useState(false);
  const now = useNow(handoff?.state === 'working');
  const state = handoffStateLabel(handoff, now);
  const text = handoff?.request ?? request;
  return (
    <View
      testID="voice-handoff"
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.sm,
        marginBottom: space.sm,
      }}
    >
      <View style={{ marginTop: 3, opacity: 0.8 }}>
        <ArrowRightLeft size={14} color={colors.ink3} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Pressable
          testID="voice-handoff-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={{ fontSize: textMin, fontWeight: '600', color: colors.ink2 }}>
              {handoff?.from ? `${handoff.from} asked the agent` : 'Asked the agent'}
            </Text>
            <View style={{ flex: 1 }} />
            {state !== null ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {handoff?.state === 'working' ? (
                  <ActivityIndicator size="small" color={colors.ink3} />
                ) : null}
                <Text
                  testID="voice-handoff-state"
                  style={{
                    fontSize: textMin,
                    color: handoff?.state === 'failed' ? colors.red : colors.ink3,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {state}
                </Text>
              </View>
            ) : null}
            <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
              <ChevronRight size={16} color={colors.ink3} />
            </View>
          </View>
          {open ? null : (
            <Text numberOfLines={1} style={{ fontSize: textMin, color: colors.ink3, marginTop: 1 }}>
              {text}
            </Text>
          )}
        </Pressable>
        {open ? (
          <View
            testID="voice-handoff-body"
            style={{
              marginTop: space.xs,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radii.md,
              backgroundColor: colors.bgSoft,
              gap: space.sm,
            }}
          >
            <View>
              <Direction from="Voice" to="Agent" />
              <Text style={{ fontSize: textMin, color: colors.ink, marginTop: 3 }}>{text}</Text>
            </View>
            {handoff?.state === 'answered' && handoff.answer !== undefined ? (
              <View testID="voice-handoff-answer">
                <Direction from="Agent" to="Voice" />
                <ChatMarkdown content={handoff.answer} color={colors.ink} />
              </View>
            ) : null}
            {handoff?.state === 'failed' ? (
              <View testID="voice-handoff-error">
                <Direction from="Agent" to="Voice" />
                <Text style={{ fontSize: textMin, color: colors.ink, marginTop: 3 }}>
                  Failed: {handoff.error ?? 'no reason given'}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
