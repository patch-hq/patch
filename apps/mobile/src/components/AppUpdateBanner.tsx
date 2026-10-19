// "A new build needs installing" (spec/11 § Mobile updates). Only for a build no
// update check can deliver — one on another native runtime — and it installs in
// place: tap, it downloads, Android's installer opens.

import React from 'react';
import { Pressable, Text } from 'react-native';
import { installApk, useApkInstallStore } from '../lib/apkInstall';
import { usePublishedApkStore } from '../lib/publishedApk';
import { radii, space, typography, useTheme } from '../lib/theme';

export function AppUpdateBanner(): React.ReactElement | null {
  const colors = useTheme();
  const apk = usePublishedApkStore((s) => s.apk);
  const install = useApkInstallStore((s) => s.state);
  if (!apk?.needsInstall) return null;
  const busy = install.phase === 'downloading' || install.phase === 'installing';
  const text =
    install.phase === 'downloading'
      ? `Downloading Patch ${apk.version}${install.fraction !== null ? ` · ${Math.round(install.fraction * 100)}%` : ''}`
      : install.phase === 'installing'
        ? `Installing Patch ${apk.version}`
        : `Install Patch ${apk.version}`;
  return (
    <Pressable
      testID="app-update-banner"
      onPress={() => void installApk(apk.url, apk.version)}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={text}
      style={{
        backgroundColor: colors.accentTint,
        borderColor: colors.leaf,
        borderWidth: 1,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.md,
        margin: space.sm,
      }}
    >
      <Text style={{ color: colors.leafSoft, ...typography.meta }}>{text}</Text>
    </Pressable>
  );
}
