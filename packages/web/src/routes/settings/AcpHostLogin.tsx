// Settings → AI accounts → an ACP agent's own sign-in, per host (spec/10 §
// Signing in → an ACP agent; decision 25).
//
// For an agent that logs in rather than (or as well as) taking a key, each host
// that has it installed shows whether the agent is signed in there and offers
// to sign it in. The host runs the agent's sign-in; the login stays in the
// agent's own files on that host, so it is that host's only: never stored by
// Patch, never used by another host. An API key, where the agent takes one, is
// the way to sign it in everywhere at once.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AcpAgentConfig } from '@patch/wire';
import { api, type AcpLoginView } from '../../api/rest.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { problemText } from './sharedWrite.js';
import { Group } from './ui.js';

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const POLL_MS = 1500;

/** The hosts that have this agent installed and offer a sign-in for it. */
export function useLoginHosts(agentId: string): HostPresence[] {
  const hosts = usePresenceStore((s) => s.hosts);
  return sortHosts(Object.values(hosts)).filter((h) =>
    h.host?.backends.some((b) => b.id === `acp:${agentId}` && (b.loginMethods?.length ?? 0) > 0),
  );
}

export function AcpHostLogins({ agent }: { agent: AcpAgentConfig }): JSX.Element | null {
  const hosts = useLoginHosts(agent.id);
  if (hosts.length === 0) return null;
  return (
    <Group label={`${agent.label} · sign in on a host`} testid={`acp-login-${agent.id}`}>
      {hosts.map((h) => (
        <HostLoginRow key={h.hostId} agent={agent} host={h} />
      ))}
    </Group>
  );
}

function HostLoginRow({ agent, host }: { agent: AcpAgentConfig; host: HostPresence }): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const name = hostLabel(host);
  const methods = host.host?.backends.find((b) => b.id === `acp:${agent.id}`)?.loginMethods ?? [];
  const [methodId, setMethodId] = useState(methods[0]?.id ?? '');
  const [login, setLogin] = useState<AcpLoginView | null>(null);
  const [pasted, setPasted] = useState('');
  const loginAccount = host.accounts['acp']?.accounts?.find(
    (a) => a.id === `acp-login:${host.hostId}:${agent.id}`,
  );
  const signedIn = loginAccount?.connected === true;
  const id = `acp-login-${agent.id}-${host.hostId}`;
  const running = login !== null && !TERMINAL.has(login.status);

  // Follow a running sign-in until it ends.
  useEffect(() => {
    if (!login || TERMINAL.has(login.status)) return;
    const t = setTimeout(() => {
      api.acpLogin(agent.id, login.loginId).then(setLogin, (e: unknown) => {
        setLogin({ ...login, status: 'failed', message: problemText(e) });
      });
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [login, agent.id]);

  async function start(): Promise<void> {
    setPasted('');
    try {
      setLogin(await api.startAcpLogin(agent.id, host.hostId, methodId));
    } catch (e) {
      pushError(`${agent.label} sign-in on ${name}: ${problemText(e)}`);
    }
  }
  async function sendAddress(): Promise<void> {
    if (!login || pasted.trim() === '') return;
    try {
      setLogin(await api.acpLoginCallback(agent.id, login.loginId, pasted.trim()));
      setPasted('');
    } catch (e) {
      pushError(`${agent.label} sign-in on ${name}: ${problemText(e)}`);
    }
  }
  async function cancel(): Promise<void> {
    if (!login) return;
    try {
      setLogin(await api.cancelAcpLogin(agent.id, login.loginId));
    } catch (e) {
      pushError(`${agent.label} sign-in on ${name}: ${problemText(e)}`);
    }
  }

  const status = running
    ? login.status === 'starting'
      ? `Starting ${agent.label} on ${name}…`
      : `Waiting for you to sign in`
    : login?.status === 'failed'
      ? `Sign-in failed: ${login.message ?? 'no reason given'}`
      : login?.status === 'cancelled'
        ? 'Sign-in cancelled'
        : signedIn || login?.status === 'complete'
          ? `Signed in on ${name} only — the login stays on that host`
          : `Not signed in on ${name}`;

  return (
    <div className={`set-row${running ? ' stack' : ''}`} data-testid={id}>
      <div className="set-row-head">
        <div className="set-row-text">
          <span className="set-row-title">{name}</span>
          <span
            className={`set-sub${login?.status === 'failed' ? ' set-sub-error' : ''}`}
            data-testid={`${id}-status`}
          >
            {status}
          </span>
        </div>
        <div className="set-row-ctrl">
          {!running && methods.length > 1 ? (
            <select
              aria-label={`${agent.label} sign-in method on ${name}`}
              data-testid={`${id}-method`}
              value={methodId}
              onChange={(e) => setMethodId(e.target.value)}
            >
              {methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null}
          {running ? (
            <button
              type="button"
              className="set-btn ghost"
              data-testid={`${id}-cancel`}
              onClick={() => void cancel()}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className={`set-btn${signedIn ? '' : ' primary'}`}
              data-testid={`${id}-start`}
              disabled={!host.online || methodId === ''}
              title={host.online ? undefined : `${name} is offline`}
              onClick={() => void start()}
            >
              {signedIn ? 'Sign in again' : `Sign in on ${name}`}
            </button>
          )}
        </div>
      </div>
      {running && login.status === 'waiting' ? (
        <div className="set-field" data-testid={`${id}-handoff`}>
          {login.url ? (
            <a href={login.url} target="_blank" rel="noreferrer" data-testid={`${id}-url`}>
              Open the {agent.label} sign-in page
            </a>
          ) : null}
          {login.userCode ? (
            <span className="set-row-title mono" data-testid={`${id}-code`}>
              Code: {login.userCode}
            </span>
          ) : null}
          {login.message ? (
            <span className="set-sub" data-testid={`${id}-message`}>
              {login.message}
            </span>
          ) : null}
          {login.loopback ? (
            <form
              className="set-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void sendAddress();
              }}
            >
              <input
                className="set-grow"
                aria-label="The address your browser ended on"
                placeholder="Paste the address the browser ended on"
                data-testid={`${id}-paste`}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <button
                type="submit"
                className="set-btn primary"
                data-testid={`${id}-send`}
                disabled={pasted.trim() === ''}
              >
                Send
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
