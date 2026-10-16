// The Manager Chats tab's slim sweep-status line (spec/06 § Sweep — "Visible",
// spec/15 § Voice tab): "Last sweep 14:30 · nudged 2 · flagged 1", tapping
// expands what it did to which chat, and Check now fires one.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { api, type SweepRun } from '../api/rest';
import { useUiStore } from '../stores/uiStore';
import { hhmm, summarizeSweep } from '../lib/sweepSummary';
import { space, textMin, useTheme } from '../lib/theme';

export function SweepStatusLine(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const [last, setLast] = React.useState<SweepRun | null | undefined>(undefined);
  const [expanded, setExpanded] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  const load = React.useCallback((): void => {
    api.getSweepRuns(1).then(
      (res) => setLast(res.runs[0] ?? null),
      (e: Error) => useUiStore.getState().pushError(`sweep status failed: ${e.message}`),
    );
  }, []);
  React.useEffect(load, [load]);

  const checkNow = (): void => {
    setChecking(true);
    api
      .checkSweepNow()
      .then(load)
      .catch((e: Error) => useUiStore.getState().pushError(`check now failed: ${e.message}`))
      .finally(() => setChecking(false));
  };

  const summary =
    last === undefined
      ? 'Sweep —'
      : last === null
        ? 'No sweeps yet'
        : `Last sweep ${hhmm(last.at)} · ${summarizeSweep(last)}${last.error ? ' · failed' : ''}`;

  return (
    <View testID="sweep-status" style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          testID="sweep-status-summary"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          disabled={!last}
          onPress={() => setExpanded((v) => !v)}
          style={{ flex: 1 }}
        >
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: textMin }}>
            {summary}
          </Text>
        </Pressable>
        <Pressable
          testID="sweep-check-now"
          accessibilityRole="button"
          accessibilityLabel="Check now"
          disabled={checking}
          onPress={checkNow}
          hitSlop={space.sm}
        >
          <Text style={{ color: checking ? colors.ink3 : colors.leaf, fontSize: textMin }}>
            Check now
          </Text>
        </Pressable>
      </View>
      {expanded && last ? (
        <View testID="sweep-status-detail" style={{ paddingTop: space.xs, gap: space.xs }}>
          {last.error ? (
            <Text style={{ color: colors.red, fontSize: textMin }}>{last.error}</Text>
          ) : last.actions.length === 0 ? (
            <Text style={{ color: colors.ink3, fontSize: textMin }}>Nothing changed.</Text>
          ) : (
            last.actions.map((a) => (
              <Pressable
                key={a.chatId}
                testID={`sweep-status-row-${a.chatId}`}
                accessibilityRole="button"
                onPress={() => router.push(`/chats/${a.chatId}` as Href)}
              >
                <Text style={{ color: colors.ink2, fontSize: textMin }}>
                  {a.action} · {a.chatId}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
