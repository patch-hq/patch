// JobTickBar — the persistent bar for a chat that scheduled jobs re-prompt
// (spec/15 § Chat detail → Status bars). Mirrors the web JobTickBar
// (packages/web/src/components/JobTickBar.tsx): job name (truncating, so the
// cadence and countdown stay visible), cadence, a live countdown to the next
// fire and a thin progress line. Stacks with the WakeBar at the top.

import React, { type ReactElement } from 'react';
import { Text, View } from 'react-native';
import { CalendarClock } from 'lucide-react-native';
import {
  refreshJobTicks,
  soonestTick,
  tickCountdown,
  tickProgress,
  tickSchedule,
  useChatJobTicks,
} from '../../lib/jobTicks';
import { fonts, radii, space, textMin, useTheme } from '../../lib/theme';

/** A wall-clock `now` that ticks every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function JobTickBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const { jobs, error } = useChatJobTicks(chatId);
  const soonest = soonestTick(jobs);
  const fireAt = soonest?.nextFireAt ?? null;
  const now = useNow(jobs.length > 0);
  const due = fireAt !== null && now >= fireAt;
  // A moment after a fire, fetch the next time so a spent one is replaced.
  React.useEffect(() => {
    if (!due) return;
    const t = setTimeout(() => refreshJobTicks(chatId), 1500);
    return () => clearTimeout(t);
  }, [chatId, due, fireAt]);

  const box = {
    backgroundColor: colors.paperRaised,
    borderColor: colors.divider,
    borderWidth: 1,
    borderRadius: radii.sm,
    marginHorizontal: space.sm,
    marginTop: space.sm,
    overflow: 'hidden' as const,
  };
  if (error !== null) {
    return (
      <View testID="job-tick-bar-error" style={{ ...box, padding: space.sm }}>
        <Text style={{ color: colors.ink2, fontSize: textMin }}>
          Failed to load scheduled jobs: {error}
        </Text>
      </View>
    );
  }
  if (jobs.length === 0) return null;
  return (
    <>
      {jobs.map((job) => {
        const progress = tickProgress(job, now);
        return (
          <View key={job.jobId} testID="job-tick-bar" style={box}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.xs,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
              }}
            >
              <CalendarClock size={14} color={colors.ink2} />
              <Text
                testID="job-tick-name"
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  color: colors.ink2,
                  fontFamily: fonts.bodyMedium,
                  fontSize: textMin,
                }}
              >
                {job.name}
              </Text>
              <Text
                testID="job-tick-schedule"
                style={{ color: colors.ink3, fontSize: textMin, flexShrink: 0 }}
              >
                · {tickSchedule(job)}
              </Text>
              <Text
                testID="job-tick-countdown"
                style={{
                  color: colors.ink2,
                  fontSize: textMin,
                  flexShrink: 0,
                  marginLeft: 'auto',
                }}
              >
                {job.nextFireAt === null
                  ? 'no next run'
                  : `next ${tickCountdown(job.nextFireAt, now)}`}
              </Text>
            </View>
            {progress !== null ? (
              <View style={{ height: 2, backgroundColor: colors.lineSoft }}>
                <View
                  testID="job-tick-progress"
                  style={{ height: 2, width: `${progress * 100}%`, backgroundColor: colors.ink3 }}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

/** The header chip: `Job · next 2m 14s`, counting down to the soonest job. */
export function JobTickChip({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const { jobs } = useChatJobTicks(chatId);
  const soonest = soonestTick(jobs);
  const now = useNow(soonest !== null);
  if (soonest === null || soonest.nextFireAt === null) return null;
  return (
    <View
      testID="job-tick-chip"
      style={{
        backgroundColor: colors.lineSoft,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: radii.pill,
        marginLeft: space.sm,
        flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: textMin, fontFamily: fonts.bodyMedium, color: colors.ink2 }}>
        Job · next {tickCountdown(soonest.nextFireAt, now)}
      </Text>
    </View>
  );
}
