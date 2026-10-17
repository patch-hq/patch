// Explains why a permission is needed before the OS dialog (permissionGate).

import React from 'react';
import { Modal, Pressable, Text } from 'react-native';
import { radii, space, typography, useTheme } from '../lib/theme';
import { SettingsButton, ButtonRow } from './settings/ui';
import { PERMISSION_EXPLAINERS, answerExplainer, usePermissionGate } from '../lib/permissionGate';

export function PermissionExplainerModal(): React.ReactElement {
  const colors = useTheme();
  const pending = usePermissionGate((s) => s.pending);
  if (!pending) return <Modal visible={false} transparent animationType="fade" />;
  const copy = PERMISSION_EXPLAINERS[pending.kind];
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => answerExplainer(false)}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: colors.shade,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onPress={() => answerExplainer(false)}
      >
        <Pressable
          testID="permission-explainer"
          onPress={() => {}}
          style={{
            backgroundColor: colors.paperRaised,
            borderRadius: radii.lg,
            padding: space.lg,
            width: '85%',
            maxWidth: 380,
          }}
        >
          <Text style={{ ...typography.title, color: colors.ink, marginBottom: space.sm }}>
            {copy.title}
          </Text>
          <Text style={{ ...typography.body, color: colors.ink, marginBottom: space.md }}>
            {copy.body}
          </Text>
          <ButtonRow>
            <SettingsButton
              label="Not now"
              testID="permission-explainer-decline"
              onPress={() => answerExplainer(false)}
            />
            <SettingsButton
              label="Continue"
              testID="permission-explainer-continue"
              onPress={() => answerExplainer(true)}
            />
          </ButtonRow>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
