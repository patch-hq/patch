// StrayProcessBar — processes this chat started outside Patch's tracked tools
// (spec/15 § Chat detail — Stray process bar; spec/02 § Stray processes).
// Mirrors packages/web/src/components/StrayProcessBar.tsx: each process with
// its command and how long it has run, and a Stop on the running ones. Absent
// when there is nothing, and absent on a host that cannot detect them (501);
// any other failure is shown.

import React, { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import type { StrayProcessRow } from '@patch/wire';
import { api } from '../api/rest';
import { formatElapsed } from '../lib/backgroundTasks';
import { space, radii, useTheme, textMin, fonts } from '../lib/theme';

const POLL_MS = 5_000;

export function StrayProcessBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const [rows, setRows] = useState<StrayProcessRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((res: { processes: StrayProcessRow[] }) => {
    setRows(res.processes);
    setError(null);
  }, []);
  const fail = useCallback((e: unknown) => {
    if ((e as { status?: number }).status === 501) {
      setUnsupported(true);
      return;
    }
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    setUnsupported(false);
    setRows([]);
    let alive = true;
    const load = (): void => {
      void (async () => {
        try {
          const res = await api.strayProcesses(chatId);
          if (alive) apply(res);
        } catch (e) {
          if (alive) fail(e);
        }
      })();
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [chatId, apply, fail]);

  async function stop(pid: number): Promise<void> {
    try {
      apply(await api.strayProcessStop(chatId, pid));
    } catch (e) {
      fail(e);
    }
  }

  if (unsupported) return null;
  const running = rows.filter((r) => r.running);
  const ended = rows.filter((r) => !r.running);
  if (error === null && rows.length === 0) return null;
  const shown = showEnded ? rows : running;

  return (
    <View
      testID="stray-process-bar"
      accessibilityRole="summary"
      style={{
        backgroundColor: colors.paperRaised,
        borderColor: colors.divider,
        borderWidth: 1,
        borderRadius: radii.sm,
        margin: space.sm,
        padding: space.sm,
        gap: space.xs,
      }}
    >
      <Text style={{ color: colors.ink2, fontFamily: fonts.bodyMedium, fontSize: textMin }}>
        {running.length > 0 ? `${running.length} other running` : 'Other processes'}
      </Text>
      {error !== null ? (
        <Text testID="stray-process-error" style={{ color: colors.red, fontSize: textMin }}>
          {`Can't list background processes: ${error}`}
        </Text>
      ) : null}
      {shown.map((r) => (
        <View
          key={`${r.pid}-${r.startedAt}`}
          testID="stray-process-row"
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
        >
          <Text
            testID="stray-process-command"
            numberOfLines={1}
            style={{
              flex: 1,
              color: r.running ? colors.ink2 : colors.ink3,
              fontSize: textMin,
              fontFamily: fonts.mono,
            }}
          >
            {r.command}
          </Text>
          <Text style={{ color: colors.ink3, fontSize: textMin }}>
            {r.running
              ? formatElapsed(r.startedAt, now)
              : `ended after ${formatElapsed(r.startedAt, r.endedAt ?? now)}`}
          </Text>
          {r.running ? (
            <Pressable
              testID="stray-process-stop"
              onPress={() => void stop(r.pid)}
              hitSlop={space.sm}
              accessibilityRole="button"
              accessibilityLabel={`Stop process ${r.pid}`}
            >
              <X size={16} color={colors.red} />
            </Pressable>
          ) : null}
        </View>
      ))}
      {ended.length > 0 ? (
        <Pressable
          testID="stray-process-show-ended"
          onPress={() => setShowEnded(!showEnded)}
          accessibilityRole="button"
        >
          <Text style={{ color: colors.ink3, fontSize: textMin }}>
            {showEnded ? 'hide ended' : `show ended (${ended.length})`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
