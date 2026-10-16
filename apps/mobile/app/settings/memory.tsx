// One Claude Code memory entry on one host (Settings → Memories → an entry).

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { MemoryDetail } from '../../src/components/settings/MemoriesSection';

export default function MemoryScreen(): React.ReactElement {
  const { hostId, project, file } = useLocalSearchParams<{
    hostId: string;
    project: string;
    file: string;
  }>();
  if (!hostId || !project || !file) {
    throw new Error('Memory opened without a hostId, project and file');
  }
  return <MemoryDetail hostId={hostId} project={project} file={file} />;
}
