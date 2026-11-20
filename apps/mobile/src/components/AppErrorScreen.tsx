// Root error screen: what the phone shows when the app tree throws while
// rendering. Without it a bundle that cannot start (for example an OTA bundle
// newer than the installed APK) leaves a white screen with no text. It names
// the error and the versions involved so the mismatch is readable, records the
// crash, and offers a restart.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { describeError, recordCrash } from '../lib/crashReport';
import { mobileBuildInfo } from '../lib/buildInfo';

export interface AppErrorScreenProps {
  error: Error;
  retry: () => void | Promise<void>;
}

export function AppErrorScreen({ error, retry }: AppErrorScreenProps): React.ReactElement {
  React.useEffect(() => {
    void recordCrash({ source: 'boundary', ...describeError(error) });
  }, [error]);
  const build = mobileBuildInfo();
  const details = [
    `Bundle ${build.version}${build.gitSha ? ` (${build.gitSha})` : ''}`,
    `Runtime ${Updates.runtimeVersion ?? 'unknown'}`,
    Updates.isEmbeddedLaunch
      ? 'Launched from the installed app'
      : 'Launched from a downloaded update',
  ];
  return (
    <View testID="app-error" style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: '600' }}>Patch could not start</Text>
      <Text testID="app-error-message" selectable>
        {error.message}
      </Text>
      <Text testID="app-error-versions" selectable style={{ opacity: 0.6 }}>
        {details.join('\n')}
      </Text>
      <Pressable testID="app-error-retry" onPress={() => void retry()}>
        <Text style={{ fontWeight: '600' }}>Try again</Text>
      </Pressable>
    </View>
  );
}
