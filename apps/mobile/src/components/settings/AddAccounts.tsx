// The controls that add an account, one per provider (spec/10 § Backend
// credentials). Providers.tsx points at these; the Usage page never does.

import React from 'react';
import { View } from 'react-native';
import { api } from '../../api/rest';
import { space } from '../../lib/theme';
import { ChatGPTSignInFlow, ClaudeSignInFlow } from './SignInFlows';
import { TokenEntry } from './accountRows';
import { BedrockForm } from './bedrock';
import { writeShared } from './sharedWrite';
import { ButtonRow, SettingsButton } from './ui';

/**
 * Add a Claude account: a Claude subscription (sign in, or paste a token), or
 * a Claude on Amazon Bedrock account from a host's AWS profile.
 */
export function AddClaude(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [bedrock, setBedrock] = React.useState(false);
  return (
    <View style={{ gap: space.sm }}>
      <ClaudeSignInFlow />
      <ButtonRow>
        <SettingsButton
          testID="add-claude-account"
          label="Paste a token"
          variant="quiet"
          onPress={() => setOpen(true)}
        />
        <SettingsButton
          testID="add-bedrock-account"
          label="Amazon Bedrock"
          variant="quiet"
          onPress={() => setBedrock(true)}
        />
      </ButtonRow>
      {bedrock ? <BedrockForm onDone={() => setBedrock(false)} /> : null}
      {open ? (
        <TokenEntry
          testID="add-claude"
          placeholder="sk-ant-oat01-…"
          submitLabel="Add"
          withLabel
          onSubmit={(token, label) => {
            if (token === '') return;
            void writeShared('Add account', () =>
              api.addAccount('claude-code', { token, ...(label ? { label } : {}) }),
            ).then((ok) => {
              if (ok) setOpen(false);
            });
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Add a ChatGPT account: a device sign-in the server runs, or an API key added
 * straight to the server. No host is involved in either.
 */
export function AddChatGPT(): React.ReactElement {
  const [keyOpen, setKeyOpen] = React.useState(false);
  return (
    <View style={{ gap: space.sm }} testID="add-chatgpt">
      <ChatGPTSignInFlow />
      <ButtonRow>
        <SettingsButton
          testID="chatgpt-add-api-key"
          label="Add API key"
          variant="quiet"
          onPress={() => setKeyOpen(true)}
        />
      </ButtonRow>
      {keyOpen ? (
        <TokenEntry
          testID="chatgpt-api-key"
          placeholder="sk-…"
          submitLabel="Add"
          onSubmit={(apiKey) => {
            if (apiKey === '') return;
            void writeShared('Add API key', () => api.addAccount('codex', { apiKey })).then(
              (ok) => {
                if (ok) setKeyOpen(false);
              },
            );
          }}
        />
      ) : null}
    </View>
  );
}
