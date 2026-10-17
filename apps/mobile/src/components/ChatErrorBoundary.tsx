// Error boundary around the chat screen. A render error in a chat used to take
// the whole app down with no text; this shows a short error instead and
// records the error + stack + chat id to the server (src/lib/crashReport.ts).

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { recordCrash, setCrashContext, describeError } from '../lib/crashReport';

interface Props {
  chatId: string;
  children: React.ReactNode;
  onBack: () => void;
}

interface State {
  error: Error | null;
}

export class ChatErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidMount(): void {
    setCrashContext({ chatId: this.props.chatId });
  }

  override componentWillUnmount(): void {
    setCrashContext({});
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    void recordCrash({
      source: 'boundary',
      ...describeError(error),
      chatId: this.props.chatId,
      ...(info.componentStack ? { componentStack: info.componentStack } : {}),
    });
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View testID="chat-error" style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Text testID="chat-error-message" selectable>
          {error.message}
        </Text>
        <Pressable testID="chat-error-retry" onPress={() => this.setState({ error: null })}>
          <Text>Retry</Text>
        </Pressable>
        <Pressable testID="chat-error-back" onPress={this.props.onBack}>
          <Text>Back</Text>
        </Pressable>
      </View>
    );
  }
}
