// Settings → AI accounts → Claude: whether Claude Code is on each host, with a
// Reinstall. The host installs it by itself and retries when the network is
// down; this says where that stands and lets a person run it again.

import type { JSX } from 'react';
import { CLAUDE_BACKEND_ID } from '@patch/wire';
import { useClaudeCodeHosts } from '../../lib/claudeCodeStatus.js';
import { requestInstall } from '../../lib/useInstallPickedProviders.js';
import { Row } from './ui.js';
import { hostLabel } from './hostScope.js';

const STATUS: Record<string, string> = {
  present: 'Installed',
  'logged-out': 'Installed',
  installing: 'Installing…',
  absent: 'Not installed yet',
  failed: "Couldn't install",
};

export function ClaudeCodeInstall(): JSX.Element | null {
  const hosts = useClaudeCodeHosts();
  if (hosts.length === 0) return null;
  return (
    <>
      {hosts.map(({ host, state, error }) => {
        const busy = state === 'installing';
        const installed = state === 'present' || state === 'logged-out';
        return (
          <Row
            key={host.hostId}
            title={`Claude Code on ${hostLabel(host)}`}
            sub={state === 'failed' && error ? error : (STATUS[state] ?? state)}
            testid={`claude-code-install-${host.hostId}`}
          >
            <button
              type="button"
              className="set-btn"
              disabled={busy}
              data-testid={`claude-code-reinstall-${host.hostId}`}
              onClick={() => requestInstall(host, CLAUDE_BACKEND_ID, installed)}
            >
              {busy
                ? 'Installing…'
                : installed
                  ? 'Reinstall'
                  : state === 'failed'
                    ? 'Retry'
                    : 'Install'}
            </button>
          </Row>
        );
      })}
    </>
  );
}
