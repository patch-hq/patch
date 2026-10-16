// One MCP server on one host, to add (no `name`) or edit (Settings → MCP).

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { McpServerEditor } from '../../src/components/settings/McpSection';

export default function McpServerScreen(): React.ReactElement {
  const { hostId, name } = useLocalSearchParams<{ hostId: string; name?: string }>();
  if (!hostId) throw new Error('MCP server opened without a hostId');
  return <McpServerEditor hostId={hostId} name={name ? name : null} />;
}
