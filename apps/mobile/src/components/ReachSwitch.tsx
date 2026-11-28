// The reach switch (spec/09 § Reaching the user), in the Manager's top bar
// beside its settings gear (spec/15 § Voice tab (Manager)) — the phone's
// counterpart of web's Notify / Auto-notify pill. Changed for a couple of
// hours at a time, before setting off, so it sits where it is one tap away.
// Account-wide: every surface shows the same value.

import React from 'react';
import { Alert, Pressable, Text } from 'react-native';
import { Bell, Volume2 } from 'lucide-react-native';
import { useSettingsStore } from '../stores/settingsStore';
import { radii, space, typography, useTheme } from '../lib/theme';
import { ensureVoiceReady } from '../lib/voiceReadiness';

export function ReachSwitch(): React.ReactElement {
  const colors = useTheme();
  const reach = useSettingsStore((s) => s.data?.preferences.reach);
  const [busy, setBusy] = React.useState(false);
  const auto = reach === 'auto-notify';
  // Nothing is drawn as on or off until the server has said which.
  const disabled = reach === undefined || busy;
  const label = auto ? 'Auto-notify' : 'Notify';
  const ink = auto ? colors.leaf : colors.ink2;
  return (
    <Pressable
      testID="reach-switch"
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: auto, disabled }}
      onPress={() => {
        // Spoken alerts are checked the moment they are asked for, not when the first one plays.
        if (!auto && !ensureVoiceReady({ feature: 'spoken-alert' })) return;
        setBusy(true);
        useSettingsStore
          .getState()
          .updatePreferences({ reach: auto ? 'notify' : 'auto-notify' })
          .catch((e: Error) => Alert.alert('Settings failed', e.message))
          .finally(() => setBusy(false));
      }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        marginHorizontal: space.xs,
        borderRadius: radii.pill,
        borderWidth: 1,
        borderColor: auto ? colors.leaf : colors.divider,
        backgroundColor: auto ? colors.accentTint : 'transparent',
        opacity: reach === undefined ? 0.4 : 1,
      }}
    >
      {auto ? <Volume2 size={14} color={ink} /> : <Bell size={14} color={ink} />}
      <Text style={[typography.meta, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}
