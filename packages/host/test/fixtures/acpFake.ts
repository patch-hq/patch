// The fake ACP agent (`fake-acp-agent.mjs`) as an agent entry, for tests.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcpAgentConfig } from '@patch/wire';

const here = dirname(fileURLToPath(import.meta.url));

export function fakeAgent(over: Partial<AcpAgentConfig> = {}): AcpAgentConfig {
  return {
    id: 'fake',
    label: 'Fake ACP',
    command: process.execPath,
    args: [resolve(here, 'fake-acp-agent.mjs')],
    keys: { FAKE_ACP_KEY: 'gemini' },
    modes: { default: 'default', acceptEdits: 'autoEdit', bypassPermissions: 'yolo' },
    ...over,
  };
}
