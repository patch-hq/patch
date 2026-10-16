// JobBar — the chat-detail bar linking a job-created chat to its job (spec/15
// § Chat detail → Status bars). Mirrors the web JobBar
// (packages/web/src/components/JobBar.tsx). No bar on a chat no job created.

import React, { type ReactElement } from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Zap } from 'lucide-react-native';
import { api } from '../../api/rest';
import type { ChatRow } from '../../stores/types';
import { fonts, space, textMin, useTheme } from '../../lib/theme';

export function JobBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const jobId = row.jobId ?? null;
  const [label, setLabel] = React.useState('Loading job…');
  React.useEffect(() => {
    if (jobId === null) return;
    let live = true;
    setLabel('Loading job…');
    api
      .getJob(jobId)
      .then((job) => {
        if (live) setLabel(`Run by "${(job as { name: string }).name}" job`);
      })
      .catch((e: Error) => {
        if (live) setLabel(`Failed to load job: ${e.message}`);
      });
    return () => {
      live = false;
    };
  }, [jobId]);
  if (!row.jobId) return null;

  // One borderless line: the whole row opens the job (no separate button).
  return (
    <Pressable
      testID="job-bar"
      accessibilityRole="link"
      accessibilityLabel="Open job"
      onPress={() => router.push(`/settings/job-editor?id=${row.jobId}` as `/settings/job-editor`)}
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
      }}
    >
      <Zap size={14} color={colors.ink2} />
      <Text
        testID="job-bar-link"
        numberOfLines={1}
        style={{ color: colors.ink2, fontFamily: fonts.bodyMedium, fontSize: textMin, flex: 1 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
